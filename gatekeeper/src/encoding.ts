// Maps a task onto the gatekeeper circuit's inputs.
//
// Signal names and the public-signal order were found by testing gatekeeper.wasm and are
// not documented on the site. The platform may encode strings (task_id, 32-byte VK
// hashes) differently. All encoding choices live in this file so they can be changed in
// one place once practice mode confirms them.

import { createHash, randomBytes } from "node:crypto";
import type { Decision } from "./decision.js";
import { hexToBigInt } from "./decision.js";
import type { GatekeeperInput } from "./envelope.js";

/** BN254 scalar field modulus. */
export const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The circuit's comparators are 32-bit: operands ≥ 2^32 make the witness fail. */
export const CIRCUIT_UINT_MAX = 2n ** 32n - 1n;

/** publicSignals[i] layout produced by the circuit (index 0 is an output = H(taskId, salt)). */
export const PUBLIC_SIGNAL_ORDER = [
  "out",
  "registeredVkHash",
  "proofVkHash",
  "minimum",
  "publicBalance",
  "expiryBlock",
  "currentBlock",
  "recipient",
  "conditionRecipient",
  "amount",
  "maxTransfer",
  "decision",
  "taskId",
] as const;

export type CircuitInput = Record<
  "registeredVkHash" | "proofVkHash" | "minimum" | "publicBalance" | "expiryBlock" | "currentBlock" |
  "recipient" | "conditionRecipient" | "amount" | "maxTransfer" | "taskId" | "decision" | "salt",
  string
>;

export class UnprovableError extends Error {}

/** 0x-hex → field element (reduced mod p, which is what the witness calculator does anyway). */
export function hexToField(hex: string): bigint {
  return hexToBigInt(hex) % FIELD_P;
}

/**
 * task_id → field element. Decimal digits and 0x-hex are used directly. Any other
 * string (e.g. "gk_8d31_...") becomes sha256(utf8) mod p. This choice is UNCONFIRMED.
 */
export function taskIdToField(taskId: string): bigint {
  if (/^(0|[1-9][0-9]*)$/.test(taskId)) return BigInt(taskId) % FIELD_P;
  if (/^0x[0-9a-fA-F]+$/.test(taskId)) return BigInt(taskId) % FIELD_P;
  return BigInt("0x" + createHash("sha256").update(taskId, "utf8").digest("hex")) % FIELD_P;
}

/** Fresh random private salt (< p). Not secret strategy material, but never logged. */
export function randomSalt(): bigint {
  return BigInt("0x" + randomBytes(31).toString("hex"));
}

function u32(name: string, v: bigint): string {
  if (v < 0n || v > CIRCUIT_UINT_MAX) throw new UnprovableError(`${name} exceeds the circuit's 32-bit range`);
  return v.toString();
}

export function toCircuitInput(taskId: string, input: GatekeeperInput, decision: Decision, salt: bigint): CircuitInput {
  return {
    registeredVkHash: hexToField(input.registered_vk).toString(),
    proofVkHash: hexToField(input.proof_vk).toString(),
    minimum: u32("minimum", input.minimum),
    publicBalance: u32("public_balance", input.public_balance),
    expiryBlock: u32("expiry_block", input.expiry_block),
    currentBlock: u32("current_block", input.current_block),
    recipient: hexToField(input.recipient).toString(),
    conditionRecipient: hexToField(input.condition_recipient).toString(),
    amount: u32("amount", input.amount),
    maxTransfer: u32("max_transfer", input.max_transfer),
    taskId: taskIdToField(taskId).toString(),
    decision: decision === "APPROVE" ? "1" : "0",
    salt: salt.toString(),
  };
}

/** Public signals 1..12 must echo exactly the inputs we proved, in circuit order. */
export function publicSignalsMatch(publicSignals: readonly string[], ci: CircuitInput): boolean {
  if (publicSignals.length !== PUBLIC_SIGNAL_ORDER.length) return false;
  return PUBLIC_SIGNAL_ORDER.every((name, i) => name === "out" || publicSignals[i] === ci[name]);
}
