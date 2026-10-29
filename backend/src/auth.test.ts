import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, normalizeEmail, validDisplayName, validPassword, parseCookie, requestOriginAllowed } from "./auth.js";

test("normalizes valid emails and rejects malformed or oversized values", () => {
  assert.equal(normalizeEmail("  Person@Example.com "), "person@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("a".repeat(250) + "@x.io"), null);
});

test("validates customer names and password lengths", () => {
  assert.equal(validDisplayName("  A   Customer "), "A Customer");
  assert.equal(validDisplayName(" "), null);
  assert.equal(validPassword("correct horse battery"), true);
  assert.equal(validPassword("short"), false);
  assert.equal(validPassword("x".repeat(129)), false);
});

test("password hashes are salted and verified without storing plaintext", async () => {
  const first = await hashPassword("correct horse battery");
  const second = await hashPassword("correct horse battery");
  assert.notEqual(first, second);
  assert.equal(first.includes("correct horse battery"), false);
  assert.equal(await verifyPassword("correct horse battery", first), true);
  assert.equal(await verifyPassword("incorrect password", first), false);
});

test("cookie parsing and strict allowed-origin checks", () => {
  assert.equal(parseCookie("other=x; foodlens_session=abc%2F123", "foodlens_session"), "abc/123");
  assert.equal(parseCookie("foodlens_session=bad%zz", "foodlens_session"), null);
  assert.equal(requestOriginAllowed("https://foodlens.example", ["https://foodlens.example"]), true);
  assert.equal(requestOriginAllowed("https://attacker.example", ["https://foodlens.example"]), false);
});
