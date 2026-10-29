import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, reasonCode } from "../src/decision.js";
import { parseEnvelope, type GatekeeperInput } from "../src/envelope.js";
import { buildEnvelopes } from "../scripts/fixtures.js";

function inputOf(envelope: Record<string, unknown>): GatekeeperInput {
  const p = parseEnvelope(envelope);
  assert.equal(p.kind, "task");
  return (p as Extract<typeof p, { kind: "task" }>).task.input;
}

test("every fixture case evaluates to its expected decision and outcome", () => {
  for (const { c, envelope } of buildEnvelopes()) {
    const r = evaluate(inputOf(envelope), c.expect.outcome === "REPLAY");
    assert.equal(r.decision, c.expect.decision, c.name);
    assert.equal(r.outcome, c.expect.outcome, c.name);
    assert.equal(r.provable, c.expect.outcome !== "REPLAY", c.name);
  }
});

test("reuse is checked before anything else", () => {
  const bad = { ...inputOf(buildEnvelopes()[1]!.envelope) }; // vk-substitution
  assert.equal(evaluate(bad, true).outcome, "REPLAY");
});

test("recipient match is exact by value: case-insensitive, but no prefix matching", () => {
  const base = inputOf(buildEnvelopes()[0]!.envelope);
  assert.equal(evaluate({ ...base, recipient: base.condition_recipient.toUpperCase().replace("0X", "0x") }, false).decision, "APPROVE");
  assert.equal(evaluate({ ...base, recipient: base.condition_recipient.slice(0, 20) }, false).outcome, "RECIPIENT");
});

test("both reason-code sets cover every outcome", () => {
  for (const set of ["trap", "canonical"] as const) {
    for (const o of ["VALID", "REPLAY", "VK_MISMATCH", "THRESHOLD", "RECIPIENT", "EXPIRED", "AMOUNT", "BAD_INPUT", "FAIL_CLOSED"] as const) {
      assert.match(reasonCode(o, set), /^[A-Z_]+$/);
    }
  }
  assert.equal(reasonCode("VK_MISMATCH", "trap"), "VK_SUBSTITUTION");
});

test("envelope parsing rejects malformed inputs", () => {
  const env = buildEnvelopes()[0]!.envelope as { input: Record<string, unknown> };
  for (const patch of [{ minimum: "-1" }, { amount: "1.5" }, { amount: 1e300 }, { recipient: "De42" }, { proof_tx: "" }]) {
    const p = parseEnvelope({ ...env, input: { ...env.input, ...patch } });
    assert.equal(p.kind, "task-invalid", JSON.stringify(patch));
  }
  assert.equal(parseEnvelope({ type: "something-else" }).kind, "unknown");
});
