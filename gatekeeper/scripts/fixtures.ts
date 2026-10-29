// Turns fixtures/gatekeeper-cases.json into signed-ready envelopes (shared by tests and the replay harness).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Decision, Outcome } from "../src/decision.js";

export interface FixtureCase {
  name: string;
  reuseOf?: string;
  patch: Record<string, unknown>;
  expect: { decision: Decision; outcome: Outcome };
}

interface FixtureFile {
  base: Record<string, unknown>;
  cases: FixtureCase[];
}

const file = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/gatekeeper-cases.json", import.meta.url)), "utf8"),
) as FixtureFile;

export const fixtureCases = file.cases;

export const randomHex32 = () => "0x" + randomBytes(32).toString("hex");

/** Builds one envelope per case, in order, with fresh task_ids / proof_tx / timestamps. */
export function buildEnvelopes(now = Date.now(), mode = "practice"): { c: FixtureCase; envelope: Record<string, unknown> }[] {
  const refs = new Map<string, string>();
  const run = randomBytes(4).toString("hex");
  return file.cases.map((c, i) => {
    const proofTx = c.reuseOf ? refs.get(c.reuseOf) : randomHex32();
    if (!proofTx) throw new Error(`fixture ${c.name}: reuseOf ${c.reuseOf} must come earlier`);
    refs.set(c.name, proofTx);
    return {
      c,
      envelope: {
        type: "agent-games.proof-gatekeeper.v1",
        task_id: `gk_${run}_${i}`,
        mode,
        issued_at: new Date(now).toISOString(),
        deadline_at: new Date(now + 60_000).toISOString(),
        input: { ...file.base, ...c.patch, proof_tx: proofTx },
      },
    };
  });
}
