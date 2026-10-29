// publicInputsHash must match /build §06 exactly: keccak256 over eight 32-byte big-endian words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3";
import { publicInputsHash } from "../src/stv/publicInputsHash.js";

const hex32 = (n: bigint) => n.toString(16).padStart(64, "0");

test("keccak256 is Ethereum's keccak, not NIST SHA3-256", () => {
  assert.equal(Buffer.from(keccak_256(new Uint8Array())).toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
});

test("field order and packing follow the /build snippet", () => {
  const commitment = 0x7d00000000000000000000000000000000000000000000000000000000000091n;
  const matchId = "9f4e1b2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  // Built by hand in the /build order: commitment, matchId, turn, self, opp, action, amount, version
  const words = [commitment, BigInt("0x" + matchId.replace(/-/g, "")), 3n, 95n, 105n, 2n, 5n, 1n].map(hex32).join("");
  const expected = "0x" + Buffer.from(keccak_256(Buffer.from(words, "hex"))).toString("hex");
  const got = publicInputsHash({ commitment, matchId, turn: 3, selfBalance: 95n, opponentBalance: 105n, action: { type: "EXTRACT", amount: 5 } });
  assert.equal(got, expected);

  // Swapping two fields must change it (catches order mistakes).
  const swapped = publicInputsHash({ commitment, matchId, turn: 3, selfBalance: 105n, opponentBalance: 95n, action: { type: "EXTRACT", amount: 5 } });
  assert.notEqual(swapped, got);
});

test("HOLD and FORTIFY hash with amount 0 and their action codes", () => {
  const base = { commitment: 1n, matchId: "ab", turn: 1, selfBalance: 100n, opponentBalance: 100n };
  const words = (action: bigint) => [1n, 0xabn, 1n, 100n, 100n, action, 0n, 1n].map(hex32).join("");
  const k = (h: string) => "0x" + Buffer.from(keccak_256(Buffer.from(h, "hex"))).toString("hex");
  assert.equal(publicInputsHash({ ...base, action: { type: "HOLD" } }), k(words(0n)));
  assert.equal(publicInputsHash({ ...base, action: { type: "FORTIFY" } }), k(words(1n)));
});
