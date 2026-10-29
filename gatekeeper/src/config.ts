import path from "node:path";

export type ReasonCodeSet = "trap" | "canonical";
export type KurierMode = "off" | "background";
export type KurierNetwork = "testnet" | "mainnet";

export interface Config {
  /** Bind address. 127.0.0.1 when a local reverse proxy (Caddy) fronts the agent. */
  host: string;
  port: number;
  agentPath: string;
  dataDir: string;
  /** Primary HMAC key bytes. Never log this. */
  hmacKey: Buffer;
  /** All accepted keys: primary first, then AGENT_GAMES_HMAC_SECRET_STV if set. A response is signed with the key that verified its request. */
  hmacKeys: Buffer[];
  maxClockSkewMs: number;
  deadlineSafetyMs: number;
  /** Hard response deadline from the spec (60 s). */
  hardDeadlineMs: number;
  reasonCodes: ReasonCodeSet;
  wasmPath: string;
  zkeyPath: string;
  kurier: {
    mode: KurierMode;
    network: KurierNetwork;
    baseUrl: string;
    /** Never log this — Kurier puts it in the URL path. */
    apiKey: string;
    vkHash: string;
    vkHashStv: string;
  };
  stv: {
    wasmPath: string;
    zkeyPath: string;
    /** Raw STRATEGY_PARAMS / STRATEGY_SALT. Parsed by src/stv; never log these. */
    strategyParamsRaw: string | undefined;
    strategySaltRaw: string | undefined;
    /** Used when a turn envelope has no deadlineAt ("~30 s to respond / turn"). */
    defaultTurnWindowMs: number;
    deadlineSafetyMs: number;
    /** Where proof + public_signals go in the response; see CLAUDE.md §10. */
    proofPlacement: "top" | "policyProof";
  };
}

/** Gatekeeper vk_hash registered on zkVerify mainnet (from /build and /api/circuit-info). */
export const MAINNET_GATEKEEPER_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
/** Steal the VFY (vfy-policy) vk_hash registered on zkVerify mainnet. */
export const MAINNET_STV_VK_HASH =
  "0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047";

const KURIER_URLS: Record<KurierNetwork, string> = {
  testnet: "https://api-testnet.kurier.xyz/api/v1",
  mainnet: "https://api.kurier.xyz/api/v1",
};

const PLACEHOLDER_SECRETS = new Set(["", "changeme", "secret", "placeholder", "test", "xxx"]);

export class ConfigError extends Error {}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value ?? "").trim() || fallback;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

function int(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer`);
  return n;
}

export function decodeHmacKey(secret: string, encoding: "utf8" | "hex" | "base64"): Buffer {
  if (encoding === "hex") {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(secret)) throw new ConfigError("AGENT_GAMES_HMAC_SECRET is not valid hex");
    return Buffer.from(secret, "hex");
  }
  if (encoding === "base64") return Buffer.from(secret, "base64");
  return Buffer.from(secret, "utf8");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = (env.AGENT_GAMES_HMAC_SECRET ?? "").trim();
  if (PLACEHOLDER_SECRETS.has(secret.toLowerCase()) || secret.length < 16) {
    // Error text deliberately does not echo the value.
    throw new ConfigError(
      "AGENT_GAMES_HMAC_SECRET is missing or a placeholder — set it from the dashboard 'Rotate Secret'",
    );
  }
  const encoding = oneOf("AGENT_GAMES_HMAC_KEY_ENCODING", env.AGENT_GAMES_HMAC_KEY_ENCODING, ["utf8", "hex", "base64"] as const, "utf8");

  const agentPath = (env.AGENT_PATH ?? "/agent").trim();
  if (!agentPath.startsWith("/") || agentPath === "/") {
    throw new ConfigError("AGENT_PATH must be a full handler path such as /agent (not the root)");
  }

  const network = oneOf("KURIER_NETWORK", env.KURIER_NETWORK, ["testnet", "mainnet"] as const, "testnet");
  const mode = oneOf("KURIER_MODE", env.KURIER_MODE, ["off", "background"] as const, "off");
  const apiKey = (env.KURIER_API_KEY ?? "").trim();
  let vkHash = (env.KURIER_VK_HASH ?? "").trim();
  if (!vkHash && network === "mainnet") vkHash = MAINNET_GATEKEEPER_VK_HASH;
  if (mode === "background") {
    if (!apiKey) throw new ConfigError("KURIER_MODE=background requires KURIER_API_KEY");
    if (!vkHash) throw new ConfigError("KURIER_VK_HASH is required on testnet — run `npm run register-vk` first");
  }

  let vkHashStv = (env.KURIER_VK_HASH_STV ?? "").trim();
  if (!vkHashStv && network === "mainnet") vkHashStv = MAINNET_STV_VK_HASH;

  const circuitsDir = path.resolve(env.CIRCUITS_DIR ?? "circuits");

  // Optional second secret, for when Steal the VFY is registered as a separate agent pointing
  // at the same URL. Same encoding as the primary.
  const hmacKey = decodeHmacKey(secret, encoding);
  const hmacKeys = [hmacKey];
  const secretStv = (env.AGENT_GAMES_HMAC_SECRET_STV ?? "").trim();
  if (secretStv) {
    if (PLACEHOLDER_SECRETS.has(secretStv.toLowerCase()) || secretStv.length < 16) {
      throw new ConfigError("AGENT_GAMES_HMAC_SECRET_STV looks like a placeholder — set it from that agent's 'Rotate Secret', or leave it empty");
    }
    hmacKeys.push(decodeHmacKey(secretStv, encoding));
  }

  return {
    host: (env.HOST ?? "").trim() || "0.0.0.0",
    port: int("PORT", env.PORT, 8080),
    agentPath,
    dataDir: path.resolve(env.DATA_DIR ?? "data"),
    hmacKey,
    hmacKeys,
    maxClockSkewMs: int("MAX_CLOCK_SKEW_SECONDS", env.MAX_CLOCK_SKEW_SECONDS, 120) * 1000,
    deadlineSafetyMs: int("DEADLINE_SAFETY_MS", env.DEADLINE_SAFETY_MS, 5000),
    hardDeadlineMs: 60_000,
    reasonCodes: oneOf("REASON_CODES", env.REASON_CODES, ["trap", "canonical"] as const, "trap"),
    wasmPath: path.join(circuitsDir, "gatekeeper.wasm"),
    zkeyPath: path.join(circuitsDir, "gatekeeper_final.zkey"),
    kurier: { mode, network, baseUrl: KURIER_URLS[network], apiKey, vkHash, vkHashStv },
    stv: {
      wasmPath: path.join(circuitsDir, "vfy-policy.wasm"),
      zkeyPath: path.join(circuitsDir, "vfy-policy_final.zkey"),
      strategyParamsRaw: env.STRATEGY_PARAMS,
      strategySaltRaw: env.STRATEGY_SALT,
      defaultTurnWindowMs: 30_000,
      deadlineSafetyMs: int("STV_DEADLINE_SAFETY_MS", env.STV_DEADLINE_SAFETY_MS, 3000),
      proofPlacement: oneOf("STV_PROOF_PLACEMENT", env.STV_PROOF_PLACEMENT, ["top", "policyProof"] as const, "top"),
    },
  };
}
