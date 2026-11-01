import test from "node:test";
import assert from "node:assert/strict";
import { createDemoPaymentQr, demoPaymentQrPayload } from "./demo-payment-qr.js";

test("demo QR is a local PNG data URL and encodes a non-payment marker", async () => {
  const qr = await createDemoPaymentQr("demo-friend-vedansh", 12500);
  assert.match(qr, /^data:image\/png;base64,/);
  assert.ok(Buffer.from(qr.split(",")[1], "base64").length > 100);
  const payload = demoPaymentQrPayload("demo-friend-vedansh", 12500);
  assert.match(payload, /FOODLENS DEMO ONLY - NOT A PAYMENT/);
  assert.match(payload, /amount_paise=12500/);
});

test("demo QR rejects invalid participant identifiers and amounts", async () => {
  await assert.rejects(createDemoPaymentQr("bad/id", 100));
  await assert.rejects(createDemoPaymentQr("demo-friend", 0));
  await assert.rejects(createDemoPaymentQr("demo-friend", 1.5));
});
