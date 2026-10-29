import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeHmacKey } from "../src/config.js";
import { sign, verify } from "../src/hmac.js";

const key = Buffer.from("unit-test-key-not-a-real-secret-0123456789", "utf8");
const body = Buffer.from('{"type":"agent-games.preflight.v1","nonce":"abc"}');

test("accepts a correct hex signature over the raw body", () => {
  assert.equal(verify(body, sign(body, key), key), true);
});

test("accepts an optional sha256= prefix and upper-case hex", () => {
  assert.equal(verify(body, `sha256=${sign(body, key).toUpperCase()}`, key), true);
});

test("rejects a signature over different bytes (re-serialised JSON)", () => {
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
  assert.equal(verify(reserialised, sign(body, key), key), false);
});

test("rejects missing, malformed, wrong-length and wrong-key signatures", () => {
  assert.equal(verify(body, undefined, key), false);
  assert.equal(verify(body, ["a", "b"], key), false);
  assert.equal(verify(body, "zz", key), false);
  assert.equal(verify(body, sign(body, key).slice(0, 62), key), false);
  assert.equal(verify(body, sign(body, Buffer.from("other-key-other-key-other-key")), key), false);
});

test("decodes hex and base64 HMAC keys", () => {
  assert.deepEqual(decodeHmacKey("00ff", "hex"), Buffer.from([0, 255]));
  assert.deepEqual(decodeHmacKey("AP8=", "base64"), Buffer.from([0, 255]));
  assert.throws(() => decodeHmacKey("xyz", "hex"));
});
