// Steal the VFY turn orchestration:
//   idempotency → strict parse → expiry/nonce → commitment check → policy → prove → respond.
// Every failure inside the turn window answers HOLD without a proof (fail closed): the platform
// substitutes HOLD for missing/invalid responses anyway, and this never sends an action we
// can't prove.

import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { parseTimestamp } from "../envelope.js";
import type { KurierClient } from "../kurier.js";
import type { Logger } from "../log.js";
import type { GeneratedProof } from "../prover.js";
import type { CachedResponse, Store } from "../store.js";
import { toStvCircuitInput, type StvCircuitInput } from "./circuit.js";
import { echoFields, parseTurnEnvelope, type TurnEnvelope } from "./envelope.js";
import { computeCommitment, parseSalt } from "./commitment.js";
import { CIRCUIT_VERSION, publicInputsHash } from "./publicInputsHash.js";
import { parseStrategyParams, policy, type Action, type StrategyParams } from "./strategy.js";

export type LoadedStrategy =
  | { ok: true; params: StrategyParams; salt: bigint; commitment: bigint }
  | { ok: false; error: string };

export interface StvDeps {
  config: Pick<Config, "maxClockSkewMs" | "stv" | "kurier">;
  prover: { prove(input: StvCircuitInput): Promise<GeneratedProof> } | undefined;
  strategy: LoadedStrategy;
  store: Store;
  kurier: KurierClient | undefined;
  log: Logger;
  now: () => number;
}

interface TurnResponse {
  matchId: string;
  turn: number;
  action: Action;
  policyProof: {
    circuitVersion: string;
    publicInputsHash?: string;
    proof?: GeneratedProof["proof"];
    public_signals?: string[];
  };
  proof?: GeneratedProof["proof"];
  public_signals?: string[];
  agentTimestamp: string;
  idempotencyKey: string;
}

const json = (status: number, body: unknown): CachedResponse => ({ status, body: JSON.stringify(body) });

