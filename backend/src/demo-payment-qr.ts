import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type { PaymentProvider } from "./payment-provider.js";

export interface ParticipantQrResult {
  imageUrl: string;
  amountPaise: number;
  status: "created" | "demo";
  error: string | null;
}

export function demoPaymentQrPayload(participantId: string, amountPaise: number): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(participantId)
    || !Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > 100_000_000) {
    throw new Error("Invalid demo payment details");
  }
  // This is deliberately plain text, not a UPI payment URI. It is safe to
  // display without payment credentials and cannot collect money.
  return `FOODLENS DEMO ONLY - NOT A PAYMENT | participant=${participantId} | amount_paise=${amountPaise} | ref=${randomUUID()}`;
}

export async function createDemoPaymentQr(participantId: string, amountPaise: number): Promise<string> {
  return QRCode.toDataURL(demoPaymentQrPayload(participantId, amountPaise), { errorCorrectionLevel: "M", margin: 2, width: 320 });
}

export async function createParticipantQr(
  provider: PaymentProvider | null,
  participant: { id: string; name: string; amountPaise: number },
): Promise<ParticipantQrResult> {
  if (provider) {
    try {
      const qr = await provider.createSingleUseUpiQr({
        amountPaise: participant.amountPaise,
        description: `FoodLens demo share for ${participant.name.trim()}`,
        paymentRequestId: randomUUID(),
      });
      return { imageUrl: qr.imageUrl, amountPaise: qr.amountPaise, status: "created", error: null };
    } catch {
      // Provider failures must not block the presentation flow. Never claim
      // the fallback is payable or represent it as a Razorpay request.
      return {
        imageUrl: await createDemoPaymentQr(participant.id, participant.amountPaise),
        amountPaise: participant.amountPaise,
        status: "demo",
        error: "Razorpay test QR unavailable; this demo QR cannot accept payment.",
      };
    }
  }
  return {
    imageUrl: await createDemoPaymentQr(participant.id, participant.amountPaise),
    amountPaise: participant.amountPaise,
    status: "demo",
    error: "Razorpay test credentials are not configured; this demo QR cannot accept payment.",
  };
}
