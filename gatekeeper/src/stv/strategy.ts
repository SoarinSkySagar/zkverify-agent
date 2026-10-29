// =====================================================================================
//  TODO(you): YOUR STRATEGY — STRATEGY_PARAMS
//
//  This file deliberately contains NO strategy values. Choosing them is the competitive
//  decision, and it's yours. Put your values in .env (gitignored) only. Never commit them,
//  log them, or paste them into a chat or model prompt:
//
//    STRATEGY_PARAMS={"extractAmount":_,"fortifyIfSelfBelow":_,"holdIfOpponentAtOrBelow":_,"holdByDefault":_}
//    STRATEGY_SALT=<run `npm run stv:new-salt`; it writes a random salt into .env without printing it>
//
//  Then run `npm run stv:commitment` and register the printed hash on the dashboard
//  (My Agents → Edit agent → Steal the VFY) before Swiss Round 1. The commitment is frozen
//  once a match is paired. Changing a value afterwards means a new commitment, allowed only
//  between rounds.
//
//  What the vfy-policy circuit does with them (found by testing vfy-policy.wasm; not
//  documented on the site; checked against the real circuit by test/stv-policy.test.ts).
//  Evaluated top to bottom; the first rule that matches decides:
//
//    1. FORTIFY             if selfBalance <  fortifyIfSelfBelow
//    2. HOLD                if opponentBalance <= holdIfOpponentAtOrBelow
//    3. HOLD                if holdByDefault
//    4. EXTRACT extractAmount
//
//  Field                    circuit slot     allowed by the circuit
//  extractAmount            strategyParams[0]  integer 1..10
//  fortifyIfSelfBelow       strategyParams[1]  integer 0..65535   (0 = never fortify)
//  holdIfOpponentAtOrBelow  strategyParams[2]  integer 0..65535
//  holdByDefault            strategyParams[3]  boolean (0/1)
//  (reserved)               strategyParams[4..7] must be 0
//
//  The turn number and match id do not influence the circuit's choice. The policy only sees
//  the two balances, so whatever you commit plays the same way every turn.
// =====================================================================================

export interface StrategyParams {
  extractAmount: number;
  fortifyIfSelfBelow: number;
  holdIfOpponentAtOrBelow: number;
  holdByDefault: boolean;
}

export type ActionType = "HOLD" | "FORTIFY" | "EXTRACT";
export type Action = { type: "HOLD" } | { type: "FORTIFY" } | { type: "EXTRACT"; amount: number };

export const ACTION_CODE: Record<ActionType, bigint> = { HOLD: 0n, FORTIFY: 1n, EXTRACT: 2n };

/** Circuit comparators are 16-bit; balances and thresholds must stay below this. */
export const U16_MAX = 65535;

export class StrategyError extends Error {}

const FIELDS = ["extractAmount", "fortifyIfSelfBelow", "holdIfOpponentAtOrBelow", "holdByDefault"] as const;

function intIn(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new StrategyError(`STRATEGY_PARAMS.${name} must be an integer in ${min}..${max}`);
  }
  return v;
}

/** Parses and validates STRATEGY_PARAMS. Error messages never echo the values. */
export function parseStrategyParams(raw: string | undefined): StrategyParams {
  if (!raw || !raw.trim()) throw new StrategyError("STRATEGY_PARAMS is not set (see the TODO in src/stv/strategy.ts)");
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new StrategyError("STRATEGY_PARAMS is not valid JSON");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new StrategyError("STRATEGY_PARAMS must be a JSON object");
  const o = obj as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length) throw new StrategyError(`STRATEGY_PARAMS has unknown field(s): ${extra.join(", ")}`);
  const hold = o.holdByDefault;
  if (typeof hold !== "boolean" && hold !== 0 && hold !== 1) throw new StrategyError("STRATEGY_PARAMS.holdByDefault must be true/false");
  return {
    extractAmount: intIn("extractAmount", o.extractAmount, 1, 10),
    fortifyIfSelfBelow: intIn("fortifyIfSelfBelow", o.fortifyIfSelfBelow, 0, U16_MAX),
    holdIfOpponentAtOrBelow: intIn("holdIfOpponentAtOrBelow", o.holdIfOpponentAtOrBelow, 0, U16_MAX),
    holdByDefault: hold === true || hold === 1,
  };
}

/** The 8 circuit slots, in order. */
export function toCircuitParams(p: StrategyParams): bigint[] {
  return [BigInt(p.extractAmount), BigInt(p.fortifyIfSelfBelow), BigInt(p.holdIfOpponentAtOrBelow), p.holdByDefault ? 1n : 0n, 0n, 0n, 0n, 0n];
}

/**
 * Pure, deterministic policy: exactly what the vfy-policy circuit computes.
 * The circuit asserts that the submitted action equals this, so any other action is unprovable.
 */
export function policy(p: StrategyParams, state: { selfBalance: bigint; opponentBalance: bigint }): Action {
  if (state.selfBalance < BigInt(p.fortifyIfSelfBelow)) return { type: "FORTIFY" };
  if (state.opponentBalance <= BigInt(p.holdIfOpponentAtOrBelow)) return { type: "HOLD" };
  if (p.holdByDefault) return { type: "HOLD" };
  return { type: "EXTRACT", amount: p.extractAmount };
}
