// Builds Steal the VFY turn envelopes in the /build §06 shape (shared by tests and replay-stv).
import { randomBytes, randomUUID } from "node:crypto";

export function buildTurn(o: {
  commitmentHex: string;
  matchId?: string;
  turn?: number;
  self?: number | string;
  opp?: number | string;
  nonce?: string;
  now?: number;
  windowMs?: number;
  mode?: string;
}): Record<string, unknown> {
  const now = o.now ?? Date.now();
  return {
    protocolVersion: "v1",
    eventId: "steal-the-vfy",
    mode: o.mode ?? "practice",
    matchId: o.matchId ?? randomUUID(),
    turn: o.turn ?? 1,
    issuedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + (o.windowMs ?? 30_000)).toISOString(),
    state: {
      selfBalance: String(o.self ?? 100),
      opponentBalance: String(o.opp ?? 100),
      selfFortifiedUntilTurn: null,
      opponentFortifiedUntilTurn: null,
    },
    strategyCommitment: { hash: o.commitmentHex },
    resolverVersion: "v1",
    nonce: o.nonce ?? randomBytes(8).toString("hex"),
  };
}
