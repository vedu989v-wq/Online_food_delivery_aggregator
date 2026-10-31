import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import cors from "cors";
import { authAllowedOrigins, authRouter, authenticate, requireAdmin, requireCsrf } from "./auth-routes.js";
import { customerRouter } from "./customer-routes.js";
import { sharedCartRouter } from "./shared-cart-routes.js";
import { smartmealRouter } from "./smartmeal-routes.js";
import { databaseConfigured, inTransaction, query } from "./db.js";
import { configuredPaymentProvider, verifyRazorpayWebhook } from "./payment-provider.js";

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || "127.0.0.1";
const pythonApiBase = (process.env.PYTHON_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const pythonTimeoutMs = 15_000;
const localBind = ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
const adminMutationsEnabled = process.env.NODE_ENV !== "production"
  && process.env.ADMIN_DEMO_MODE === "true"
  && localBind;

const allowedOrigins = authAllowedOrigins();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["content-type", "x-csrf-token"],
  maxAge: 600,
}));
app.post("/api/payments/webhooks/razorpay", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) return res.status(415).end();
  if (!verifyRazorpayWebhook(rawBody, req.get("x-razorpay-signature"), process.env.RAZORPAY_WEBHOOK_SECRET)) return res.status(400).json({ error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook signature could not be verified." } });
  const eventId = req.get("x-razorpay-event-id") || "";
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(eventId)) return res.status(400).json({ error: { code: "INVALID_WEBHOOK_EVENT", message: "Webhook event identifier is invalid." } });
  let payload: any;
  try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return res.status(400).end(); }
  const eventType = typeof payload?.event === "string" ? payload.event : "";
  const qrCodeId = payload?.payload?.qr_code?.entity?.id || payload?.payload?.payment?.entity?.qr_code_id;
  const provider = configuredPaymentProvider();
  if (qrCodeId && !provider) return res.status(503).json({ error: { code: "PAYMENT_PROVIDER_UNCONFIGURED", message: "Test payment verification is unavailable; retry the webhook after configuration." } });
  try {
    const pending = qrCodeId && provider ? await query<{ id: string; amount_paise: string; provider_reference: string }>(
      "SELECT id,amount_paise::text,provider_reference FROM shared_cart_payments WHERE provider='razorpay' AND provider_reference=$1 AND status IN ('pending','expired')", [qrCodeId]) : { rows: [] } as any;
    const verified: Array<{ id: string; status: "paid" | "failed"; paymentId?: string }> = [];
    for (const payment of pending.rows) {
      const status = await provider!.verifyQrPayment(payment.provider_reference, Number(payment.amount_paise));
      if (status.status === "paid" || status.status === "failed") verified.push({ id: payment.id, status: status.status, paymentId: status.paymentId });
    }
    const duplicate = await inTransaction(async client => {
      const received = await client.query("INSERT INTO payment_webhook_events(provider,event_id,event_type,entity_id) VALUES('razorpay',$1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id", [eventId, eventType || "unknown", typeof qrCodeId === "string" ? qrCodeId : null]);
      if (!received.rowCount) return true;
      const cartIds = new Set<string>();
      for (const payment of verified) {
        const updated = await client.query<{ cart_id: string }>("UPDATE shared_cart_payments SET status=$2,provider_payment_id=$3,updated_at=now() WHERE id=$1 AND status IN ('pending','expired') RETURNING cart_id", [payment.id, payment.status, payment.paymentId || null]);
        if (updated.rowCount) {
          cartIds.add(updated.rows[0].cart_id);
          await client.query("INSERT INTO shared_cart_events(cart_id,event_type,payload) VALUES($1,'payment_status_updated',$2)", [updated.rows[0].cart_id, JSON.stringify({ paymentId: payment.id, status: payment.status })]);
        }
      }
      for (const cartId of cartIds) {
        const changed = await client.query<{ state: string }>(`UPDATE shared_carts c SET state=CASE
        WHEN (SELECT count(*) FROM shared_cart_payments p WHERE p.cart_id=c.id AND p.allocation_version=c.version AND p.status='paid') >= jsonb_array_length(a.breakdown->'shares') THEN 'ready_for_checkout'
        WHEN EXISTS(SELECT 1 FROM shared_cart_payments p WHERE p.cart_id=c.id AND p.allocation_version=c.version AND p.status='paid') THEN 'partially_paid'
        ELSE 'payment_failed' END,updated_at=now()
        FROM shared_cart_allocations a WHERE c.id=$1 AND a.cart_id=c.id AND a.version=c.version AND c.state IN ('awaiting_payments','partially_paid','payment_failed') RETURNING c.state`, [cartId]);
        if (changed.rowCount) await client.query("INSERT INTO shared_cart_events(cart_id,event_type,payload) VALUES($1,'cart_status_changed',$2)", [cartId, JSON.stringify({ state: changed.rows[0].state })]);
      }
      await client.query("UPDATE payment_webhook_events SET processing_status=$2,processed_at=now() WHERE provider='razorpay' AND event_id=$1", [eventId, verified.length ? "processed" : "ignored"]);
      return false;
    });
    return res.status(duplicate ? 200 : 202).json({ received: true, duplicate });
  } catch {
    // Return non-2xx so Razorpay retries when durable receipt or authoritative verification is unavailable.
    return res.status(503).json({ error: { code: "WEBHOOK_PROCESSING_UNAVAILABLE", message: "Payment status could not be verified or recorded." } });
  }
});
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use("/api/auth", authRouter);
app.use("/api/customer", customerRouter);
app.use("/api/shared-carts", sharedCartRouter);
app.use("/api/smartmeal", smartmealRouter);
app.use("/api/admin", authenticate, requireAdmin);

