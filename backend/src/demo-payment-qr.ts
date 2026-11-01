import { randomUUID } from "node:crypto";
import QRCode from "qrcode";

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
