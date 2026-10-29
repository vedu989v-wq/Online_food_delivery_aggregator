import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, clearSessionCookie, hashPassword, newOpaqueToken, normalizeEmail, parseCookie, requestOriginAllowed, sessionCookie, tokenHash, validDisplayName, validPassword, verifyPassword } from "./auth.js";
import { inTransaction, query } from "./db.js";

export interface AuthContext {
  id: string;
  email: string;
  displayName: string;
  role: "customer" | "admin";
  city: string | null;
  area: string | null;
  preferredCuisines: string[];
  vegetarianOnly: boolean;
  budgetPerPerson: number | null;
  priority: "value" | "cheapest" | "fastest" | "reliable" | "rated";
  interactionConsent: boolean;
  tokenHash: string;
  csrfHash: string;
}

export interface AuthenticatedRequest extends Request { auth?: AuthContext }

const router = Router();
const dummyHash = hashPassword("not-a-real-customer-account-password");
const attempts = new Map<string, { started: number; count: number }>();

function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173")
    .split(",").map(value => value.trim()).filter(Boolean).map(value => {
      try { return new URL(value).origin; } catch { return ""; }
    }).filter(Boolean);
}

function databaseUnavailable(res: Response): void {
  res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Customer accounts are not configured yet. Please try again later." } });
}

function authError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function rateLimit(key: string, max = 10): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    const identity = `${key}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    let window = attempts.get(identity);
    if (!window || now - window.started >= 15 * 60_000) {
      window = { started: now, count: 0 };
      attempts.set(identity, window);
    }
    window.count += 1;
    if (window.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((window.started + 15 * 60_000 - now) / 1000)));
      return authError(res, 429, "RATE_LIMITED", "Too many attempts. Wait a little and try again.");
    }
    if (attempts.size > 5000) {
      for (const [entry, value] of attempts) if (now - value.started >= 15 * 60_000) attempts.delete(entry);
    }
    next();
  };
}

async function findSession(token: string): Promise<AuthContext | null> {
  const result = await query<AuthContext>(
    `SELECT u.id, u.email, u.display_name AS "displayName", u.role,
      p.city, p.area, p.preferred_cuisines AS "preferredCuisines",
      p.vegetarian_only AS "vegetarianOnly", p.budget_per_person AS "budgetPerPerson",
      p.priority, p.interaction_consent AS "interactionConsent",
      s.token_hash AS "tokenHash", s.csrf_hash AS "csrfHash"
     FROM customer_sessions s
     JOIN customer_users u ON u.id = s.user_id
     JOIN customer_profiles p ON p.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash(token)],
  );
  return result.rows[0] || null;
}

export const authenticate: RequestHandler = async (req: AuthenticatedRequest, res, next) => {
  const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
  if (!token) return authError(res, 401, "AUTH_REQUIRED", "Sign in to access this feature.");
  try {
    const auth = await findSession(token);
    if (!auth) {
      res.setHeader("Set-Cookie", clearSessionCookie(process.env.NODE_ENV === "production"));
      return authError(res, 401, "SESSION_EXPIRED", "Your session expired. Please sign in again.");
    }
    req.auth = auth;
    next();
  } catch (error) {
    if (error instanceof Error && error.message === "DATABASE_UNAVAILABLE") return databaseUnavailable(res);
    return authError(res, 503, "CUSTOMER_DATA_UNAVAILABLE", "Customer data is temporarily unavailable.");
  }
};

