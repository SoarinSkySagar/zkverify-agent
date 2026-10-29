// Local test harness: replays signed sample envelopes against a running agent and checks
// the signatures, decisions, reason codes and proofs it returns.
//
//   npm run dev            # terminal 1
//   npm run replay         # terminal 2  (AGENT_URL defaults to http://localhost:$PORT$AGENT_PATH)

import * as snarkjs from "snarkjs";
import { loadConfig } from "../src/config.js";
import { reasonCode } from "../src/decision.js";
import { sign, SIGNATURE_HEADER, verify } from "../src/hmac.js";
import { buildEnvelopes } from "./fixtures.js";

const config = loadConfig();
const url = process.env.AGENT_URL ?? `http://localhost:${config.port}${config.agentPath}`;
const vk = await snarkjs.zKey.exportVerificationKey(config.zkeyPath);

async function post(body: string, signature = sign(body, config.hmacKey)) {
  const started = Date.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature }, body });
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - started, signed: verify(Buffer.from(text), res.headers.get(SIGNATURE_HEADER) ?? undefined, config.hmacKey) };
}

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

console.log(`Replaying against ${url}\n`);

// 1. Preflight
{
  const r = await post(JSON.stringify({ type: "agent-games.preflight.v1", agent_id: "agt_local", issued_at: new Date().toISOString(), nonce: "abc123" }));
  const body = JSON.parse(r.text) as Record<string, unknown>;
  check(r.status === 200 && r.signed && body.ok === true && body.protocolVersion === "v1", "preflight", `${r.status} signed=${r.signed}`);
}

// 2. Bad signature is refused
{
  const r = await post(JSON.stringify({ type: "agent-games.preflight.v1", agent_id: "x", issued_at: "x", nonce: "x" }), "0".repeat(64));
  check(r.status === 401, "bad signature rejected", `${r.status}`);
}

// 3. Every fixture case
const envelopes = buildEnvelopes();
let first: { body: string; text: string } | undefined;
for (const { c, envelope } of envelopes) {
  const body = JSON.stringify(envelope);
  const r = await post(body);
  const res = JSON.parse(r.text) as { decision?: string; reason_code?: string; proof?: snarkjs.Groth16Proof; public_signals?: string[] };
  const wantCode = reasonCode(c.expect.outcome, config.reasonCodes);
  let proofNote = "no proof";
  let proofOk = c.expect.outcome === "REPLAY" ? res.proof === undefined : false;
  if (res.proof && res.public_signals) {
    const valid = await snarkjs.groth16.verify(vk, res.public_signals, res.proof);
    const decisionSignal = res.public_signals[11] === (c.expect.decision === "APPROVE" ? "1" : "0");
    proofOk = valid && decisionSignal;
    proofNote = `proof ${valid ? "verifies" : "INVALID"}`;
  }
  check(
    r.status === 200 && r.signed && res.decision === c.expect.decision && res.reason_code === wantCode && proofOk,
    c.name,
    `${res.decision}/${res.reason_code} (want ${c.expect.decision}/${wantCode}), ${proofNote}, ${r.ms} ms`,
  );
  first ??= { body, text: r.text };
}

// 4. Retrying the same task_id returns the identical response
if (first) {
  const r = await post(first.body);
  check(r.text === first.text, "idempotent retry returns identical body");
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