/** Stable per (matchId, turn): a retry of the same turn reuses it, a new turn never does. */
export function idempotencyKey(matchId: string, turn: number): string {
  const h = createHash("sha256").update(`steal-the-vfy:${matchId}:${turn}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("no time budget left"));
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]);
}

export class StvHandler {
  private readonly inflight = new Map<string, Promise<CachedResponse>>();

  constructor(private readonly deps: StvDeps) {}

  async handle(body: Record<string, unknown>, receivedAt: number): Promise<CachedResponse> {
    const echo = echoFields(body);
    if (!echo) return json(400, { error: "matchId and turn are required" });

    // Retries of the same turn get the identical response.
    const key = `stv:${echo.matchId}:${echo.turn}`;
    const cached = this.deps.store.getResponse(key);
    if (cached) return cached;
    const running = this.inflight.get(key);
    if (running) return running;

    const p = this.turn(body, echo, receivedAt)
      .catch((e: unknown) => {
        this.deps.log("error", "stv: unexpected error; holding", { matchId: echo.matchId, turn: echo.turn, error: String(e) });
        return this.hold(echo, undefined, "unexpected error");
      })
      .then((res) => {
        // Refusals (expired / reused nonce) are not cached: they carry no turn decision.
        if (res.status === 200) this.deps.store.putResponse(key, res);
        return res;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async turn(body: Record<string, unknown>, echo: { matchId: string; turn: number }, receivedAt: number): Promise<CachedResponse> {
    const { config, store, log, strategy } = this.deps;

    let env: TurnEnvelope;
    try {
      env = parseTurnEnvelope(body);
    } catch (e) {
      return this.hold(echo, undefined, `bad envelope: ${(e as Error).message}`);
    }

    // Expired turns and replayed nonces are refused before any work.
    const issuedAt = parseTimestamp(env.issuedAt);
    const deadlineAt = parseTimestamp(env.deadlineAt) ?? receivedAt + config.stv.defaultTurnWindowMs;
    if (issuedAt === undefined || Math.abs(receivedAt - issuedAt) > config.maxClockSkewMs + config.stv.defaultTurnWindowMs) {
      log("warn", "stv: stale or missing issuedAt", { matchId: env.matchId, turn: env.turn });
      return json(400, { error: "stale or missing issuedAt" });
    }
    if (receivedAt > deadlineAt) {
      log("warn", "stv: turn already expired", { matchId: env.matchId, turn: env.turn });
      return json(400, { error: "turn deadline has passed" });
    }
    if (store.hasSeen("stv-nonce", env.nonce)) {
      log("warn", "stv: nonce reused for a different turn", { matchId: env.matchId, turn: env.turn });
      return json(400, { error: "nonce already used" });
    }
    store.markSeen("stv-nonce", env.nonce, `${env.matchId}:${env.turn}`);

    if (!strategy.ok) {
      log("error", `stv: strategy not configured (${strategy.error}); holding without proof`, { matchId: env.matchId, turn: env.turn });
      return this.hold(echo, env, "strategy not configured");
    }
    // The platform freezes the registered commitment. If it isn't ours, no proof can match it.
    if (BigInt(env.strategyCommitment.hash) !== strategy.commitment) {
      log("error", "stv: registered commitment ≠ STRATEGY_PARAMS/STRATEGY_SALT in .env; holding without proof", { matchId: env.matchId, turn: env.turn });
      return this.hold(echo, env, "commitment mismatch");
    }
    if (!this.deps.prover) return this.hold(echo, env, "prover unavailable");

    const action = policy(strategy.params, env.state);
    const budgetMs = deadlineAt - config.stv.deadlineSafetyMs - this.deps.now();
    let proved: GeneratedProof;
    try {
      const input = toStvCircuitInput({
        params: strategy.params,
        salt: strategy.salt,
        commitment: strategy.commitment,
        matchId: env.matchId,
        turn: env.turn,
        selfBalance: env.state.selfBalance,
        opponentBalance: env.state.opponentBalance,
        action,
      });
      proved = await withTimeout(this.deps.prover.prove(input), budgetMs);
    } catch (e) {
      return this.hold(echo, env, `proof unavailable: ${(e as Error).message}`);
    }

    const res = this.build(env, action, proved);
    log("info", "stv: turn", { matchId: env.matchId, turn: env.turn, mode: env.mode, action: action.type, proof: true });
    store.evidence({
      type: "stv-turn",
      matchId: env.matchId,
      turn: env.turn,
      mode: env.mode,
      action,
      publicInputsHash: res.policyProof.publicInputsHash,
      proof: proved.proof,
      public_signals: proved.publicSignals,
    });
    this.submitToZkVerify(env, proved);
    return json(200, res);
  }

  private build(env: TurnEnvelope, action: Action, proved?: GeneratedProof): TurnResponse {
    const res: TurnResponse = {
      matchId: env.matchId,
      turn: env.turn,
      action, // HOLD / FORTIFY carry no `amount` key at all (the schema rejects it even when 0)
      policyProof: {
        circuitVersion: CIRCUIT_VERSION,
        publicInputsHash: publicInputsHash({
          commitment: BigInt(env.strategyCommitment.hash),
          matchId: env.matchId,
          turn: env.turn,
          selfBalance: env.state.selfBalance,
          opponentBalance: env.state.opponentBalance,
          action,
        }),
      },
      agentTimestamp: new Date(this.deps.now()).toISOString(),
      idempotencyKey: idempotencyKey(env.matchId, env.turn),
    };
    if (proved) {
      if (this.deps.config.stv.proofPlacement === "policyProof") {
        res.policyProof.proof = proved.proof;
        res.policyProof.public_signals = proved.publicSignals;
      } else {
        res.proof = proved.proof;
        res.public_signals = proved.publicSignals;
      }
    }
    return res;
  }

  /** Fail-closed HOLD, no proof. Echoes matchId/turn exactly; adds the hash when the envelope parsed. */
  private hold(echo: { matchId: string; turn: number }, env: TurnEnvelope | undefined, why: string): CachedResponse {
    const action: Action = { type: "HOLD" };
    const res: TurnResponse = env
      ? this.build(env, action)
      : {
          matchId: echo.matchId,
          turn: echo.turn,
          action,
          policyProof: { circuitVersion: CIRCUIT_VERSION },
          agentTimestamp: new Date(this.deps.now()).toISOString(),
          idempotencyKey: idempotencyKey(echo.matchId, echo.turn),
        };
    this.deps.log("warn", "stv: fail-closed HOLD", { matchId: echo.matchId, turn: echo.turn, why });
    this.deps.store.evidence({ type: "stv-turn", matchId: echo.matchId, turn: echo.turn, action, proof: false, why });
    return json(200, res);
  }

  private submitToZkVerify(env: TurnEnvelope, proved: GeneratedProof): void {
    const { kurier, config, store, log } = this.deps;
    if (!kurier || config.kurier.mode !== "background" || !config.kurier.vkHashStv) return;
    void (async () => {
      const ref = { type: "kurier-stv", matchId: env.matchId, turn: env.turn, network: config.kurier.network };
      try {
        const jobId = await kurier.submit(proved.proof, proved.publicSignals, config.kurier.vkHashStv);
        const final = await kurier.waitFinalized(jobId);
        store.evidence({ ...ref, jobId, status: final.status, txHash: final.txHash, blockHash: final.blockHash });
        log("info", "stv: zkVerify finalized", { matchId: env.matchId, turn: env.turn, jobId, txHash: final.txHash });
      } catch (e) {
        log("warn", "stv: zkVerify submission failed", { matchId: env.matchId, turn: env.turn, error: (e as Error).message });
        store.evidence({ ...ref, error: (e as Error).message });
      }
    })();
  }
}

/** Parses STRATEGY_PARAMS / STRATEGY_SALT and derives the commitment. Errors never contain values. */
export function loadStrategy(raw: { params: string | undefined; salt: string | undefined }): LoadedStrategy {
  try {
    const params = parseStrategyParams(raw.params);
    const salt = parseSalt(raw.salt);
    return { ok: true, params, salt, commitment: computeCommitment(params, salt) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
