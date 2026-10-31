import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { configuredPaymentProvider, PaymentProviderUnavailable, RazorpayProvider, verifyRazorpayWebhook } from "./payment-provider.js";

test("Razorpay credentials are required; no simulated provider is returned", () => {
  assert.throws(() => new RazorpayProvider("", ""), PaymentProviderUnavailable);
});

test("Basket Split payment adapter accepts test keys only", () => {
  const before = { env: process.env.PAYMENT_ENV, id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET };
  try {
    process.env.PAYMENT_ENV = "live";
    process.env.RAZORPAY_KEY_ID = "rzp_live_example";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    assert.equal(configuredPaymentProvider(), null);
    process.env.PAYMENT_ENV = "test";
    process.env.RAZORPAY_KEY_ID = "rzp_test_example";
    assert.ok(configuredPaymentProvider() instanceof RazorpayProvider);
  } finally {
    for (const [name, value] of [["PAYMENT_ENV", before.env], ["RAZORPAY_KEY_ID", before.id], ["RAZORPAY_KEY_SECRET", before.secret]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
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
