// Request orchestration: authenticate → parse → idempotency → validate timing →
// deterministic decision → prove → respond. Every failure path ends in REJECT (fail closed).

import type { Config } from "./config.js";
import type { Decision, Evaluation, Outcome } from "./decision.js";
import { evaluate, normalizeRef, reasonCode } from "./decision.js";
import type { CircuitInput } from "./encoding.js";
import { randomSalt, toCircuitInput } from "./encoding.js";
import type { GatekeeperTask } from "./envelope.js";
import { parseEnvelope, parseTimestamp } from "./envelope.js";
import { verify } from "./hmac.js";
import type { KurierClient } from "./kurier.js";
import type { Logger } from "./log.js";
import type { GeneratedProof } from "./prover.js";
import type { CachedResponse, Store } from "./store.js";

export interface Deps {
  config: Pick<Config, "hmacKey" | "maxClockSkewMs" | "deadlineSafetyMs" | "hardDeadlineMs" | "reasonCodes" | "kurier">;
  prover: { prove(input: CircuitInput): Promise<GeneratedProof> };
  store: Store;
  kurier: KurierClient | undefined;
  log: Logger;
  now: () => number;
}

export interface GatekeeperResponse {
  decision: Decision;
  reason_code: string;
  proof_tx?: string;
  proof?: GeneratedProof["proof"];
  public_signals?: string[];
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new TimeoutError("no time budget left"));
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new TimeoutError(`timed out after ${ms} ms`)), ms);
    }),
  ]);
}

const json = (status: number, body: unknown): CachedResponse => ({ status, body: JSON.stringify(body) });

export class Handler {
  private readonly inflightTasks = new Map<string, Promise<CachedResponse>>();
  /** Proof references being decided right now; a concurrent duplicate is treated as reuse. */
  private readonly inflightRefs = new Set<string>();

  constructor(private readonly deps: Deps) {}

  /** `rawBody` must be the exact bytes received; the signature is checked before parsing. */
  async handle(rawBody: Buffer, signatureHeader: string | string[] | undefined): Promise<CachedResponse> {
    const receivedAt = this.deps.now();
    if (!verify(rawBody, signatureHeader, this.deps.config.hmacKey)) {
      this.deps.log("warn", "rejected request: bad signature");
      return json(401, { error: "invalid signature" });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return json(400, { error: "invalid JSON" });
    }

    const parsed = parseEnvelope(body);
    switch (parsed.kind) {
      case "preflight":
        this.deps.log("info", "preflight", { agent_id: parsed.preflight.agent_id });
        return json(200, { ok: true, protocolVersion: "v1" });
      case "unknown":
        this.deps.log("warn", "unrecognised envelope", { error: parsed.error });
        return json(400, { error: parsed.error });
      case "task-invalid":
      case "task": {
        const taskId = parsed.kind === "task" ? parsed.task.task_id : parsed.taskId;
        // Task IDs are idempotency keys: the platform may retry the same task.
        const cached = this.deps.store.getResponse(taskId);
        if (cached) return cached;
        const running = this.inflightTasks.get(taskId);
        if (running) return running;

        const work =
          parsed.kind === "task"
            ? this.decide(parsed.task, receivedAt)
            : Promise.resolve(this.rejectWithoutProof(taskId, parsed.mode, "BAD_INPUT", parsed.proofTx, parsed.error));
        const p = work
          .catch((e: unknown) => {
            // Unreachable by design. Kept as the final fail-closed net.
            this.deps.log("error", "unexpected error; failing closed", { task_id: taskId, error: String(e) });
            return this.rejectWithoutProof(taskId, "unknown", "FAIL_CLOSED", undefined, "unexpected error");
          })
          .then((res) => {
            this.deps.store.putResponse(taskId, res);
            return res;
          })
          .finally(() => this.inflightTasks.delete(taskId));
        this.inflightTasks.set(taskId, p);
        return p;
      }
    }
  }

  private rejectWithoutProof(taskId: string, mode: string, outcome: Outcome, proofTx: string | undefined, why: string): CachedResponse {
    const res: GatekeeperResponse = { decision: "REJECT", reason_code: reasonCode(outcome, this.deps.config.reasonCodes) };
    if (proofTx !== undefined) res.proof_tx = proofTx;
    this.deps.log("info", "decision", { task_id: taskId, mode, decision: "REJECT", reason_code: res.reason_code, why, proof: false });
    this.deps.store.evidence({ type: "decision", task_id: taskId, mode, ...res, why });
    return json(200, res);
  }

