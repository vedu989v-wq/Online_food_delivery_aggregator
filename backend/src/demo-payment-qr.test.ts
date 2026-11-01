import test from "node:test";
import assert from "node:assert/strict";
import { createDemoPaymentQr, createParticipantQr, demoPaymentQrPayload } from "./demo-payment-qr.js";
import type { PaymentProvider } from "./payment-provider.js";

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

test("missing credentials and Razorpay errors both produce explicit non-payable QRs", async () => {
  const participant = { id: "demo-friend-vijendra", name: "Vijendra", amountPaise: 9900 };
  const noProvider = await createParticipantQr(null, participant);
  assert.equal(noProvider.status, "demo");
  assert.match(noProvider.error || "", /cannot accept payment/);
  assert.match(noProvider.imageUrl, /^data:image\/png;base64,/);

  const rejectingProvider = {
    name: "razorpay",
    createSingleUseUpiQr: async () => { throw new Error("provider unavailable"); },
    verifyQrPayment: async () => ({ status: "pending" as const, amountPaise: 0 }),
    closeSingleUseUpiQr: async () => undefined,
  } satisfies PaymentProvider;
  const fallback = await createParticipantQr(rejectingProvider, participant);
  assert.equal(fallback.status, "demo");
  assert.match(fallback.error || "", /Razorpay test QR unavailable/);
  assert.match(fallback.imageUrl, /^data:image\/png;base64,/);
});

test("successful provider QR remains a Razorpay test QR", async () => {
  const provider = {
    name: "razorpay",
    createSingleUseUpiQr: async ({ amountPaise }: { amountPaise: number }) => ({ id: "qr_test123", imageUrl: "https://example.test/qr.png", amountPaise, status: "active" }),
    verifyQrPayment: async () => ({ status: "pending" as const, amountPaise: 0 }),
    closeSingleUseUpiQr: async () => undefined,
  } satisfies PaymentProvider;
  const qr = await createParticipantQr(provider, { id: "me", name: "Me", amountPaise: 12300 });
  assert.equal(qr.status, "created");
  assert.equal(qr.imageUrl, "https://example.test/qr.png");
});
