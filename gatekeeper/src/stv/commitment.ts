// Strategy commitment = Poseidon(strategyParams[0..7], salt): the circuit checks exactly this.
import { randomBytes } from "node:crypto";
import { poseidon9 } from "poseidon-lite";
import { FIELD_P } from "../encoding.js";
import { toCircuitParams, type StrategyParams } from "./strategy.js";

export class SaltError extends Error {}

/** STRATEGY_SALT: decimal or 0x-hex field element. Never echoed in errors. */
export function parseSalt(raw: string | undefined): bigint {
  const v = (raw ?? "").trim();
  if (!v) throw new SaltError("STRATEGY_SALT is not set (run `npm run stv:new-salt`)");
  let n: bigint;
  if (/^0x[0-9a-fA-F]+$/.test(v) || /^[0-9]+$/.test(v)) n = BigInt(v);
  else throw new SaltError("STRATEGY_SALT must be a decimal or 0x-hex integer");
  if (n <= 0n || n >= FIELD_P) throw new SaltError("STRATEGY_SALT must be in 1..p-1 (BN254 field)");
  if (n < 2n ** 128n) throw new SaltError("STRATEGY_SALT is too small to hide your strategy; generate one with `npm run stv:new-salt`");
  return n;
}

/** 31 random bytes, which is always < p and has ~248 bits of entropy. */
export function newSalt(): bigint {
  return BigInt("0x" + randomBytes(31).toString("hex"));
}

export function computeCommitment(p: StrategyParams, salt: bigint): bigint {
  return poseidon9([...toCircuitParams(p), salt]);
}

export const toHex32 = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
