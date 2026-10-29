// The TypeScript policy must agree with the vfy-policy circuit exactly. Random parameters
// here are TEST FIXTURES ONLY, not strategy suggestions.
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import * as snarkjs from "snarkjs";
import { Prover } from "../src/prover.js";
import { STV_CIRCUIT, toStvCircuitInput, StvUnprovableError, type StvCircuitInput } from "../src/stv/circuit.js";
import { computeCommitment, newSalt, parseSalt } from "../src/stv/commitment.js";
import { parseStrategyParams, policy, toCircuitParams, type Action, type StrategyParams } from "../src/stv/strategy.js";

const WASM = readFileSync("circuits/vfy-policy.wasm");
let prover: Prover<StvCircuitInput>;
before(async () => {
  prover = await Prover.load("circuits/vfy-policy.wasm", "circuits/vfy-policy_final.zkey", STV_CIRCUIT);
});
after(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

/** Does the circuit's witness generation accept this input? (no proof; fast) */
async function circuitAccepts(input: StvCircuitInput): Promise<boolean> {
  const e = console.error, l = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    await snarkjs.wtns.calculate(input, WASM, { type: "mem" });
    return true;
  } catch {
    return false;
  } finally {
    console.error = e;
    console.log = l;
  }
}

const randomParams = (): StrategyParams => ({
  extractAmount: randomInt(1, 11),
  fortifyIfSelfBelow: [0, randomInt(0, 250), randomInt(0, 65536)][randomInt(0, 3)]!,
  holdIfOpponentAtOrBelow: [0, randomInt(0, 250), randomInt(0, 65536)][randomInt(0, 3)]!,
  holdByDefault: randomInt(0, 2) === 1,
});

const ALL_ACTIONS = (amount: number): Action[] => [{ type: "HOLD" }, { type: "FORTIFY" }, { type: "EXTRACT", amount }, { type: "EXTRACT", amount: amount === 10 ? 1 : amount + 1 }];

function inputFor(p: StrategyParams, salt: bigint, self: number, opp: number, action: Action, turn = 1) {
  return toStvCircuitInput({
    params: p,
    salt,
    commitment: computeCommitment(p, salt),
    matchId: "9f4e1b2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    turn,
    selfBalance: BigInt(self),
    opponentBalance: BigInt(opp),
    action,
  });
}

test("policy() matches the circuit: its action is accepted, every other action is rejected", async () => {
  let cases = 0;
  for (let i = 0; i < 60; i++) {
    const p = randomParams();
    const salt = newSalt();
    // random states plus the exact boundaries of both thresholds
    const vals = [0, 1, 99, 100, 101, 200, randomInt(0, 300), randomInt(0, 65536),
      p.fortifyIfSelfBelow - 1, p.fortifyIfSelfBelow, p.holdIfOpponentAtOrBelow, p.holdIfOpponentAtOrBelow + 1].filter((v) => v >= 0 && v <= 65535);
    for (let j = 0; j < 6; j++) {
      const self = vals[randomInt(0, vals.length)]!;
      const opp = vals[randomInt(0, vals.length)]!;
      const want = policy(p, { selfBalance: BigInt(self), opponentBalance: BigInt(opp) });
      for (const a of ALL_ACTIONS(p.extractAmount)) {
        const same = a.type === want.type && (a.type !== "EXTRACT" || (want.type === "EXTRACT" && a.amount === want.amount));
        assert.equal(await circuitAccepts(inputFor(p, salt, self, opp, a, randomInt(0, 25))), same, `params/state case ${i}.${j}, action ${JSON.stringify(a)}`);
      }
      cases++;
    }
  }
  assert.ok(cases >= 300);
});

test("full proofs for a sample verify, with public signals in circuit order", async () => {
  for (let i = 0; i < 4; i++) {
    const p = randomParams();
    const ci = inputFor(p, newSalt(), randomInt(0, 201), randomInt(0, 201), { type: "HOLD" });
    const want = policy(p, { selfBalance: BigInt(ci.selfBalance), opponentBalance: BigInt(ci.opponentBalance) });
    const { publicSignals } = await prover.prove(inputFor(p, BigInt(ci.salt), +ci.selfBalance, +ci.opponentBalance, want));
    assert.equal(publicSignals.length, 9);
  }
});

test("commitment is Poseidon(params[0..7], salt) as the circuit checks it", async () => {
  const p = randomParams();
  const salt = newSalt();
  const want = policy(p, { selfBalance: 100n, opponentBalance: 100n });
  const good = inputFor(p, salt, 100, 100, want);
  assert.equal(await circuitAccepts(good), true);
  assert.equal(await circuitAccepts({ ...good, commitment: (BigInt(good.commitment) + 1n).toString() }), false);
  assert.equal(await circuitAccepts({ ...good, salt: (salt + 1n).toString() }), false);
});

test("reserved slots are zero and out-of-range values are refused", () => {
  assert.deepEqual(toCircuitParams({ extractAmount: 3, fortifyIfSelfBelow: 4, holdIfOpponentAtOrBelow: 5, holdByDefault: true }).slice(4), [0n, 0n, 0n, 0n]);
  const p = randomParams();
  assert.throws(() => inputFor(p, newSalt(), 65536, 100, { type: "HOLD" }), StvUnprovableError);
});

test("STRATEGY_PARAMS / STRATEGY_SALT validation never echoes values", () => {
  const ok = '{"extractAmount":4,"fortifyIfSelfBelow":7,"holdIfOpponentAtOrBelow":9,"holdByDefault":false}';
  assert.equal(parseStrategyParams(ok).extractAmount, 4);
  for (const bad of [undefined, "", "nope", "[]", '{"extractAmount":0,"fortifyIfSelfBelow":7,"holdIfOpponentAtOrBelow":9,"holdByDefault":false}',
    '{"extractAmount":11,"fortifyIfSelfBelow":7,"holdIfOpponentAtOrBelow":9,"holdByDefault":false}',
    '{"extractAmount":4,"fortifyIfSelfBelow":70000,"holdIfOpponentAtOrBelow":9,"holdByDefault":false}',
    '{"extractAmount":4,"fortifyIfSelfBelow":7,"holdIfOpponentAtOrBelow":9,"holdByDefault":false,"extra":1}']) {
    assert.throws(() => parseStrategyParams(bad), (e: Error) => !/"\s*:\s*\d/.test(e.message) && !e.message.includes("70000"));
  }
  assert.throws(() => parseSalt("123"), /too small/);
  assert.throws(() => parseSalt("0xZZ"));
  assert.equal(parseSalt(newSalt().toString()) > 0n, true);
});
