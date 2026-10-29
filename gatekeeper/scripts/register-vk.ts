// One-time: register a circuit's verification key with Kurier TESTNET and print its vkHash.
// Mainnet doesn't need this: the platform registered both keys there already (see /build).
//
//   npm run register-vk                      # Proof Gatekeeper → KURIER_VK_HASH
//   npm run register-vk -- --circuit stv     # Steal the VFY    → KURIER_VK_HASH_STV

import path from "node:path";
import * as snarkjs from "snarkjs";
import { KurierClient } from "../src/kurier.js";

const apiKey = (process.env.KURIER_API_KEY ?? "").trim();
if (!apiKey) {
  console.error("Set KURIER_API_KEY (testnet key) in .env first.");
  process.exit(1);
}
if ((process.env.KURIER_NETWORK ?? "testnet") !== "testnet") {
  console.error("This script only registers on testnet. Mainnet uses the platform's hashes from /build.");
  process.exit(1);
}

const stv = process.argv.includes("--circuit") && process.argv[process.argv.indexOf("--circuit") + 1] === "stv";
const zkeyFile = stv ? "vfy-policy_final.zkey" : "gatekeeper_final.zkey";
const envVar = stv ? "KURIER_VK_HASH_STV" : "KURIER_VK_HASH";

const vk = await snarkjs.zKey.exportVerificationKey(path.resolve(process.env.CIRCUITS_DIR ?? "circuits", zkeyFile));
const vkHash = await new KurierClient("https://api-testnet.kurier.xyz/api/v1", apiKey).registerVk(vk);
console.log(`Testnet vkHash (${stv ? "vfy-policy" : "gatekeeper"}): ${vkHash}\nSet ${envVar}=${vkHash} in .env`);
process.exit(0);