  private async decide(task: GatekeeperTask, receivedAt: number): Promise<CachedResponse> {
    const { config, store, log } = this.deps;
    const { input, task_id: taskId, mode } = task;

    // Timestamp must be sane before any work begins (/build Security checklist).
    const issuedAt = parseTimestamp(task.issued_at);
    const deadlineAt = parseTimestamp(task.deadline_at);
    if (issuedAt === undefined || Math.abs(receivedAt - issuedAt) > config.maxClockSkewMs + config.hardDeadlineMs) {
      return this.rejectWithoutProof(taskId, mode, "FAIL_CLOSED", input.proof_tx, "issued_at missing or outside allowed window");
    }
    const hardDeadline = Math.min(deadlineAt ?? Infinity, receivedAt + config.hardDeadlineMs);
    const budgetMs = hardDeadline - config.deadlineSafetyMs - this.deps.now();

    const ref = normalizeRef(input.proof_tx);
    const refKey = `${mode}\u0000${ref}`;
    const seen = store.hasSeen(mode, ref) || this.inflightRefs.has(refKey);
    this.inflightRefs.add(refKey);
    try {
      let evaluation: Evaluation;
      try {
        evaluation = evaluate(input, seen);
      } catch (e) {
        return this.rejectWithoutProof(taskId, mode, "BAD_INPUT", input.proof_tx, (e as Error).message);
      }

      if (!evaluation.provable) {
        // Reuse: nothing to prove (/events: PROOF_REUSED tasks have no proof to submit).
        store.markSeen(mode, ref, taskId);
        return this.rejectWithoutProof(taskId, mode, evaluation.outcome, input.proof_tx, "proof reference already accepted");
      }

      const salt = randomSalt();
      let proved: GeneratedProof;
      try {
        proved = await withTimeout(this.deps.prover.prove(toCircuitInput(taskId, input, evaluation.decision, salt)), budgetMs);
      } catch (e) {
        // APPROVE is only sent with a proof we generated and verified ourselves.
        // A REJECT verdict is still correct without a proof, so keep its reason code.
        const outcome = evaluation.decision === "APPROVE" ? "FAIL_CLOSED" : evaluation.outcome;
        return this.rejectWithoutProof(taskId, mode, outcome, input.proof_tx, `proof unavailable: ${(e as Error).message}`);
      }

      const res: GatekeeperResponse = {
        decision: evaluation.decision,
        reason_code: reasonCode(evaluation.outcome, config.reasonCodes),
        proof_tx: input.proof_tx,
        proof: proved.proof,
        public_signals: proved.publicSignals,
      };
      if (evaluation.decision === "APPROVE") store.markSeen(mode, ref, taskId);

      log("info", "decision", { task_id: taskId, mode, decision: res.decision, reason_code: res.reason_code, proof: true });
      store.evidence({
        type: "decision",
        task_id: taskId,
        mode,
        decision: res.decision,
        reason_code: res.reason_code,
        proof_tx: input.proof_tx,
        proof: proved.proof,
        public_signals: proved.publicSignals,
      });
      this.submitToZkVerify(taskId, proved);
      return json(200, res);
    } finally {
      this.inflightRefs.delete(refKey);
    }
  }

  /** Background Kurier submission. Never delays the response; results go to evidence.jsonl. */
  private submitToZkVerify(taskId: string, proved: GeneratedProof): void {
    const { kurier, config, store, log } = this.deps;
    if (!kurier || config.kurier.mode !== "background") return;
    void (async () => {
      try {
        const jobId = await kurier.submit(proved.proof, proved.publicSignals, config.kurier.vkHash);
        store.evidence({ type: "kurier", task_id: taskId, network: config.kurier.network, jobId, status: "Submitted" });
        const final = await kurier.waitFinalized(jobId);
        store.evidence({ type: "kurier", task_id: taskId, network: config.kurier.network, jobId, status: final.status, txHash: final.txHash, blockHash: final.blockHash });
        log("info", "zkVerify finalized", { task_id: taskId, jobId, txHash: final.txHash });
      } catch (e) {
        log("warn", "zkVerify submission failed", { task_id: taskId, error: (e as Error).message });
        store.evidence({ type: "kurier", task_id: taskId, error: (e as Error).message });
      }
    })();
  }
}
