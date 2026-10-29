// Steal the VFY turn envelope (/build §06). Strict parsing; errors become a fail-closed HOLD.

export const STV_EVENT_ID = "steal-the-vfy";

export interface TurnEnvelope {
  protocolVersion: "v1";
  eventId: typeof STV_EVENT_ID;
  mode: string;
  matchId: string;
  turn: number;
  issuedAt: unknown;
  deadlineAt: unknown;
  state: {
    selfBalance: bigint;
    opponentBalance: bigint;
    selfFortifiedUntilTurn: number | null;
    opponentFortifiedUntilTurn: number | null;
  };
  strategyCommitment: { hash: string };
  resolverVersion: string;
  nonce: string;
}

export class TurnEnvelopeError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) throw new TurnEnvelopeError(`${k} must be a non-empty string`);
  return v;
}

function uintStr(o: Record<string, unknown>, k: string): bigint {
  const v = o[k];
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  throw new TurnEnvelopeError(`state.${k} must be a non-negative integer`);
}

function optTurn(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  throw new TurnEnvelopeError(`state.${k} must be null or a non-negative integer`);
}

/** True when the body looks like a Steal the VFY turn (used for routing before strict parsing). */
export const isTurnEnvelope = (body: unknown): body is Record<string, unknown> =>
  isRecord(body) && body.eventId === STV_EVENT_ID;

/** The two fields needed to echo a response even when the rest of the envelope is unusable. */
export function echoFields(body: Record<string, unknown>): { matchId: string; turn: number } | undefined {
  const { matchId, turn } = body;
  if (typeof matchId === "string" && matchId && typeof turn === "number" && Number.isSafeInteger(turn) && turn >= 0) return { matchId, turn };
  return undefined;
}

export function parseTurnEnvelope(body: Record<string, unknown>): TurnEnvelope {
  if (body.protocolVersion !== "v1") throw new TurnEnvelopeError("unsupported protocolVersion");
  if (body.eventId !== STV_EVENT_ID) throw new TurnEnvelopeError("wrong eventId");
  const matchId = str(body, "matchId");
  // matchId is hashed as BigInt("0x" + matchId without dashes) (/build publicInputsHash), so it must be hex.
  if (!/^[0-9a-fA-F-]+$/.test(matchId) || matchId.replace(/-/g, "").length === 0 || matchId.replace(/-/g, "").length > 64) {
    throw new TurnEnvelopeError("matchId must be a UUID / hex string");
  }
  const turn = body.turn;
  if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 0) throw new TurnEnvelopeError("turn must be a non-negative integer");
  if (!isRecord(body.state)) throw new TurnEnvelopeError("state must be an object");
  if (!isRecord(body.strategyCommitment)) throw new TurnEnvelopeError("strategyCommitment must be an object");
  const hash = str(body.strategyCommitment, "hash");
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(hash)) throw new TurnEnvelopeError("strategyCommitment.hash must be 0x-hex (≤ 32 bytes)");
  return {
    protocolVersion: "v1",
    eventId: STV_EVENT_ID,
    mode: typeof body.mode === "string" ? body.mode : "unknown",
    matchId,
    turn,
    issuedAt: body.issuedAt,
    deadlineAt: body.deadlineAt,
    state: {
      selfBalance: uintStr(body.state, "selfBalance"),
      opponentBalance: uintStr(body.state, "opponentBalance"),
      selfFortifiedUntilTurn: optTurn(body.state, "selfFortifiedUntilTurn"),
      opponentFortifiedUntilTurn: optTurn(body.state, "opponentFortifiedUntilTurn"),
    },
    strategyCommitment: { hash },
    resolverVersion: typeof body.resolverVersion === "string" ? body.resolverVersion : "unknown",
    nonce: str(body, "nonce"),
  };
}

export const matchIdToBigInt = (matchId: string) => BigInt("0x" + matchId.replace(/-/g, ""));
