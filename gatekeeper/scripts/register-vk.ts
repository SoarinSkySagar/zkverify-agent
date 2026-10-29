// One-time: register the gatekeeper verification key with Kurier TESTNET and print its vkHash.
// Mainnet doesn't need this: the platform registered the key there already (see /build).
//
//   KURIER_API_KEY=... npm run register-vk

import path from "node:path";
import * as snarkjs from "snarkjs";
import { KurierClient } from "../src/kurier.js";

const apiKey = (process.env.KURIER_API_KEY ?? "").trim();
if (!apiKey) {
  console.error("Set KURIER_API_KEY (testnet key) in .env first.");
  process.exit(1);
}
if ((process.env.KURIER_NETWORK ?? "testnet") !== "testnet") {
  console.error("This script only registers on testnet. Mainnet uses the platform's hash from /build.");
  process.exit(1);
}

const zkey = path.resolve(process.env.CIRCUITS_DIR ?? "circuits", "gatekeeper_final.zkey");
const vk = await snarkjs.zKey.exportVerificationKey(zkey);
const vkHash = await new KurierClient("https://api-testnet.kurier.xyz/api/v1", apiKey).registerVk(vk);
console.log(`Testnet vkHash: ${vkHash}\nSet KURIER_VK_HASH=${vkHash} in .env`);
process.exit(0);
