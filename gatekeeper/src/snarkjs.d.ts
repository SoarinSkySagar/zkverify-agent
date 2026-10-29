// Minimal typings for the parts of snarkjs this agent uses (snarkjs ships no types).
declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export interface VerificationKey {
    protocol: string;
    curve: string;
    nPublic: number;
    [k: string]: unknown;
  }
  export const groth16: {
    fullProve(
      input: Record<string, string | string[]>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vk: VerificationKey, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };
  export const zKey: {
    exportVerificationKey(zkey: string | Uint8Array): Promise<VerificationKey>;
  };
}
