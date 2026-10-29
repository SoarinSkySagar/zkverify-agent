// Local test harness for Steal the VFY: sends signed turn envelopes to a running agent and
// checks the signature, echo fields, action (against your own policy), publicInputsHash and
// proof. Uses STRATEGY_PARAMS / STRATEGY_SALT from .env but never prints them or any balance
// that would reveal them. Output is branch names, PASS/FAIL and timings only.
//
//   npm run dev              # terminal 1
//   npm run replay:stv       # terminal 2  (AGENT_URL defaults to http://localhost:$PORT$AGENT_PATH)

import * as snarkjs from "snarkjs";
import { loadConfig } from "../src/config.js";
import { sign, SIGNATURE_HEADER, verify } from "../src/hmac.js";
import { toHex32 } from "../src/stv/commitment.js";
import { loadStrategy } from "../src/stv/handler.js";
import { publicInputsHash } from "../src/stv/publicInputsHash.js";
import { ACTION_CODE, policy, type Action, type StrategyParams } from "../src/stv/strategy.js";
import { buildTurn } from "./stv-fixtures.js";

const config = loadConfig();
const strategy = loadStrategy({ params: config.stv.strategyParamsRaw, salt: config.stv.strategySaltRaw });
if (!strategy.ok) {
  console.error(`Cannot run: ${strategy.error}`);
  process.exit(1);
}
const { params, commitment } = strategy;
const url = process.env.AGENT_URL ?? `http://localhost:${config.port}${config.agentPath}`;
const vk = await snarkjs.zKey.exportVerificationKey(config.stv.zkeyPath);
const commitmentHex = toHex32(commitment);

async function post(envelope: unknown) {
  const body = JSON.stringify(envelope);
  const started = Date.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(body, config.hmacKey) }, body });
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - started, signed: verify(Buffer.from(text), res.headers.get(SIGNATURE_HEADER) ?? undefined, config.hmacKey) };
}

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

/** One representative state per branch your strategy can actually reach. */
function branchStates(p: StrategyParams): { label: string; self: number; opp: number }[] {
  const grid = [0, 1, 2, 5, 10, 25, 50, 75, 99, 100, 101, 125, 150, 199, 200, p.fortifyIfSelfBelow - 1, p.fortifyIfSelfBelow, p.holdIfOpponentAtOrBelow, p.holdIfOpponentAtOrBelow + 1]
    .filter((v) => v >= 0 && v <= 65535);
  const seen = new Map<string, { label: string; self: number; opp: number }>();
  for (const self of grid) for (const opp of grid) {
    const a = policy(p, { selfBalance: BigInt(self), opponentBalance: BigInt(opp) });
    const branch =
      a.type === "FORTIFY" ? "fortify rule" : a.type === "EXTRACT" ? "extract" : BigInt(opp) <= BigInt(p.holdIfOpponentAtOrBelow) ? "hold (opponent rule)" : "hold (default)";
    if (!seen.has(branch)) seen.set(branch, { label: branch, self, opp });
  }
  return [...seen.values()];
}

type Resp = { matchId?: string; turn?: number; action?: Action & { amount?: number }; policyProof?: Record<string, unknown>; proof?: snarkjs.Groth16Proof; public_signals?: string[] };

async function checkTurn(label: string, self: number, opp: number, turn: number) {
  const env = buildTurn({ commitmentHex, self, opp, turn });
  const r = await post(env);
  const res = JSON.parse(r.text) as Resp;
  const want = policy(params, { selfBalance: BigInt(self), opponentBalance: BigInt(opp) });
  const proof = res.proof ?? (res.policyProof?.proof as snarkjs.Groth16Proof | undefined);
  const ps = res.public_signals ?? (res.policyProof?.public_signals as string[] | undefined);
  const amountOk = want.type === "EXTRACT" ? res.action?.amount === want.amount : !(res.action && "amount" in res.action);
  const hashOk = res.policyProof?.publicInputsHash === publicInputsHash({ commitment, matchId: env.matchId as string, turn, selfBalance: BigInt(self), opponentBalance: BigInt(opp), action: want });
  const proofOk = !!proof && !!ps && (await snarkjs.groth16.verify(vk, ps, proof)) && ps[6] === ACTION_CODE[want.type].toString() && ps[1] === commitment.toString();
  check(
    r.status === 200 && r.signed && res.matchId === env.matchId && res.turn === turn && res.action?.type === want.type && amountOk && hashOk && proofOk,
    `${label}`,
    `${res.action?.type ?? "?"} (want ${want.type}), hash ${hashOk ? "ok" : "BAD"}, proof ${proofOk ? "verifies" : "BAD"}, ${r.ms} ms`,
  );
  return { env, text: r.text };
}

console.log(`Replaying Steal the VFY turns against ${url}\n`);

const first = await checkTurn("turn 1 at the starting state", 100, 100, 1);
for (const [i, b] of branchStates(params).entries()) await checkTurn(b.label, b.self, b.opp, i + 2);

// Same turn delivered again → identical response bytes.
{
  const r = await post(first.env);
  check(r.text === first.text, "retry of the same turn returns identical body");
}
// A nonce already used on another turn is refused.
{
  const r = await post(buildTurn({ commitmentHex, turn: 9, nonce: first.env.nonce as string }));
  check(r.status === 400, "nonce reused on a different turn is refused", `${r.status}`);
}
// An already-expired turn is refused.
{
  const r = await post(buildTurn({ commitmentHex, turn: 10, now: Date.now() - 120_000 }));
  check(r.status === 400, "expired turn is refused", `${r.status}`);
}
// A commitment that isn't ours → fail-closed HOLD with no proof.
{
  const r = await post(buildTurn({ commitmentHex: "0x" + "11".repeat(32), turn: 11 }));
  const res = JSON.parse(r.text) as Resp;
  check(r.status === 200 && res.action?.type === "HOLD" && !res.proof && !res.policyProof?.proof, "foreign commitment → HOLD without proof");
}

console.log(`\nYour commitment: ${commitmentHex}`);
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
