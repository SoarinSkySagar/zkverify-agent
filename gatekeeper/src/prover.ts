import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as snarkjs from "snarkjs";
import type { CircuitInput } from "./encoding.js";
import { PUBLIC_SIGNAL_ORDER, publicSignalsMatch } from "./encoding.js";

export interface GeneratedProof {
  proof: snarkjs.Groth16Proof;
  publicSignals: string[];
}

/** What a loaded circuit must look like, and how to check a proof's public signals. */
export interface CircuitSpec<I> {
  name: string;
  /** sha256 of the artifacts published at /build. A mismatch stops startup. */
  sha256: { wasm: string; zkey: string };
  nPublic: number;
  signalsMatch(publicSignals: readonly string[], input: I): boolean;
}

/** Proof Gatekeeper circuit (artifacts checked 2026-10-29). */
export const GATEKEEPER_CIRCUIT: CircuitSpec<CircuitInput> = {
  name: "gatekeeper",
  sha256: {
    wasm: "be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f",
    zkey: "adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d",
  },
  nPublic: PUBLIC_SIGNAL_ORDER.length,
  signalsMatch: publicSignalsMatch,
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export class Prover<I extends Record<string, string | string[]> = CircuitInput> {
  private constructor(
    private readonly spec: CircuitSpec<I>,
    private readonly wasm: Uint8Array,
    private readonly zkey: Uint8Array,
    readonly vk: snarkjs.VerificationKey,
  ) {}

  static async load<I extends Record<string, string | string[]> = CircuitInput>(
    wasmPath: string,
    zkeyPath: string,
    spec: CircuitSpec<I> = GATEKEEPER_CIRCUIT as unknown as CircuitSpec<I>,
  ): Promise<Prover<I>> {
    const [wasm, zkey] = await Promise.all([readFile(wasmPath), readFile(zkeyPath)]);
    if (sha256(wasm) !== spec.sha256.wasm || sha256(zkey) !== spec.sha256.zkey) {
      throw new Error(
        `${spec.name}: circuit artifacts do not match the pinned /build versions. Re-download them; if the platform published new ones, update the pinned hashes.`,
      );
    }
    const vk = await snarkjs.zKey.exportVerificationKey(zkey);
    if (vk.protocol !== "groth16" || vk.curve !== "bn128" || vk.nPublic !== spec.nPublic) {
      throw new Error(`${spec.name}: unexpected verification key (expected groth16/bn128 with ${spec.nPublic} public signals)`);
    }
    return new Prover(spec, wasm, zkey, vk);
  }

  /**
   * Generates the proof, then checks it before returning: it must verify against our VK and
   * its public signals must equal the inputs we meant to prove. Throws on any failure,
   * including the circuit rejecting a decision that disagrees with its own verdict.
   */
  async prove(input: I): Promise<GeneratedProof> {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, this.wasm, this.zkey);
    if (!this.spec.signalsMatch(publicSignals, input)) throw new Error("public signals do not match the proved input");
    if (!(await snarkjs.groth16.verify(this.vk, publicSignals, proof))) throw new Error("local verification failed");
    return { proof, publicSignals };
  }
}
