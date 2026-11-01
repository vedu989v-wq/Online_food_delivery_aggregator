import express, { type Request, type Response } from "express";
import { createHash } from "node:crypto";
import cors from "cors";
import { authAllowedOrigins, authRouter, authenticate, requireAdmin, requireCsrf } from "./auth-routes.js";
import { customerRouter } from "./customer-routes.js";
import { sharedCartRouter } from "./shared-cart-routes.js";
import { smartmealRouter } from "./smartmeal-routes.js";
import { databaseConfigured, inTransaction, query } from "./db.js";
import { configuredPaymentProvider, verifyRazorpayWebhook } from "./payment-provider.js";
import { createParticipantQr } from "./demo-payment-qr.js";

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
const smartMealEnrichmentLimits = new Map<string, { window: number; count: number }>();

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
      const qr = await createParticipantQr(provider, participant);
      payments.push({ participantId: participant.id, name: participant.name.trim(), ...qr });
    } catch {
      payments.push({ participantId: participant.id, name: participant.name.trim(), amountPaise: participant.amountPaise, imageUrl: null, status: "failed", error: "QR image generation failed. Please retry." });
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
async function enrichSmartMealItem(item: { dishKey: string; dishName: string; description: string }, token: string, force: boolean, actor: string) {
  try {
    const now = Date.now();
    const previous = smartMealEnrichmentLimits.get(actor);
    if (previous && now - previous.window < 60_000 && previous.count >= 5) return { status: 429, body: { error: { code: "ENRICHMENT_RATE_LIMIT", message: "Wait a minute before starting more enrichments." } } };
    smartMealEnrichmentLimits.set(actor, !previous || now - previous.window >= 60_000 ? { window: now, count: 1 } : { ...previous, count: previous.count + 1 });
    const { dishKey, dishName } = item;
    const { description } = item;
    const sourceHash = createHash("sha256").update(`${dishName.trim()}\n${description}\nsmartmeal-nutrition-v1`).digest("hex");
    const cached = await query(`SELECT dish_key AS "itemId",dish_name AS "dishName",serving_size_g AS "servingSizeG",calories_kcal AS "caloriesKcal",protein_g AS "proteinG",carbohydrates_g AS "carbohydratesG",fat_g AS "fatG",fiber_g AS "fiberG",sodium_mg AS "sodiumMg",source_name AS "sourceName",source_reference AS "sourceReference",estimation_method AS "estimationMethod",confidence_level AS "confidenceLevel",verification_status AS "verificationStatus",nutrition_metadata AS "nutritionMetadata",review_status AS "reviewStatus" FROM nutrition_records WHERE dish_key=$1`, [dishKey]);
    if (cached.rows[0] && cached.rows[0].verificationStatus !== "approximate") return { status: 409, body: { error: { code: "VERIFIED_NUTRITION_PROTECTED", message: "A documented nutrition record exists and cannot be replaced by a Gemini estimate." } } };
    if (!force) {
      if (cached.rows[0]?.reviewStatus === "rejected") return { status: 409, body: { error: { code: "ESTIMATE_PREVIOUSLY_REJECTED", message: "This estimate was rejected; explicitly set force=true to request another estimate." } } };
      if (cached.rows[0]?.nutritionMetadata?.sourceHash === sourceHash) return { status: 200, body: { saved: true, cached: true, nutrition: cached.rows[0] } };
    }
    const pythonBase = (process.env.PYTHON_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
    const response = await fetch(`${pythonBase}/api/smartmeal/nutrition/enrich`, {
      method: "POST", headers: { "content-type": "application/json", "x-smartmeal-token": token },
      body: JSON.stringify({ dish_key: dishKey, dish_name: dishName.trim(), description }), signal: AbortSignal.timeout(20_000),
    });
    const estimate = await response.json().catch(() => null) as any;
    if (!response.ok || !estimate || estimate.status !== "estimated") {
      return { status: response.status === 429 ? 429 : 503, body: { error: { code: "ENRICHMENT_UNAVAILABLE", message: "The dish could not be estimated. No nutrition record was saved." }, result: estimate?.status === "unavailable" ? estimate : undefined } };
    }
    await query(`INSERT INTO nutrition_records(dish_key,dish_name,serving_size_g,calories_kcal,protein_g,carbohydrates_g,fat_g,fiber_g,sodium_mg,source_name,source_reference,estimation_method,confidence_level,verification_status,nutrition_metadata,source_menu_key,review_status,last_updated)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'approximate',$14::jsonb,$1,'pending',now())
      ON CONFLICT(dish_key) DO UPDATE SET dish_name=excluded.dish_name,serving_size_g=excluded.serving_size_g,calories_kcal=excluded.calories_kcal,protein_g=excluded.protein_g,carbohydrates_g=excluded.carbohydrates_g,fat_g=excluded.fat_g,fiber_g=excluded.fiber_g,sodium_mg=excluded.sodium_mg,source_name=excluded.source_name,source_reference=excluded.source_reference,estimation_method=excluded.estimation_method,confidence_level=excluded.confidence_level,verification_status='approximate',nutrition_metadata=excluded.nutrition_metadata,source_menu_key=excluded.source_menu_key,review_status='pending',reviewed_by=NULL,reviewed_at=NULL,last_updated=now()`,
    [dishKey, estimate.dish_name, estimate.serving_size_g, estimate.calories_kcal, estimate.protein_g, estimate.carbohydrates_g, estimate.fat_g, estimate.fiber_g, estimate.sodium_mg,
      "Gemini-assisted estimate", `FoodLens menu key ${dishKey}`, "Gemini ingredient and portion estimate; not independently verified", estimate.confidence === "medium" ? "medium" : "low", JSON.stringify({ ingredients: estimate.ingredients, assumptions: estimate.assumptions, uncertainties: estimate.uncertainties, model: estimate.model, promptVersion: estimate.prompt_version, sourceHash })]);
    return { status: 200, body: { saved: true, reviewStatus: "pending", nutrition: estimate } };
  } catch {
    return { status: 503, body: { error: { code: "ENRICHMENT_UNAVAILABLE", message: "Enrichment failed and no nutrition record was saved." } } };
  }
}
app.post("/api/admin/smartmeal/nutrition/enrich", requireCsrf, async (req, res) => {
  const { dishKey, dishName } = req.body ?? {};
  const description = req.body?.description ?? "";
  if (typeof dishKey !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(dishKey) || typeof dishName !== "string" || !dishName.trim() || dishName.length > 160 || typeof description !== "string" || description.length > 800) {
    return res.status(400).json({ error: { code: "INVALID_NUTRITION_ITEM", message: "Provide a valid menu key, dish name, and description." } });
  }
  const token = process.env.SMARTMEAL_INTERNAL_TOKEN;
  if (!token || !databaseConfigured()) return res.status(503).json({ error: { code: "SMARTMEAL_NOT_CONFIGURED", message: "SmartMeal enrichment requires its private token and database." } });
  const result = await enrichSmartMealItem({ dishKey, dishName: dishName.trim(), description }, token, req.body?.force === true, (req as any).auth?.id ?? req.ip ?? "admin");
  return res.status(result.status).json(result.body);
});
app.post("/api/admin/smartmeal/nutrition/enrich-batch", requireCsrf, async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 5 || items.some((item: any) => !item || typeof item.dishKey !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(item.dishKey) || typeof item.dishName !== "string" || !item.dishName.trim() || item.dishName.length > 160 || (item.description != null && (typeof item.description !== "string" || item.description.length > 800))) || new Set(items.map((item: any) => item.dishKey)).size !== items.length) {
    return res.status(400).json({ error: { code: "INVALID_NUTRITION_BATCH", message: "Provide 1–5 unique menu items with valid names and descriptions." } });
  }
  const token = process.env.SMARTMEAL_INTERNAL_TOKEN;
  if (!token || !databaseConfigured()) return res.status(503).json({ error: { code: "SMARTMEAL_NOT_CONFIGURED", message: "SmartMeal enrichment requires its private token and database." } });
  const actor = (req as any).auth?.id ?? req.ip ?? "admin";
  const results = [];
  for (const item of items as Array<{ dishKey: string; dishName: string; description?: string }>) {
    const result = await enrichSmartMealItem({ dishKey: item.dishKey, dishName: item.dishName.trim(), description: item.description ?? "" }, token, req.body?.force === true, actor);
    results.push({ dishKey: item.dishKey, status: result.status, ...result.body });
    if (result.status === 429) break;
  }
  return res.status(results.some(result => result.status >= 500) ? 207 : 200).json({ results });
});
app.get("/api/admin/smartmeal/nutrition/pending", async (_req, res) => {
  try {
    const pending = await query(`SELECT dish_key AS "itemId",dish_name AS "dishName",serving_size_g AS "servingSizeG",calories_kcal AS "caloriesKcal",protein_g AS "proteinG",carbohydrates_g AS "carbohydratesG",fat_g AS "fatG",fiber_g AS "fiberG",sodium_mg AS "sodiumMg",source_name AS "sourceName",source_reference AS "sourceReference",confidence_level AS "confidenceLevel",nutrition_metadata AS "nutritionMetadata",last_updated AS "createdAt" FROM nutrition_records WHERE review_status='pending' ORDER BY last_updated LIMIT 100`);
    return res.json({ records: pending.rows });
  } catch { return res.status(503).json({ error: { code: "NUTRITION_REVIEW_UNAVAILABLE", message: "Pending nutrition estimates could not be loaded." } }); }
});
app.post("/api/admin/smartmeal/nutrition/:dishKey/review", requireCsrf, async (req, res) => {
  const dishKey = req.params.dishKey;
  const decision = req.body?.decision;
  if (typeof dishKey !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(dishKey) || !["approve", "reject"].includes(decision)) return res.status(400).json({ error: { code: "INVALID_NUTRITION_REVIEW", message: "Choose approve or reject for a valid dish key." } });
  try {
    const reviewStatus = decision === "approve" ? "approved" : "rejected";
    const result = await query(`UPDATE nutrition_records SET review_status=$2,reviewed_by=$3,reviewed_at=now(),last_updated=now() WHERE dish_key=$1 AND verification_status='approximate' AND review_status='pending' RETURNING dish_key`, [dishKey, reviewStatus, (req as any).auth.id]);
    if (!result.rowCount) return res.status(404).json({ error: { code: "PENDING_ESTIMATE_NOT_FOUND", message: "No pending Gemini estimate exists for this dish." } });
    return res.json({ dishKey, reviewStatus });
  } catch { return res.status(503).json({ error: { code: "NUTRITION_REVIEW_UNAVAILABLE", message: "The nutrition review could not be saved." } }); }
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
