// vfy-policy circuit inputs and public-signal layout (found by testing vfy-policy.wasm;
// not documented on the site).
//
// Inputs:  strategyParams[8], salt (private); commitment, matchId, turnNumber, selfBalance,
//          opponentBalance, action, amount, circuitVersion
// Public:  [binding(matchId, turnNumber), commitment, matchId, turnNumber, selfBalance,
//           opponentBalance, action, amount, circuitVersion]
import type { CircuitSpec } from "../prover.js";
import { FIELD_P } from "../encoding.js";
import { matchIdToBigInt } from "./envelope.js";
import { CIRCUIT_VERSION_NUMBER } from "./publicInputsHash.js";
import { ACTION_CODE, toCircuitParams, U16_MAX, type Action, type StrategyParams } from "./strategy.js";

export type StvCircuitInput = {
  strategyParams: string[];
  salt: string;
  commitment: string;
  selfBalance: string;
  opponentBalance: string;
  matchId: string;
  turnNumber: string;
  action: string;
  amount: string;
  circuitVersion: string;
};

export class StvUnprovableError extends Error {}

export function toStvCircuitInput(a: {
  params: StrategyParams;
  salt: bigint;
  commitment: bigint;
  matchId: string;
  turn: number;
  selfBalance: bigint;
  opponentBalance: bigint;
  action: Action;
}): StvCircuitInput {
  for (const [k, v] of [["selfBalance", a.selfBalance], ["opponentBalance", a.opponentBalance]] as const) {
    if (v > BigInt(U16_MAX)) throw new StvUnprovableError(`${k} exceeds the circuit's 16-bit range`);
  }
  const m = matchIdToBigInt(a.matchId);
  if (m >= FIELD_P) throw new StvUnprovableError("matchId does not fit in the field");
  return {
    strategyParams: toCircuitParams(a.params).map(String),
    salt: a.salt.toString(),
    commitment: a.commitment.toString(),
    selfBalance: a.selfBalance.toString(),
    opponentBalance: a.opponentBalance.toString(),
    matchId: m.toString(),
    turnNumber: String(a.turn),
    action: ACTION_CODE[a.action.type].toString(),
    amount: a.action.type === "EXTRACT" ? String(a.action.amount) : "0",
    circuitVersion: CIRCUIT_VERSION_NUMBER.toString(),
  };
}

const ORDER = ["commitment", "matchId", "turnNumber", "selfBalance", "opponentBalance", "action", "amount", "circuitVersion"] as const;

export const STV_CIRCUIT: CircuitSpec<StvCircuitInput> = {
  name: "vfy-policy",
  sha256: {
    wasm: "bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2",
    zkey: "f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41",
  },
  nPublic: 9,
  // ps[0] is the circuit's own (matchId, turn) binding output; 1..8 must echo our inputs.
  signalsMatch: (ps, input) => ps.length === 9 && ORDER.every((k, i) => ps[i + 1] === input[k]),
};
