import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PaymentProviderUnavailable, RazorpayProvider, verifyRazorpayWebhook } from "./payment-provider.js";

test("Razorpay credentials are required; no simulated provider is returned", () => {
  assert.throws(() => new RazorpayProvider("", ""), PaymentProviderUnavailable);
});

test("webhook signature verifies raw bytes and rejects altered body or malformed signature", () => {
  const body = Buffer.from('{"event":"payment.captured"}');
  const secret = "local-test-webhook-secret";
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyRazorpayWebhook(body, signature, secret), true);
  assert.equal(verifyRazorpayWebhook(Buffer.from('{"event":"payment.failed"}'), signature, secret), false);
  assert.equal(verifyRazorpayWebhook(body, "nope", secret), false);
  assert.equal(verifyRazorpayWebhook(body, signature, undefined), false);
});
