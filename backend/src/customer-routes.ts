import { Router, type Request, type RequestHandler, type Response } from "express";
import { authenticate, requireCsrf, type AuthenticatedRequest } from "./auth-routes.js";
import { inTransaction, query } from "./db.js";

const router = Router();
const priorities = new Set(["value", "cheapest", "fastest", "reliable", "rated"]);
const eventTypes = new Set(["restaurant_viewed", "restaurant_saved", "comparison_requested", "recommendation_selected", "filter_selected"]);
const restaurantIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

function dbFail(res: Response) { return fail(res, 503, "CUSTOMER_DATA_UNAVAILABLE", "Customer data is temporarily unavailable."); }

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim().replace(/\s+/g, " ");
  return result.length > 0 && result.length <= max ? result : null;
}

function validateProfile(body: any) {
  const city = body.city == null || body.city === "" ? null : cleanText(body.city, 100);
  const area = body.area == null || body.area === "" ? null : cleanText(body.area, 100);
  const cuisines = body.preferredCuisines;
  const preferredCuisines = Array.isArray(cuisines) && cuisines.length <= 8
    ? [...new Set(cuisines.map((item: unknown) => cleanText(item, 40)).filter((item: string | null): item is string => Boolean(item)))]
    : null;
  const budget = body.budgetPerPerson == null || body.budgetPerPerson === "" ? null : Number(body.budgetPerPerson);
  const priority = body.priority ?? "value";
  const vegetarianOnly = body.vegetarianOnly;
  const interactionConsent = body.interactionConsent;
  if ((body.city != null && body.city !== "" && !city) || (body.area != null && body.area !== "" && !area)
    || preferredCuisines === null || (budget !== null && (!Number.isFinite(budget) || budget <= 0 || budget > 1_000_000))
    || !priorities.has(priority) || typeof vegetarianOnly !== "boolean" || typeof interactionConsent !== "boolean") return null;
  return { city, area, preferredCuisines, budget, priority, vegetarianOnly, interactionConsent };
}