// Demo friends are client-side identities, so their per-person test QRs are
// generated without creating or impersonating customer accounts. This route
// remains test-only because configuredPaymentProvider rejects all live keys.
app.post("/api/demo-payments/qrs", authenticate, requireCsrf, async (req, res) => {
  const provider = configuredPaymentProvider();
  if (!provider) return res.status(503).json({ error: { code: "TEST_PAYMENTS_UNCONFIGURED", message: "Per-person demo QRs require Razorpay test credentials and PAYMENT_ENV=test. Live payments are disabled." } });
  const participants = req.body?.participants;
  if (!Array.isArray(participants) || participants.length < 1 || participants.length > 3) {
    return res.status(400).json({ error: { code: "INVALID_DEMO_PARTICIPANTS", message: "Provide one to three demo participants." } });
  }
  if (participants.some((person: any) => !person || typeof person.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(person.id)
    || typeof person.name !== "string" || !person.name.trim() || person.name.trim().length > 80
    || !Number.isSafeInteger(person.amountPaise) || person.amountPaise <= 0 || person.amountPaise > 100_000_000)) {
    return res.status(400).json({ error: { code: "INVALID_DEMO_SHARE", message: "Each participant needs a name and positive amount in paise." } });
  }
  const payments = [];
  for (const participant of participants as Array<{ id: string; name: string; amountPaise: number }>) {
    try {
      const qr = await provider.createSingleUseUpiQr({
        amountPaise: participant.amountPaise,
        description: `FoodLens demo share for ${participant.name.trim()}`,
        paymentRequestId: randomUUID(),
      });
      payments.push({ participantId: participant.id, name: participant.name.trim(), amountPaise: qr.amountPaise, imageUrl: qr.imageUrl, status: "created" });
    } catch {
      payments.push({ participantId: participant.id, name: participant.name.trim(), amountPaise: participant.amountPaise, imageUrl: null, status: "failed", error: "Test QR generation failed." });
    }
  }
  return res.json({ payments });
});

async function proxyPython(req: Request, res: Response, endpoint: string, method: "GET" | "POST" = "GET") {
  const target = new URL(endpoint, `${pythonApiBase}/`);
  if (method === "GET") target.search = new URL(req.originalUrl, "http://foodlens.local").search;

  try {
    const upstream = await fetch(target, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(pythonTimeoutMs),
    });
    const body: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const detail = typeof body === "object" && body !== null && "detail" in body && typeof body.detail === "string"
        ? body.detail
        : typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string"
          ? body.error.message
          : "Python service request failed";
      return res.status(upstream.status).json({ error: { code: "PYTHON_SERVICE_ERROR", message: detail } });
    }
    if (typeof body === "object" && body !== null && (endpoint === "/api/meta" || endpoint.startsWith("/api/admin/"))) {
      return res.status(upstream.status).json({ ...body, mutationsEnabled: adminMutationsEnabled, ...(endpoint === "/api/meta" ? { adminDemoEnabled: adminMutationsEnabled } : {}) });
    }
    return res.status(upstream.status).json(body);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return res.status(503).json({ error: {
      code: timedOut ? "PYTHON_SERVICE_TIMEOUT" : "PYTHON_SERVICE_UNAVAILABLE",
      message: timedOut ? "The Python data service timed out" : "The Python data service is unavailable",
    } });
  }
}

app.get("/", (_req, res) => res.json({ name: "FoodLens API", docs: "See README.md", health: "/api/health" }));

app.get("/api/health", async (req, res) => {
  const localHealth = { express: "ok", python: "unavailable", accounts: databaseConfigured() ? "configured" : "unconfigured", status: "degraded" };
  try {
    const response = await fetch(`${pythonApiBase}/api/health`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return res.status(503).json(localHealth);
    const body = await response.json() as { status?: string };
    return res.status(200).json({ express: "ok", python: body.status === "ok" ? "ok" : "degraded", accounts: databaseConfigured() ? "configured" : "unconfigured", status: body.status === "ok" ? "ok" : "degraded" });
  } catch {
    return res.status(503).json(localHealth);
  }
});

app.get("/api/meta", (req, res) => proxyPython(req, res, "/api/meta"));
// Keep the existing Python-backed search route and its query contract intact.
app.get("/api/search", (req, res) => proxyPython(req, res, "/api/search"));
app.get("/api/restaurants/:id", (req, res) => proxyPython(req, res, `/api/restaurants/${encodeURIComponent(req.params.id)}`));
app.post("/api/compare", (req, res) => proxyPython(req, res, "/api/compare", "POST"));
app.get("/api/intelligence/recommendations", (req, res) => proxyPython(req, res, "/api/intelligence/recommendations"));
app.get("/api/intelligence/review-signals", (req, res) => proxyPython(req, res, "/api/intelligence/review-signals"));

app.get("/api/admin/review-queue", (req, res) => proxyPython(req, res, "/api/admin/review-queue"));
app.get("/api/admin/pipeline", (req, res) => proxyPython(req, res, "/api/admin/pipeline"));
app.post("/api/admin/review-queue/:id/decision", (req, res) => {
  if (!adminMutationsEnabled) {
    return res.status(403).json({ error: { code: "ADMIN_DEMO_DISABLED", message: "Demo review decisions are disabled. Enable them only in local development." } });
  }
  return proxyPython(req, res, `/api/admin/review-queue/${encodeURIComponent(req.params.id)}/decision`, "POST");
});

app.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const badJson = err instanceof SyntaxError && "body" in err;
  res.status(badJson ? 400 : 500).json({ error: {
    code: badJson ? "INVALID_JSON" : "INTERNAL_ERROR",
    message: badJson ? "Request body must be valid JSON" : "Unexpected server error",
  } });
});

app.listen(port, host, () => console.log(`FoodLens API listening on http://${host}:${port}`));
