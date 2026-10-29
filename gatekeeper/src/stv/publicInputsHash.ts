// policyProof.publicInputsHash, exactly as /build §06 specifies:
// keccak256 over eight fields, each a 32-byte big-endian word, in this order:
//   commitment, matchId, turn, selfBalance, opponentBalance, action (HOLD 0 / FORTIFY 1 / EXTRACT 2),
//   amount (0 for HOLD / FORTIFY), circuitVersion ("v1" → 1)
import { keccak_256 } from "@noble/hashes/sha3";
import { matchIdToBigInt } from "./envelope.js";
import { ACTION_CODE, type Action } from "./strategy.js";

export const CIRCUIT_VERSION = "v1";
export const CIRCUIT_VERSION_NUMBER = 1n;

function word(n: bigint): Uint8Array {
  if (n < 0n || n >= 2n ** 256n) throw new Error("value does not fit in 32 bytes");
  const hex = n.toString(16).padStart(64, "0");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export function publicInputsHash(f: {
  commitment: bigint;
  matchId: string;
  turn: number;
  selfBalance: bigint;
  opponentBalance: bigint;
  action: Action;
}): string {
  const amount = f.action.type === "EXTRACT" ? BigInt(f.action.amount) : 0n;
  const words = [
    f.commitment,
    matchIdToBigInt(f.matchId),
    BigInt(f.turn),
    f.selfBalance,
    f.opponentBalance,
    ACTION_CODE[f.action.type],
    amount,
    CIRCUIT_VERSION_NUMBER,
  ].map(word);
  const buf = new Uint8Array(32 * words.length);
  words.forEach((w, i) => buf.set(w, 32 * i));
  return "0x" + Buffer.from(keccak_256(buf)).toString("hex");
}
