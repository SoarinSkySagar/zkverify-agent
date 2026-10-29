// Durable state in append-only JSONL files under DATA_DIR:
//   state.jsonl    — seen proof references and cached responses, replayed at startup
//   evidence.jsonl — per-task proof evidence and Kurier results, kept for disputes
// Each write is fsync'd. The volume is tiny (8 tasks per round).

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

type StateRecord =
  | { kind: "seen"; mode: string; ref: string; taskId: string; at: string }
  | { kind: "response"; taskId: string; status: number; body: string; at: string };

export interface CachedResponse {
  status: number;
  body: string;
}

export class Store {
  private readonly seen = new Set<string>();
  private readonly responses = new Map<string, CachedResponse>();
  private readonly stateFd: number;
  private readonly evidenceFd: number;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const statePath = path.join(dataDir, "state.jsonl");
    if (existsSync(statePath)) {
      for (const line of readFileSync(statePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let rec: StateRecord;
        try {
          rec = JSON.parse(line) as StateRecord;
        } catch {
          continue; // a torn final line after a crash
        }
        if (rec.kind === "seen") this.seen.add(key(rec.mode, rec.ref));
        else if (rec.kind === "response") this.responses.set(rec.taskId, { status: rec.status, body: rec.body });
      }
    }
    this.stateFd = openSync(statePath, "a", 0o600);
    this.evidenceFd = openSync(path.join(dataDir, "evidence.jsonl"), "a", 0o600);
  }

  hasSeen(mode: string, ref: string): boolean {
    return this.seen.has(key(mode, ref));
  }

  markSeen(mode: string, ref: string, taskId: string): void {
    if (this.seen.has(key(mode, ref))) return;
    this.append(this.stateFd, { kind: "seen", mode, ref, taskId, at: new Date().toISOString() });
    this.seen.add(key(mode, ref));
  }

  getResponse(taskId: string): CachedResponse | undefined {
    return this.responses.get(taskId);
  }

  putResponse(taskId: string, res: CachedResponse): void {
    this.append(this.stateFd, { kind: "response", taskId, ...res, at: new Date().toISOString() });
    this.responses.set(taskId, res);
  }

  evidence(record: Record<string, unknown>): void {
    this.append(this.evidenceFd, { ...record, at: new Date().toISOString() });
  }

  close(): void {
    closeSync(this.stateFd);
    closeSync(this.evidenceFd);
  }

  private append(fd: number, rec: unknown): void {
    writeSync(fd, JSON.stringify(rec) + "\n");
    fsyncSync(fd);
  }
}

// Seen-sets are per mode so practice tasks can't poison competition decisions.
const key = (mode: string, ref: string) => `${mode}\u0000${ref}`;
