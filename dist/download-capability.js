import crypto from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;

export function createDownloadCapability() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashDownloadToken(token) };
}

export function hashDownloadToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest();
}

export function isValidDownloadToken(token) {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function verifyDownloadTokenHash(token, expectedHash) {
  if (!isValidDownloadToken(token) || !Buffer.isBuffer(expectedHash) || expectedHash.length !== 32) {
    return false;
  }
  const actual = hashDownloadToken(token);
  return crypto.timingSafeEqual(actual, expectedHash);
}
