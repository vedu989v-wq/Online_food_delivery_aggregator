import { createHmac, timingSafeEqual } from "node:crypto";

export interface PaymentQr { id: string; imageUrl: string; amountPaise: number; status: string }
export interface PaymentStatus { status: "paid" | "pending" | "failed"; amountPaise: number; paymentId?: string }
export interface PaymentProvider {
  readonly name: string;
  createSingleUseUpiQr(input: { amountPaise: number; description: string; paymentRequestId: string }): Promise<PaymentQr>;
  verifyQrPayment(qrCodeId: string, expectedPaise: number): Promise<PaymentStatus>;
}

export class PaymentProviderUnavailable extends Error {
  constructor() { super("Payment provider is not configured"); this.name = "PaymentProviderUnavailable"; }
}

/** Real Razorpay adapter. Requires account activation and server-side credentials. */
export class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay";
  constructor(private readonly keyId: string, private readonly keySecret: string) {
    if (!keyId || !keySecret) throw new PaymentProviderUnavailable();
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
    const response = await fetch(`https://api.razorpay.com/v1${path}`, {
      ...init, headers: { authorization: `Basic ${auth}`, "content-type": "application/json", ...init?.headers },
      signal: AbortSignal.timeout(12000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || typeof body !== "object") throw new Error("Payment provider request failed");
    return body as T;
  }

  async createSingleUseUpiQr(input: { amountPaise: number; description: string; paymentRequestId: string }): Promise<PaymentQr> {
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0 || input.amountPaise > 100_000_000) throw new Error("Invalid payment amount");
    const response = await this.request<{ id: string; image_url: string; payment_amount: number; status: string }>("/payments/qr_codes", {
      method: "POST", body: JSON.stringify({ type: "upi_qr", name: "FoodLens Basket Split", usage: "single_use", fixed_amount: true,
        payment_amount: input.amountPaise, description: input.description.slice(0, 255), close_by: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        notes: { foodlens_payment_request: input.paymentRequestId } }),
    });
    if (!response.id || !response.image_url || response.payment_amount !== input.amountPaise) throw new Error("Payment provider returned an invalid QR response");
    return { id: response.id, imageUrl: response.image_url, amountPaise: response.payment_amount, status: response.status };
  }

  async verifyQrPayment(qrCodeId: string, expectedPaise: number): Promise<PaymentStatus> {
    const response = await this.request<{ items: Array<{ id: string; amount: number; currency: string; status: string }> }>(`/payments/qr_codes/${encodeURIComponent(qrCodeId)}/payments?count=100`);
    const captured = (response.items || []).filter(payment => payment.status === "captured" && payment.currency === "INR");
    const match = captured.find(payment => payment.amount === expectedPaise);
    if (match) return { status: "paid", amountPaise: match.amount, paymentId: match.id };
    if (captured.some(payment => payment.amount !== expectedPaise)) return { status: "failed", amountPaise: 0 };
    return { status: "pending", amountPaise: 0 };
  }
}

export function configuredPaymentProvider(): PaymentProvider | null {
  const id = process.env.RAZORPAY_KEY_ID?.trim() || "";
  const secret = process.env.RAZORPAY_KEY_SECRET?.trim() || "";
  if (!id || !secret) return null;
  return new RazorpayProvider(id, secret);
}

export function verifyRazorpayWebhook(rawBody: Buffer, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
