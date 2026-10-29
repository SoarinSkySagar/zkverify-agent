// Generates a random STRATEGY_SALT and writes it into .env WITHOUT printing it.
// Refuses to replace an existing salt, because that would change your commitment.
//
//   npm run stv:new-salt              # only if STRATEGY_SALT is empty
//   npm run stv:new-salt -- --force   # replace it (then re-register the new commitment)

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newSalt } from "../src/stv/commitment.js";

const envPath = path.resolve(".env");
const force = process.argv.includes("--force");

if (!existsSync(envPath)) {
  console.error("No .env here. Create it first: cp .env.example .env");
  process.exit(1);
}
const lines = readFileSync(envPath, "utf8").split("\n");
const idx = lines.findIndex((l) => /^\s*STRATEGY_SALT\s*=/.test(l));
const current = idx >= 0 ? (lines[idx] ?? "").replace(/^\s*STRATEGY_SALT\s*=\s*/, "").trim() : "";

if (current && !force) {
  console.error("STRATEGY_SALT is already set; refusing to replace it (it would change your commitment).");
  console.error("If you really want a new one: npm run stv:new-salt -- --force, then re-register the commitment.");
  process.exit(1);
}

const line = `STRATEGY_SALT=${newSalt().toString()}`;
if (idx >= 0) lines[idx] = line;
else lines.push(line);
writeFileSync(envPath, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(`Wrote a new random STRATEGY_SALT to ${envPath} (not shown). Next: npm run stv:commitment`);
