import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as snarkjs from "snarkjs";
import type { CircuitInput } from "./encoding.js";
import { PUBLIC_SIGNAL_ORDER, publicSignalsMatch } from "./encoding.js";

/** sha256 of the artifacts published at /build (checked 2026-10-29). A mismatch stops startup. */
export const PINNED_ARTIFACTS = {
  wasm: "be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f",
  zkey: "adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d",
} as const;

export interface GeneratedProof {
  proof: snarkjs.Groth16Proof;
  publicSignals: string[];
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export class Prover {
  private constructor(
    private readonly wasm: Uint8Array,
    private readonly zkey: Uint8Array,
    readonly vk: snarkjs.VerificationKey,
  ) {}

  static async load(wasmPath: string, zkeyPath: string): Promise<Prover> {
    const [wasm, zkey] = await Promise.all([readFile(wasmPath), readFile(zkeyPath)]);
    if (sha256(wasm) !== PINNED_ARTIFACTS.wasm || sha256(zkey) !== PINNED_ARTIFACTS.zkey) {
      throw new Error(
        "Circuit artifacts do not match the pinned /build versions. Re-download them; if the platform published new ones, update PINNED_ARTIFACTS.",
      );
    }
    const vk = await snarkjs.zKey.exportVerificationKey(zkey);
    if (vk.protocol !== "groth16" || vk.curve !== "bn128" || vk.nPublic !== PUBLIC_SIGNAL_ORDER.length) {
      throw new Error("Unexpected verification key: expected groth16/bn128 with 13 public signals");
    }
    return new Prover(wasm, zkey, vk);
  }

  /**
   * Generates the proof, then checks it before returning: it must verify against our VK and
   * its public signals must equal the inputs we meant to prove. Throws on any failure,
   * including the circuit rejecting a decision that disagrees with its own verdict.
   */
  async prove(input: CircuitInput): Promise<GeneratedProof> {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, this.wasm, this.zkey);
    if (!publicSignalsMatch(publicSignals, input)) throw new Error("public signals do not match the proved input");
    if (!(await snarkjs.groth16.verify(this.vk, publicSignals, proof))) throw new Error("local verification failed");
    return { proof, publicSignals };
  }
}
