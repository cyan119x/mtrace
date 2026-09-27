import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadCapability, verifyDownloadTokenHash } from "../dist/download-capability.js";

test("creates a 256-bit URL-safe capability and validates its hash", () => {
  const capability = createDownloadCapability();
  assert.match(capability.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(capability.tokenHash.length, 32);
  assert.equal(verifyDownloadTokenHash(capability.token, capability.tokenHash), true);
});

test("rejects a different or malformed download token", () => {
  const first = createDownloadCapability();
  const second = createDownloadCapability();
  assert.equal(verifyDownloadTokenHash(second.token, first.tokenHash), false);
  assert.equal(verifyDownloadTokenHash("not-a-token", first.tokenHash), false);
});

test("capabilities are unique", () => {
  const tokens = new Set(Array.from({ length: 64 }, () => createDownloadCapability().token));
  assert.equal(tokens.size, 64);
});
