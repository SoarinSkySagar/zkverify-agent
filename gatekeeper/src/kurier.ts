// Kurier REST client (https://docs.zkverify.io/overview/getting-started/kurier).
// The API key sits in the URL path, so URLs and raw fetch errors are never logged or rethrown.

import type { Groth16Proof, VerificationKey } from "snarkjs";

export type KurierStatus =
  | "Queued" | "Valid" | "Submitted" | "IncludedInBlock" | "Finalized" | "Failed"
  | "AggregationPending" | "Aggregated" | "AggregationPublished";

/** Finalized, or a later aggregation stage (which only happens after finalization). */
const FINAL_OK = new Set<string>(["Finalized", "AggregationPending", "Aggregated", "AggregationPublished"]);

export interface JobStatus {
  jobId: string;
  status: KurierStatus | string;
  txHash?: string;
  blockHash?: string;
}

export class KurierError extends Error {}

const PROOF_OPTIONS = { library: "snarkjs", curve: "bn128" } as const;

export class KurierClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** POST {baseUrl}/{route}/{apiKey} */
  private async call(route: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/${route}/${encodeURIComponent(this.apiKey)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new KurierError(`Kurier ${route}: network error`);
    }
    const text = await res.text();
    if (!res.ok) throw new KurierError(`Kurier ${route}: HTTP ${res.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new KurierError(`Kurier ${route}: non-JSON response`);
    }
  }

  /** One-time VK registration (needed on testnet; mainnet already has the platform's hash). */
  async registerVk(vk: VerificationKey): Promise<string> {
    const r = (await this.call("register-vk", { proofType: "groth16", proofOptions: PROOF_OPTIONS, vk })) as {
      vkHash?: string;
      meta?: { vkHash?: string };
    };
    const hash = r.vkHash ?? r.meta?.vkHash;
    if (!hash) throw new KurierError("Kurier register-vk: no vkHash in response");
    return hash;
  }

  async submit(proof: Groth16Proof, publicSignals: string[], vkHash: string): Promise<string> {
    const r = (await this.call("submit-proof", {
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: PROOF_OPTIONS,
      proofData: { proof, publicSignals, vk: vkHash },
    })) as { jobId?: string; optimisticVerify?: string };
    if (!r.jobId) throw new KurierError("Kurier submit-proof: no jobId");
    if (r.optimisticVerify !== undefined && r.optimisticVerify !== "success") {
      throw new KurierError(`Kurier submit-proof: optimistic verification ${r.optimisticVerify}`);
    }
    return r.jobId;
  }

  /** Polls until Finalized (or later). Throws on Failed or timeout. */
  async waitFinalized(jobId: string, { timeoutMs = 300_000, intervalMs = 5_000 } = {}): Promise<JobStatus> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.jobStatus(jobId);
      if (FINAL_OK.has(s.status)) return s;
      if (s.status === "Failed") throw new KurierError(`Kurier job ${jobId} failed`);
      if (Date.now() > until) throw new KurierError(`Kurier job ${jobId} not finalized in time (last: ${s.status})`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async jobStatus(jobId: string): Promise<JobStatus> {
    // Path shape is /job-status/{apiKey}/{jobId}.
    const url = `${this.baseUrl}/job-status/${encodeURIComponent(this.apiKey)}/${encodeURIComponent(jobId)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new KurierError("Kurier job-status: network error");
    }
    if (!res.ok) throw new KurierError(`Kurier job-status: HTTP ${res.status}`);
    const r = (await res.json()) as JobStatus;
    if (typeof r?.status !== "string") throw new KurierError("Kurier job-status: malformed response");
    return r;
  }
}