export const requireCsrf: RequestHandler = (req: AuthenticatedRequest, res, next) => {
  const origin = req.get("origin");
  const supplied = req.get("x-csrf-token") || "";
  if (!requestOriginAllowed(origin, allowedOrigins())) return authError(res, 403, "ORIGIN_REJECTED", "This request origin is not allowed.");
  if (!req.auth || !/^[a-f0-9]{64}$/.test(req.auth.csrfHash) || supplied.length < 32) return authError(res, 403, "CSRF_REJECTED", "Refresh the page and try again.");
  const suppliedHash = tokenHash(supplied);
  const a = Buffer.from(suppliedHash, "hex");
  const b = Buffer.from(req.auth.csrfHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return authError(res, 403, "CSRF_REJECTED", "Refresh the page and try again.");
  next();
};

export const requireAdmin: RequestHandler = (req: AuthenticatedRequest, res, next) => {
  if (req.auth?.role !== "admin") return authError(res, 403, "ADMIN_REQUIRED", "Administrator access is required.");
  next();
};

function publicUser(auth: AuthContext) {
  return { id: auth.id, email: auth.email, displayName: auth.displayName, role: auth.role,
    profile: { city: auth.city, area: auth.area, preferredCuisines: auth.preferredCuisines || [],
      vegetarianOnly: auth.vegetarianOnly, budgetPerPerson: auth.budgetPerPerson == null ? null : Number(auth.budgetPerPerson),
      priority: auth.priority, interactionConsent: auth.interactionConsent } };
}

async function createSession(userId: string): Promise<{ token: string; csrf: string }> {
  const token = newOpaqueToken();
  const csrf = newOpaqueToken();
  await query(`INSERT INTO customer_sessions(token_hash, csrf_hash, user_id, expires_at)
    VALUES ($1, $2, $3, now() + ($4 * interval '1 second'))`,
  [tokenHash(token), tokenHash(csrf), userId, SESSION_MAX_AGE_SECONDS]);
  return { token, csrf };
}

async function sessionUser(userId: string): Promise<AuthContext> {
  const result = await query<AuthContext>(
    `SELECT u.id, u.email, u.display_name AS "displayName", u.role,
      p.city, p.area, p.preferred_cuisines AS "preferredCuisines",
      p.vegetarian_only AS "vegetarianOnly", p.budget_per_person AS "budgetPerPerson",
      p.priority, p.interaction_consent AS "interactionConsent", '' AS "tokenHash", '' AS "csrfHash"
     FROM customer_users u JOIN customer_profiles p ON p.user_id = u.id WHERE u.id = $1`, [userId]);
  return result.rows[0];
}

router.post("/register", rateLimit("register", 5), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const displayName = validDisplayName(req.body?.displayName);
  const password = req.body?.password;
  if (!email || !displayName || !validPassword(password)) {
    return authError(res, 400, "INVALID_REGISTRATION", "Enter a valid email, a name up to 80 characters, and a password between 10 and 128 characters.");
  }
  try {
    const passwordHash = await hashPassword(password);
    const user = await inTransaction(async client => {
      const created = await client.query<{ id: string }>(
        "INSERT INTO customer_users(email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [email, displayName, passwordHash]);
      const id = created.rows[0].id;
      await client.query("INSERT INTO customer_profiles(user_id) VALUES ($1)", [id]);
      return id;
    });
    const session = await createSession(user);
    const auth = await sessionUser(user);
    res.setHeader("Set-Cookie", sessionCookie(session.token, process.env.NODE_ENV === "production"));
    return res.status(201).json({ user: publicUser(auth), csrfToken: session.csrf });
  } catch (error) {
    if (error instanceof Error && error.message === "DATABASE_UNAVAILABLE") return databaseUnavailable(res);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return authError(res, 409, "EMAIL_IN_USE", "An account with this email already exists. Try signing in.");
    }
    return authError(res, 503, "REGISTRATION_UNAVAILABLE", "Could not create the account right now. Please try again later.");
  }
});

router.post("/login", rateLimit("login", 10), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!email || typeof password !== "string" || password.length > 128) return authError(res, 400, "INVALID_LOGIN", "Enter a valid email and password.");
  try {
    const result = await query<{ id: string; password_hash: string }>("SELECT id, password_hash FROM customer_users WHERE lower(email) = $1", [email]);
    const row = result.rows[0];
    const isMatch = await verifyPassword(password, row?.password_hash || await dummyHash);
    if (!row || !isMatch) return authError(res, 401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    await query("DELETE FROM customer_sessions WHERE user_id = $1 AND expires_at <= now()", [row.id]);
    const session = await createSession(row.id);
    const auth = await sessionUser(row.id);
    res.setHeader("Set-Cookie", sessionCookie(session.token, process.env.NODE_ENV === "production"));
    return res.json({ user: publicUser(auth), csrfToken: session.csrf });
  } catch (error) {
    if (error instanceof Error && error.message === "DATABASE_UNAVAILABLE") return databaseUnavailable(res);
    return authError(res, 503, "LOGIN_UNAVAILABLE", "Sign in is temporarily unavailable. Please try again later.");
  }
});

router.get("/me", authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const csrf = newOpaqueToken();
    await query("UPDATE customer_sessions SET csrf_hash = $1 WHERE token_hash = $2", [tokenHash(csrf), req.auth!.tokenHash]);
    const auth = await sessionUser(req.auth!.id);
    return res.json({ user: publicUser(auth), csrfToken: csrf });
  } catch {
    return authError(res, 503, "CUSTOMER_DATA_UNAVAILABLE", "Customer data is temporarily unavailable.");
  }
});

router.post("/logout", authenticate, requireCsrf, async (req: AuthenticatedRequest, res) => {
  try {
    await query("DELETE FROM customer_sessions WHERE token_hash = $1", [req.auth!.tokenHash]);
    res.setHeader("Set-Cookie", clearSessionCookie(process.env.NODE_ENV === "production"));
    return res.status(204).end();
  } catch {
    return authError(res, 503, "LOGOUT_UNAVAILABLE", "Sign out is temporarily unavailable. Please try again.");
  }
});

export const authRouter = router;
export const authAllowedOrigins = allowedOrigins;