async function getRestaurantFromPython(id: string): Promise<string[] | null> {
  const pythonBase = (process.env.PYTHON_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
  try {
    const response = await fetch(`${pythonBase}/api/restaurants/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const body = await response.json() as { cuisines?: unknown };
    return Array.isArray(body.cuisines) ? body.cuisines.filter((value): value is string => typeof value === "string").slice(0, 8) : [];
  } catch { return null; }
}

async function proxyRecommendations(req: AuthenticatedRequest, res: Response, next: (error?: unknown) => void) {
  const auth = req.auth!;
  const params = new URLSearchParams({
    limit: "12",
    people: "1",
    priority: auth.priority,
    vegetarian: String(auth.vegetarianOnly),
  });
  if (auth.budgetPerPerson != null) params.set("budgetPerPerson", String(auth.budgetPerPerson));
  if (auth.preferredCuisines?.length) params.set("cuisine", auth.preferredCuisines[0]);
  if (auth.city) params.set("city", auth.city);
  if (auth.area) params.set("area", auth.area);
  if (auth.interactionConsent) {
    try {
      const signals = await query<{ cuisine: string; count: string }>(
        `SELECT cuisine, count(*)::text AS count FROM customer_interaction_events
         WHERE user_id=$1 AND created_at >= now() - interval '90 days' AND cuisine IS NOT NULL
         GROUP BY lower(cuisine), cuisine HAVING count(*) >= 3 ORDER BY count(*) DESC LIMIT 5`, [auth.id]);
      const total = signals.rows.reduce((sum, item) => sum + Number(item.count), 0);
      if (total >= 3) params.set("behaviorSignals", JSON.stringify(signals.rows.map(item => ({ cuisine: item.cuisine, count: Number(item.count) }))));
    } catch {
      // A failed optional behavior query falls back to the explicit preference ranking below.
    }
  }
  const pythonBase = (process.env.PYTHON_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
  try {
    const response = await fetch(`${pythonBase}/api/intelligence/recommendations?${params}`, { signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => null);
    if (!response.ok) return res.status(response.status).json({ error: { code: "RECOMMENDATIONS_UNAVAILABLE", message: "Recommendations could not be loaded right now." } });
    return res.json(body);
  } catch { return res.status(503).json({ error: { code: "RECOMMENDATIONS_UNAVAILABLE", message: "The recommendation service is temporarily unavailable." } }); }
}

router.use(authenticate);

router.get("/profile", (req: AuthenticatedRequest, res) => {
  const { id, email, displayName, role, city, area, preferredCuisines, vegetarianOnly, budgetPerPerson, priority, interactionConsent } = req.auth!;
  return res.json({ id, email, displayName, role, profile: { city, area, preferredCuisines, vegetarianOnly, budgetPerPerson, priority, interactionConsent } });
});

router.patch("/profile", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const profile = validateProfile(req.body);
  if (!profile) return fail(res, 400, "INVALID_PROFILE", "Check the selected location and preference values.");
  try {
    await inTransaction(async client => {
      await client.query(`UPDATE customer_profiles SET city=$2, area=$3, preferred_cuisines=$4,
        vegetarian_only=$5, budget_per_person=$6, priority=$7, interaction_consent=$8, updated_at=now()
        WHERE user_id=$1`, [req.auth!.id, profile.city, profile.area, profile.preferredCuisines, profile.vegetarianOnly, profile.budget, profile.priority, profile.interactionConsent]);
      if (!profile.interactionConsent) {
        await client.query("DELETE FROM customer_interaction_events WHERE user_id=$1", [req.auth!.id]);
      }
    });
    return res.json({ profile });
  } catch { return dbFail(res); }
});

router.get("/saved-restaurants", async (req: AuthenticatedRequest, res) => {
  try {
    const result = await query<{ restaurant_id: string; created_at: Date }>("SELECT restaurant_id, created_at FROM saved_restaurants WHERE user_id=$1 ORDER BY created_at DESC", [req.auth!.id]);
    return res.json({ restaurants: result.rows.map(row => ({ id: row.restaurant_id, savedAt: row.created_at })) });
  } catch { return dbFail(res); }
});

router.post("/saved-restaurants", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.body?.restaurantId;
  if (typeof id !== "string" || !restaurantIdPattern.test(id)) return fail(res, 400, "INVALID_RESTAURANT", "Choose a valid restaurant from FoodLens search.");
  const cuisines = await getRestaurantFromPython(id);
  if (!cuisines) return fail(res, 404, "RESTAURANT_NOT_FOUND", "That restaurant is not in the current FoodLens dataset.");
  try {
    const result = await query("INSERT INTO saved_restaurants(user_id, restaurant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING restaurant_id", [req.auth!.id, id]);
    if (req.auth!.interactionConsent && result.rowCount && cuisines[0]) {
      await query("INSERT INTO customer_interaction_events(user_id,event_type,restaurant_id,cuisine) VALUES ($1,'restaurant_saved',$2,$3)", [req.auth!.id, id, cuisines[0]]);
    }
    return res.status(result.rowCount ? 201 : 200).json({ id, saved: true });
  } catch { return dbFail(res); }
});

router.delete("/saved-restaurants/:restaurantId", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.restaurantId;
  if (typeof id !== "string" || !restaurantIdPattern.test(id)) return fail(res, 400, "INVALID_RESTAURANT", "Choose a valid restaurant.");
  try {
    await query("DELETE FROM saved_restaurants WHERE user_id=$1 AND restaurant_id=$2", [req.auth!.id, id]);
    return res.status(204).end();
  } catch { return dbFail(res); }
});

router.get("/recommendations", (req: AuthenticatedRequest, res, next) => proxyRecommendations(req, res, next));

router.post("/interactions", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const eventType = req.body?.eventType;
  const restaurantId = req.body?.restaurantId == null ? null : req.body.restaurantId;
  const cuisine = req.body?.cuisine == null ? null : cleanText(req.body.cuisine, 40);
  if (!req.auth!.interactionConsent) return fail(res, 403, "CONSENT_REQUIRED", "Turn on optional personalization tracking in your preferences first.");
  if (typeof eventType !== "string" || !eventTypes.has(eventType) || (restaurantId !== null && (typeof restaurantId !== "string" || !restaurantIdPattern.test(restaurantId))) || (req.body?.cuisine != null && !cuisine)) {
    return fail(res, 400, "INVALID_INTERACTION", "This interaction cannot be recorded.");
  }
  try {
    await query("INSERT INTO customer_interaction_events(user_id,event_type,restaurant_id,cuisine) VALUES ($1,$2,$3,$4)", [req.auth!.id, eventType, restaurantId, cuisine]);
    return res.status(202).json({ recorded: true });
  } catch { return dbFail(res); }
});

export const customerRouter = router;
