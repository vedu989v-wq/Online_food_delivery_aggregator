import express, { type Request, type Response } from "express";
import cors from "cors";
import { authAllowedOrigins, authRouter, authenticate, requireAdmin } from "./auth-routes.js";
import { customerRouter } from "./customer-routes.js";
import { databaseConfigured } from "./db.js";

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
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["content-type", "x-csrf-token"],
  maxAge: 600,
}));
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use("/api/auth", authRouter);
app.use("/api/customer", customerRouter);
app.use("/api/admin", authenticate, requireAdmin);

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
