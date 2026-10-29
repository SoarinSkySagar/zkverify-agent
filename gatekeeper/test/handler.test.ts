// End-to-end over HTTP: real server, real prover, temporary data dir.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { reasonCode } from "../src/decision.js";
import { Handler, type Deps } from "../src/handler.js";
import { sign, SIGNATURE_HEADER, verify } from "../src/hmac.js";
import { silentLogger } from "../src/log.js";
import { Prover } from "../src/prover.js";
import { createServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { buildEnvelopes } from "../scripts/fixtures.js";

const hmacKey = Buffer.from("handler-test-key-not-a-real-secret-0123", "utf8");
const config: Deps["config"] = {
  hmacKeys: [hmacKey],
  maxClockSkewMs: 120_000,
  deadlineSafetyMs: 5_000,
  hardDeadlineMs: 60_000,
  reasonCodes: "trap",
  kurier: { mode: "off", network: "testnet", baseUrl: "", apiKey: "", vkHash: "", vkHashStv: "" },
};

let dataDir: string;
let store: Store;
let prover: Prover;
let url: string;
let close: () => Promise<void>;

function start(proverImpl: Deps["prover"]) {
  const handler = new Handler({ config, prover: proverImpl, store, kurier: undefined, log: silentLogger, now: Date.now });
  const server = createServer(handler, "/agent", hmacKey);
  return new Promise<void>((resolve) => {
    server.listen(0, () => {
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
      close = () => new Promise((r) => server.close(() => r()));
      resolve();
    });
  });
}

before(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "gk-test-"));
  store = new Store(dataDir);
  prover = await Prover.load("circuits/gatekeeper.wasm", "circuits/gatekeeper_final.zkey");
  await start(prover);
});
after(async () => {
  await close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

async function post(body: unknown, signature?: string) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(url, { method: "POST", headers: { [SIGNATURE_HEADER]: signature ?? sign(raw, hmacKey) }, body: raw });
  const text = await res.text();
  assert.equal(verify(Buffer.from(text), res.headers.get(SIGNATURE_HEADER) ?? undefined, hmacKey), true, "response must be signed");
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

test("preflight returns the signed handshake", async () => {
  const r = await post({ type: "agent-games.preflight.v1", agent_id: "agt_1", issued_at: new Date().toISOString(), nonce: "n" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, protocolVersion: "v1" });
});

test("bad signature → 401, nothing processed", async () => {
  const r = await post({ type: "agent-games.preflight.v1", agent_id: "a", issued_at: "x", nonce: "n" }, "f".repeat(64));
  assert.equal(r.status, 401);
});

test("all fixture cases: decision, reason code, proof presence; then idempotent retry", async () => {
  const envs = buildEnvelopes();
  for (const { c, envelope } of envs) {
    const r = await post(envelope);
    assert.equal(r.status, 200, c.name);
    assert.equal(r.json.decision, c.expect.decision, c.name);
    assert.equal(r.json.reason_code, reasonCode(c.expect.outcome, "trap"), c.name);
    assert.equal(r.json.proof_tx, (envelope.input as { proof_tx: string }).proof_tx, c.name);
    if (c.expect.outcome === "REPLAY") assert.equal("proof" in r.json, false, c.name);
    else assert.equal((r.json.public_signals as string[]).length, 13, c.name);
  }
  // Same task_id again → byte-identical cached response, and no PROOF_REUSED.
  const first = envs[0]!.envelope;
  const a = await post(first);
  const b = await post(first);
  assert.equal(a.text, b.text);
  assert.equal(a.json.decision, "APPROVE");
});

test("stale issued_at fails closed", async () => {
  const { envelope } = buildEnvelopes(Date.now() - 10 * 60_000)[0]!;
  const r = await post(envelope);
  assert.equal(r.json.decision, "REJECT");
  assert.equal(r.json.reason_code, reasonCode("FAIL_CLOSED", "trap"));
  assert.equal("proof" in r.json, false);
});

test("malformed input fails closed", async () => {
  const { envelope } = buildEnvelopes()[0]!;
  const r = await post({ ...envelope, input: { ...(envelope.input as object), amount: "lots" } });
  assert.equal(r.json.decision, "REJECT");
  assert.equal(r.json.reason_code, reasonCode("BAD_INPUT", "trap"));
});

test("prover timeout on an APPROVE fails closed to REJECT, without a proof", async () => {
  await close();
  await start({ prove: () => new Promise(() => {}) }); // never resolves
  try {
    const { envelope } = buildEnvelopes(Date.now() - 56_000)[0]!; // ~4 s of budget left after the 5 s safety margin
    const r = await post(envelope);
    assert.equal(r.json.decision, "REJECT");
    assert.equal(r.json.reason_code, reasonCode("FAIL_CLOSED", "trap"));
    assert.equal("proof" in r.json, false);
  } finally {
    await close();
    await start(prover);
  }
});

test("state survives a restart: an approved proof_tx stays seen", async () => {
  const envs = buildEnvelopes();
  const approved = envs[0]!.envelope;
  await post(approved);
  const reopened = new Store(dataDir);
  try {
    assert.equal(reopened.hasSeen("practice", (approved.input as { proof_tx: string }).proof_tx.toLowerCase()), true);
    assert.ok(reopened.getResponse(approved.task_id as string));
  } finally {
    reopened.close();
  }
});
