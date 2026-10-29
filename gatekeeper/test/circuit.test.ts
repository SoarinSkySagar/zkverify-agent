// Checks the deterministic policy against the real gatekeeper circuit: every verdict the
// policy produces must be provable, and the opposite verdict must not be.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { evaluate } from "../src/decision.js";
import { PUBLIC_SIGNAL_ORDER, randomSalt, toCircuitInput, UnprovableError } from "../src/encoding.js";
import { parseEnvelope, type GatekeeperTask } from "../src/envelope.js";
import { Prover } from "../src/prover.js";
import { buildEnvelopes } from "../scripts/fixtures.js";

let prover: Prover;
before(async () => {
  prover = await Prover.load("circuits/gatekeeper.wasm", "circuits/gatekeeper_final.zkey");
});
after(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

const taskOf = (envelope: Record<string, unknown>): GatekeeperTask => {
  const p = parseEnvelope(envelope);
  assert.equal(p.kind, "task");
  return (p as Extract<typeof p, { kind: "task" }>).task;
};

test("policy verdicts are provable and the opposite verdict is not", async () => {
  for (const { c, envelope } of buildEnvelopes()) {
    if (c.expect.outcome === "REPLAY") continue; // reuse is not part of the circuit
    const task = taskOf(envelope);
    const { decision } = evaluate(task.input, false);

    const ci = toCircuitInput(task.task_id, task.input, decision, randomSalt());
    const { publicSignals } = await prover.prove(ci);
    assert.equal(publicSignals.length, PUBLIC_SIGNAL_ORDER.length);
    assert.equal(publicSignals[11], decision === "APPROVE" ? "1" : "0", c.name);

    const flipped = decision === "APPROVE" ? "REJECT" : "APPROVE";
    await assert.rejects(prover.prove(toCircuitInput(task.task_id, task.input, flipped, randomSalt())), c.name);
  }
});

test("values outside the circuit's 32-bit range are refused before proving", () => {
  const task = taskOf(buildEnvelopes()[0]!.envelope);
  assert.throws(() => toCircuitInput(task.task_id, { ...task.input, public_balance: 2n ** 32n }, "APPROVE", 1n), UnprovableError);
});
