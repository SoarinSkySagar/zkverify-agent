// Pure, deterministic decision logic. No I/O, no clock, no model.
//
// This mirrors the GatekeeperEvaluation circuit (found by testing gatekeeper.wasm):
//   APPROVE  ⇔  registeredVkHash == proofVkHash
//            ∧  publicBalance ≥ minimum
//            ∧  currentBlock  < expiryBlock
//            ∧  recipient     == conditionRecipient
//            ∧  amount        ≤ maxTransfer
// The circuit asserts that its `decision` input equals this verdict, so a decision that
// disagrees with it cannot be proven. Proof reuse is NOT in the circuit. It is checked
// here against the seen-set, and PROOF_REUSED tasks are answered without a proof.

import type { ReasonCodeSet } from "./config.js";
import type { GatekeeperInput } from "./envelope.js";

export type Decision = "APPROVE" | "REJECT";

/** Internal outcome names; mapped to wire reason codes by `reasonCode()`. */
export type Outcome =
  | "VALID"
  | "REPLAY"
  | "VK_MISMATCH"
  | "THRESHOLD"
  | "RECIPIENT"
  | "EXPIRED"
  | "AMOUNT"
  /** Envelope unusable (schema/encoding). */
  | "BAD_INPUT"
  /** Timeout, stale timestamp, proof failure, or any other uncertainty. */
  | "FAIL_CLOSED";

export interface Evaluation {
  decision: Decision;
  outcome: Outcome;
  /** False when there is nothing the circuit can prove (proof reuse). */
  provable: boolean;
}

export function hexToBigInt(hex: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error("not 0x-hex");
  return BigInt(hex);
}

/** Lower-cased canonical form used as the seen-set key. */
export function normalizeRef(ref: string): string {
  return ref.trim().toLowerCase();
}

/**
 * Check order: reuse first (/rules: "Check the reference before any other validation"),
 * then VK (reject before verification), then the remaining circuit conditions.
 * Traps are single-fault, so the order only matters for the reported reason code.
 */
export function evaluate(input: GatekeeperInput, alreadySeen: boolean): Evaluation {
  if (alreadySeen) return { decision: "REJECT", outcome: "REPLAY", provable: false };

  const reject = (outcome: Outcome): Evaluation => ({ decision: "REJECT", outcome, provable: true });

  // Exact value match on registered_vk. proof_vk is only ever compared, never trusted.
  if (hexToBigInt(input.proof_vk) !== hexToBigInt(input.registered_vk)) return reject("VK_MISMATCH");
  if (input.public_balance < input.minimum) return reject("THRESHOLD");
  // Exact address match (case-insensitive hex, same as the circuit's numeric equality).
  if (hexToBigInt(input.recipient) !== hexToBigInt(input.condition_recipient)) return reject("RECIPIENT");
  if (input.current_block >= input.expiry_block) return reject("EXPIRED");
  if (input.amount > input.max_transfer) return reject("AMOUNT");

  return { decision: "APPROVE", outcome: "VALID", provable: true };
}

// Two reason-code vocabularies appear on the site (see CLAUDE.md §10). Kept side by side
// so switching sets is a config change (REASON_CODES), not a code change.
const REASON_CODES: Record<ReasonCodeSet, Record<Outcome, string>> = {
  // /events/proof-gatekeeper "Trap encyclopedia"
  trap: {
    VALID: "VALID_CONDITION",
    REPLAY: "PROOF_REUSED",
    VK_MISMATCH: "VK_SUBSTITUTION",
    THRESHOLD: "THRESHOLD_MISMATCH",
    RECIPIENT: "RECIPIENT_MISMATCH",
    EXPIRED: "EXPIRED_CONDITION",
    AMOUNT: "AMOUNT_OVERFLOW",
    BAD_INPUT: "PUBLIC_INPUT_MISMATCH",
    FAIL_CLOSED: "MISSING_VERIFICATION",
  },
  // /rules §6 "Canonical reason codes"
  canonical: {
    VALID: "VALID_PROOF",
    REPLAY: "PROOF_REPLAY",
    VK_MISMATCH: "VK_SUBSTITUTION",
    THRESHOLD: "THRESHOLD_MISMATCH",
    RECIPIENT: "PUBLIC_INPUT_MISMATCH",
    EXPIRED: "PUBLIC_INPUT_MISMATCH",
    AMOUNT: "PUBLIC_INPUT_MISMATCH",
    BAD_INPUT: "PUBLIC_INPUT_MISMATCH",
    FAIL_CLOSED: "MISSING_VERIFICATION",
  },
};

export function reasonCode(outcome: Outcome, set: ReasonCodeSet): string {
  return REASON_CODES[set][outcome];
}
