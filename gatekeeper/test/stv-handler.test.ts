// End-to-end Steal the VFY over HTTP: real server, real vfy-policy prover, temporary data dir.
// The strategy below is a TEST FIXTURE ONLY (chosen to reach every branch), not a suggestion.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as snarkjs from "snarkjs";
import type { Config } from "../src/config.js";
import { Handler, type Deps } from "../src/handler.js";
import { sign, SIGNATURE_HEADER, verify } from "../src/hmac.js";
import { silentLogger } from "../src/log.js";
import { Prover } from "../src/prover.js";
import { createServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { STV_CIRCUIT, type StvCircuitInput } from "../src/stv/circuit.js";
import { computeCommitment, newSalt, toHex32 } from "../src/stv/commitment.js";
import { StvHandler, idempotencyKey, type LoadedStrategy } from "../src/stv/handler.js";
import { publicInputsHash } from "../src/stv/publicInputsHash.js";
import type { StrategyParams } from "../src/stv/strategy.js";
import { buildTurn } from "../scripts/stv-fixtures.js";

const keyA = Buffer.from("stv-test-key-A-not-a-real-secret-012345", "utf8");
const keyB = Buffer.from("stv-test-key-B-not-a-real-secret-678901", "utf8");
const fixture: StrategyParams = { extractAmount: 7, fortifyIfSelfBelow: 40, holdIfOpponentAtOrBelow: 20, holdByDefault: false };
const salt = newSalt();
const commitment = computeCommitment(fixture, salt);
const commitmentHex = toHex32(commitment);

const stvConfig = (placement: "top" | "policyProof"): Pick<Config, "maxClockSkewMs" | "stv" | "kurier"> => ({
  maxClockSkewMs: 120_000,
  kurier: { mode: "off", network: "testnet", baseUrl: "", apiKey: "", vkHash: "", vkHashStv: "" },
  stv: { wasmPath: "", zkeyPath: "", strategyParamsRaw: undefined, strategySaltRaw: undefined, defaultTurnWindowMs: 30_000, deadlineSafetyMs: 3_000, proofPlacement: placement },
});
const gkConfig: Deps["config"] = {
  hmacKeys: [keyA, keyB],
  maxClockSkewMs: 120_000,
  deadlineSafetyMs: 5_000,
  hardDeadlineMs: 60_000,
  reasonCodes: "trap",
  kurier: { mode: "off", network: "testnet", baseUrl: "", apiKey: "", vkHash: "", vkHashStv: "" },
};

let dataDir: string;
let store: Store;
let prover: Prover<StvCircuitInput>;
let vk: snarkjs.VerificationKey;
let url: string;
let close: () => Promise<void> = async () => {};

async function start(strategy: LoadedStrategy, placement: "top" | "policyProof" = "top") {
  await close();
  const stv = new StvHandler({ config: stvConfig(placement), prover, strategy, store, kurier: undefined, log: silentLogger, now: Date.now });
  const gkProver = { prove: () => Promise.reject(new Error("gatekeeper prover not used in these tests")) };
  const handler = new Handler({ config: gkConfig, prover: gkProver, store, kurier: undefined, log: silentLogger, now: Date.now, stv });
  const server = createServer(handler, "/agent", keyA);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
  close = () => new Promise((r) => server.close(() => r()));
}

before(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "stv-test-"));
  store = new Store(dataDir);
  prover = await Prover.load("circuits/vfy-policy.wasm", "circuits/vfy-policy_final.zkey", STV_CIRCUIT);
  vk = prover.vk;
  await start({ ok: true, params: fixture, salt, commitment });
});
after(async () => {
  await close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

async function post(envelope: unknown, key = keyA) {
  const raw = JSON.stringify(envelope);
  const res = await fetch(url, { method: "POST", headers: { [SIGNATURE_HEADER]: sign(raw, key) }, body: raw });
  const text = await res.text();
  const header = res.headers.get(SIGNATURE_HEADER) ?? undefined;
  return { status: res.status, text, json: JSON.parse(text) as Record<string, any>, signedWith: verify(Buffer.from(text), header, keyA) ? "A" : verify(Buffer.from(text), header, keyB) ? "B" : "none" };
}

test("each branch: correct action, amount only on EXTRACT, exact echo, valid hash and proof", async () => {
  const cases = [
    { self: 100, opp: 100, want: { type: "EXTRACT", amount: 7 } },
    { self: 39, opp: 100, want: { type: "FORTIFY" } },
    { self: 40, opp: 20, want: { type: "HOLD" } },
    { self: 40, opp: 21, want: { type: "EXTRACT", amount: 7 } },
  ] as const;
  for (const [i, c] of cases.entries()) {
    const env = buildTurn({ commitmentHex, self: c.self, opp: c.opp, turn: i + 1 });
    const r = await post(env);
    assert.equal(r.status, 200);
    assert.equal(r.signedWith, "A");
    assert.equal(r.json.matchId, env.matchId);
    assert.equal(r.json.turn, i + 1);
    assert.deepEqual(r.json.action, c.want, `case ${i}`);
    if (c.want.type !== "EXTRACT") assert.equal("amount" in r.json.action, false, "amount must be omitted for HOLD/FORTIFY");
    assert.equal(r.json.policyProof.circuitVersion, "v1");
    assert.equal(
      r.json.policyProof.publicInputsHash,
      publicInputsHash({ commitment, matchId: env.matchId as string, turn: i + 1, selfBalance: BigInt(c.self), opponentBalance: BigInt(c.opp), action: c.want }),
    );
    assert.equal(await snarkjs.groth16.verify(vk, r.json.public_signals, r.json.proof), true);
    assert.equal(r.json.public_signals[1], commitment.toString());
    assert.equal(r.json.idempotencyKey, idempotencyKey(env.matchId as string, i + 1));
    assert.match(r.json.agentTimestamp, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test("retry of the same turn returns identical bytes; idempotency keys differ across turns", async () => {
  const env = buildTurn({ commitmentHex, turn: 5 });
  const a = await post(env);
  const b = await post(env);
  assert.equal(a.text, b.text);
  assert.notEqual(idempotencyKey(env.matchId as string, 5), idempotencyKey(env.matchId as string, 6));
});

test("expired turn and reused nonce are refused with 400", async () => {
  assert.equal((await post(buildTurn({ commitmentHex, turn: 7, now: Date.now() - 120_000 }))).status, 400);
  const first = buildTurn({ commitmentHex, turn: 8 });
  assert.equal((await post(first)).status, 200);
  assert.equal((await post(buildTurn({ commitmentHex, turn: 9, nonce: first.nonce as string }))).status, 400);
});

test("fail closed: foreign commitment, bad state, missing strategy → HOLD without proof", async () => {
  const foreign = await post(buildTurn({ commitmentHex: "0x" + "11".repeat(32), turn: 10 }));
  assert.deepEqual(foreign.json.action, { type: "HOLD" });
  assert.equal("proof" in foreign.json, false);

  const bad = buildTurn({ commitmentHex, turn: 11 });
  (bad.state as Record<string, unknown>).selfBalance = "lots";
  const r = await post(bad);
  assert.equal(r.status, 200);
  assert.equal(r.json.matchId, bad.matchId);
  assert.deepEqual(r.json.action, { type: "HOLD" });

  await start({ ok: false, error: "STRATEGY_PARAMS is not set" });
  try {
    const m = await post(buildTurn({ commitmentHex, turn: 12 }));
    assert.deepEqual(m.json.action, { type: "HOLD" });
    assert.equal("proof" in m.json, false);
  } finally {
    await start({ ok: true, params: fixture, salt, commitment });
  }
});

test("a request signed with the second secret gets a response signed with it", async () => {
  const r = await post(buildTurn({ commitmentHex, turn: 13 }), keyB);
  assert.equal(r.status, 200);
  assert.equal(r.signedWith, "B");
});

test("STV_PROOF_PLACEMENT=policyProof nests proof and public_signals", async () => {
  await start({ ok: true, params: fixture, salt, commitment }, "policyProof");
  try {
    const r = await post(buildTurn({ commitmentHex, turn: 14 }));
    assert.equal("proof" in r.json, false);
    assert.equal(await snarkjs.groth16.verify(vk, r.json.policyProof.public_signals, r.json.policyProof.proof), true);
  } finally {
    await start({ ok: true, params: fixture, salt, commitment });
  }
});

test("gatekeeper preflight still answers on the same endpoint", async () => {
  const r = await post({ type: "agent-games.preflight.v1", agent_id: "agt", issued_at: new Date().toISOString(), nonce: "n" });
  assert.deepEqual(r.json, { ok: true, protocolVersion: "v1" });
});
