// Inbound envelope parsing. Strict: anything unexpected is an error, and the handler
// turns errors into a fail-closed REJECT.

export const PREFLIGHT_TYPE = "agent-games.preflight.v1";
export const GATEKEEPER_TYPE = "agent-games.proof-gatekeeper.v1";

export interface Preflight {
  type: typeof PREFLIGHT_TYPE;
  agent_id: string;
  issued_at: string;
  nonce: string;
}

export interface GatekeeperInput {
  registered_vk: string;
  proof_vk: string;
  minimum: bigint;
  public_balance: bigint;
  expiry_block: bigint;
  current_block: bigint;
  recipient: string;
  condition_recipient: string;
  amount: bigint;
  max_transfer: bigint;
  proof_tx: string;
}

export interface GatekeeperTask {
  type: typeof GATEKEEPER_TYPE;
  task_id: string;
  mode: string;
  issued_at: unknown;
  deadline_at: unknown;
  input: GatekeeperInput;
}

export type Parsed =
  | { kind: "preflight"; preflight: Preflight }
  | { kind: "task"; task: GatekeeperTask }
  /** A gatekeeper task we can identify (task_id) but whose input is unusable. */
  | { kind: "task-invalid"; taskId: string; mode: string; proofTx: string | undefined; error: string }
  | { kind: "unknown"; error: string };

export class EnvelopeError extends Error {}

const HEX = /^0x[0-9a-fA-F]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) throw new EnvelopeError(`${key} must be a non-empty string`);
  return v;
}

function hex(obj: Record<string, unknown>, key: string): string {
  const v = str(obj, key);
  if (!HEX.test(v)) throw new EnvelopeError(`${key} must be 0x-prefixed hex`);
  return v;
}

/** Non-negative integer given as a decimal string or a JSON safe integer. */
function uint(obj: Record<string, unknown>, key: string): bigint {
  const v = obj[key];
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new EnvelopeError(`${key} must be a non-negative integer`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  throw new EnvelopeError(`${key} must be a non-negative integer`);
}

function parseInput(raw: unknown): GatekeeperInput {
  if (!isRecord(raw)) throw new EnvelopeError("input must be an object");
  return {
    registered_vk: hex(raw, "registered_vk"),
    proof_vk: hex(raw, "proof_vk"),
    minimum: uint(raw, "minimum"),
    public_balance: uint(raw, "public_balance"),
    expiry_block: uint(raw, "expiry_block"),
    current_block: uint(raw, "current_block"),
    recipient: hex(raw, "recipient"),
    condition_recipient: hex(raw, "condition_recipient"),
    amount: uint(raw, "amount"),
    max_transfer: uint(raw, "max_transfer"),
    proof_tx: hex(raw, "proof_tx"),
  };
}

export function parseEnvelope(json: unknown): Parsed {
  if (!isRecord(json)) return { kind: "unknown", error: "body must be a JSON object" };

  if (json.type === PREFLIGHT_TYPE) {
    try {
      return {
        kind: "preflight",
        preflight: {
          type: PREFLIGHT_TYPE,
          agent_id: str(json, "agent_id"),
          issued_at: str(json, "issued_at"),
          nonce: str(json, "nonce"),
        },
      };
    } catch (e) {
      return { kind: "unknown", error: (e as Error).message };
    }
  }

  if (json.type !== GATEKEEPER_TYPE) return { kind: "unknown", error: "unsupported envelope type" };

  const taskId = typeof json.task_id === "string" && json.task_id.length > 0 ? json.task_id : undefined;
  if (!taskId) return { kind: "unknown", error: "task_id missing" };
  const mode = typeof json.mode === "string" ? json.mode : "unknown";
  const rawProofTx = isRecord(json.input) ? json.input.proof_tx : undefined;
  const proofTx = typeof rawProofTx === "string" ? rawProofTx : undefined;

  try {
    return {
      kind: "task",
      task: {
        type: GATEKEEPER_TYPE,
        task_id: taskId,
        mode,
        issued_at: json.issued_at,
        deadline_at: json.deadline_at,
        input: parseInput(json.input),
      },
    };
  } catch (e) {
    return { kind: "task-invalid", taskId, mode, proofTx, error: (e as Error).message };
  }
}

/** ISO-8601 string, or epoch seconds / milliseconds. Returns ms since epoch, or undefined. */
export function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v.trim() !== "") {
    if (/^\d+$/.test(v)) return parseTimestamp(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}
