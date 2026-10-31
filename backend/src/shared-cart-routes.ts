import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { Router, type Response } from "express";
import { authenticate, requireCsrf, type AuthenticatedRequest } from "./auth-routes.js";
import { inTransaction, query } from "./db.js";
import { tokenHash } from "./auth.js";

const router = Router();
const idPattern = /^[0-9a-f-]{36}$/i;
const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null;
const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
const key = () => {
  const raw = process.env.FOODLENS_PII_KEY || "";
  return /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : null;
};
function encryptAddress(value: string, secret: Buffer) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", secret, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}
function decryptAddress(value: string, secret: Buffer) {
  const [iv, tag, data] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
function addressFingerprint(value: string, secret: Buffer) {
  return createHmac("sha256", secret).update(value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()).digest("hex");
}
async function member(cartId: string, userId: string) {
  return query<{ role: string }>("SELECT role FROM shared_cart_members WHERE cart_id=$1 AND user_id=$2", [cartId, userId]);
}
async function loadCart(cartId: string, userId: string, res: Response) {
  const access = await member(cartId, userId);
  if (!access.rowCount) { fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable."); return null; }
  await query("UPDATE shared_carts SET state='expired',updated_at=now() WHERE id=$1 AND state='open' AND expires_at<=now()", [cartId]);
  const result = await query(`SELECT c.id,c.restaurant_id AS "restaurantId",c.restaurant_name AS "restaurantName",c.state,c.version,c.organizer_id AS "organizerId",c.address_ciphertext AS "addressCiphertext",c.address_confirmed_at AS "organizerConfirmedAt",c.created_at AS "createdAt",
    (SELECT json_agg(json_build_object('userId',u.id,'name',u.display_name,'role',m.role,'addressConfirmed',m.address_confirmed_at IS NOT NULL) ORDER BY m.joined_at) FROM shared_cart_members m JOIN customer_users u ON u.id=m.user_id WHERE m.cart_id=c.id) AS members,
    (SELECT json_agg(json_build_object('id',i.id,'itemId',i.item_id,'itemName',i.item_name,'ownerId',i.owner_id,'ownerName',u.display_name,'quantity',i.quantity) ORDER BY i.created_at) FROM shared_cart_items i JOIN customer_users u ON u.id=i.owner_id WHERE i.cart_id=c.id) AS items
    FROM shared_carts c WHERE c.id=$1`, [cartId]);
  const row = result.rows[0];
  if (row.addressCiphertext) {
    const secret = key();
    if (secret) row.address = decryptAddress(row.addressCiphertext, secret);
  }
  delete row.addressCiphertext;
  return row;
}
router.use(authenticate);

router.get("/", async (req: AuthenticatedRequest, res) => {
  try {
    await query("UPDATE shared_carts SET state='expired',updated_at=now() WHERE state='open' AND expires_at<=now()");
    const rows = await query(`SELECT c.id,c.restaurant_id AS "restaurantId",c.restaurant_name AS "restaurantName",c.state,c.version,c.created_at AS "createdAt",m.role,
      (SELECT count(*)::int FROM shared_cart_members x WHERE x.cart_id=c.id) AS "memberCount"
      FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE m.user_id=$1 AND c.state IN ('open','locked') ORDER BY c.updated_at DESC LIMIT 50`, [req.auth!.id]);
    return res.json({ carts: rows.rows });
  } catch { return fail(res, 503, "CARTS_UNAVAILABLE", "Shared carts are temporarily unavailable."); }
});

router.post("/", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const restaurantId = text(req.body?.restaurantId, 64);
  if (!restaurantId || !/^[\w-]+$/.test(restaurantId)) return fail(res, 400, "INVALID_RESTAURANT", "Choose a valid restaurant.");
  const base = (process.env.PYTHON_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
  let restaurant: { name?: string };
  try { const response = await fetch(`${base}/api/restaurants/${encodeURIComponent(restaurantId)}`, { signal: AbortSignal.timeout(7000) }); if (!response.ok) return fail(res, 404, "RESTAURANT_NOT_FOUND", "Restaurant is not available in the current dataset."); restaurant = await response.json() as { name?: string }; }
  catch { return fail(res, 503, "MENU_UNAVAILABLE", "Restaurant data is temporarily unavailable."); }
  try {
    const result = await inTransaction(async client => {
      const created = await client.query<{ id: string }>("INSERT INTO shared_carts(organizer_id,restaurant_id,restaurant_name) VALUES($1,$2,$3) RETURNING id", [req.auth!.id, restaurantId, text(restaurant.name, 160) || restaurantId]);
      const id = created.rows[0].id;
      await client.query("INSERT INTO shared_cart_members(cart_id,user_id,role) VALUES($1,$2,'organizer')", [id, req.auth!.id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'cart_created')", [id, req.auth!.id]);
      return id;
    });
    return res.status(201).json({ cart: await loadCart(result, req.auth!.id, res) });
  } catch { return fail(res, 503, "CART_CREATE_FAILED", "Could not create a shared cart."); }
});

router.get("/:cartId", async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId;
  if (typeof id !== "string" || !idPattern.test(id)) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
  try { const cart = await loadCart(id, req.auth!.id, res); return cart ? res.json({ cart }) : undefined; }
  catch { return fail(res, 503, "CART_UNAVAILABLE", "Shared cart is temporarily unavailable."); }
});

router.post("/:cartId/cancel", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId;
  if (typeof id !== "string" || !idPattern.test(id)) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
  try {
    const result = await inTransaction(async client => {
      const row = await client.query("SELECT state FROM shared_carts WHERE id=$1 AND organizer_id=$2 FOR UPDATE", [id, req.auth!.id]);
      if (!row.rowCount) return "missing";
      if (row.rows[0].state !== "open") return "closed";
      await client.query("UPDATE shared_carts SET state='cancelled',updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'cart_cancelled')", [id, req.auth!.id]);
      return "ok";
    });
    if (result === "missing") return fail(res, 404, "CART_NOT_FOUND", "Only the organizer can cancel this cart.");
    if (result === "closed") return fail(res, 409, "CART_NOT_OPEN", "This cart can no longer be cancelled.");
    return res.status(204).end();
  } catch { return fail(res, 503, "CART_CANCEL_FAILED", "Could not cancel this cart."); }
});

router.post("/:cartId/invitations", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId;
  if (typeof id !== "string" || !idPattern.test(id)) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
  const secretToken = randomBytes(32).toString("base64url");
  try {
    const created = await inTransaction(async client => {
      const cart = await client.query("SELECT state FROM shared_carts WHERE id=$1 AND organizer_id=$2 FOR UPDATE", [id, req.auth!.id]);
      if (!cart.rowCount || cart.rows[0].state !== "open") return false;
      await client.query("INSERT INTO shared_cart_invitations(cart_id,token_hash,invited_by,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')", [id, tokenHash(secretToken), req.auth!.id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'invitation_created')", [id, req.auth!.id]);
      return true;
    });
    if (!created) return fail(res, 409, "CART_NOT_OPEN", "Only the organizer can invite members to an open cart.");
    return res.status(201).json({ inviteToken: secretToken, expiresInHours: 24 });
  } catch { return fail(res, 503, "INVITATION_FAILED", "Could not create an invitation."); }
});

router.post("/join", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const invite = text(req.body?.inviteToken, 128);
  if (!invite || invite.length < 30) return fail(res, 400, "INVALID_INVITATION", "Enter a valid invitation link.");
  try {
    const cartId = await inTransaction(async client => {
      const found = await client.query<{ cart_id: string }>("SELECT cart_id FROM shared_cart_invitations i JOIN shared_carts c ON c.id=i.cart_id WHERE i.token_hash=$1 AND i.expires_at>now() AND i.accepted_at IS NULL AND c.state='open' AND c.expires_at>now() FOR UPDATE", [tokenHash(invite)]);
      if (!found.rowCount) return null;
      const id = found.rows[0].cart_id;
      await client.query("INSERT INTO shared_cart_members(cart_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING", [id, req.auth!.id]);
      await client.query("UPDATE shared_cart_invitations SET accepted_by=$2,accepted_at=now() WHERE token_hash=$1", [tokenHash(invite), req.auth!.id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'member_joined')", [id, req.auth!.id]);
      return id;
    });
    if (!cartId) return fail(res, 404, "INVITATION_EXPIRED", "This invitation is invalid, expired, or already used.");
    return res.json({ cart: await loadCart(cartId, req.auth!.id, res) });
  } catch { return fail(res, 503, "JOIN_FAILED", "Could not join this cart."); }
});

router.post("/:cartId/items", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const itemId = text(req.body?.itemId, 200); const quantity = Number(req.body?.quantity ?? 1);
  if (typeof id !== "string" || !idPattern.test(id) || !itemId || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return fail(res, 400, "INVALID_ITEM", "Choose a menu item and quantity from 1 to 20.");
  try {
    const cart = await query<{ restaurant_id: string; state: string }>("SELECT restaurant_id,state FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2", [id, req.auth!.id]);
    if (!cart.rowCount) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
    if (cart.rows[0].state !== "open") return fail(res, 409, "CART_LOCKED", "This cart is not open for changes.");
    const base = (process.env.PYTHON_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/restaurants/${encodeURIComponent(cart.rows[0].restaurant_id)}`, { signal: AbortSignal.timeout(7000) });
    if (!response.ok) return fail(res, 503, "MENU_UNAVAILABLE", "The menu could not be verified.");
    const detail = await response.json() as { items?: Array<{ id?: string; name?: string }> };
    const item = detail.items?.find(candidate => candidate.id === itemId);
    if (!item) return fail(res, 400, "ITEM_NOT_IN_MENU", "That item is not part of this cart's restaurant menu.");
    await inTransaction(async client => {
      await client.query("INSERT INTO shared_cart_items(cart_id,owner_id,item_id,item_name,quantity) VALUES($1,$2,$3,$4,$5)", [id, req.auth!.id, itemId, text(item.name, 200) || itemId, quantity]);
      await client.query("UPDATE shared_carts SET version=version+1,updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type,payload) VALUES($1,$2,'item_added',$3)", [id, req.auth!.id, JSON.stringify({ itemId, quantity })]);
    });
    return res.status(201).json({ cart: await loadCart(id, req.auth!.id, res) });
  } catch { return fail(res, 503, "ITEM_ADD_FAILED", "Could not add this item."); }
});

router.delete("/:cartId/items/:itemId", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const item = req.params.itemId;
  if (typeof id !== "string" || typeof item !== "string" || !idPattern.test(id) || !idPattern.test(item)) return fail(res, 404, "ITEM_NOT_FOUND", "This cart item is unavailable.");
  try {
    const removed = await inTransaction(async client => {
      const cart = await client.query("SELECT c.state FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2 FOR UPDATE", [id, req.auth!.id]);
      if (!cart.rowCount) return "missing";
      if (cart.rows[0].state !== "open") return "locked";
      const result = await client.query("DELETE FROM shared_cart_items WHERE cart_id=$1 AND id=$2 AND owner_id=$3", [id, item, req.auth!.id]);
      if (result.rowCount) { await client.query("UPDATE shared_carts SET version=version+1,updated_at=now() WHERE id=$1", [id]); await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'item_removed')", [id, req.auth!.id]); }
      return result.rowCount ? "ok" : "missing";
    });
    if (removed === "locked") return fail(res, 409, "CART_LOCKED", "This cart is not open for changes.");
    if (removed !== "ok") return fail(res, 404, "ITEM_NOT_FOUND", "Only the owner can remove this item.");
    return res.status(204).end();
  } catch { return fail(res, 503, "ITEM_REMOVE_FAILED", "Could not remove this item."); }
});

router.put("/:cartId/address", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const address = text(req.body?.address, 500);
  if (typeof id !== "string" || !idPattern.test(id) || !address || address.length < 8) return fail(res, 400, "INVALID_ADDRESS", "Enter a delivery address.");
  const secret = key(); if (!secret) return fail(res, 503, "ADDRESS_STORAGE_UNCONFIGURED", "Secure address storage is not configured. Set FOODLENS_PII_KEY to a random 32-byte hex key.");
  try {
    const state = await query<{ state: string }>("SELECT state FROM shared_carts WHERE id=$1 AND organizer_id=$2", [id, req.auth!.id]);
    if (!state.rowCount) return fail(res, 404, "CART_NOT_FOUND", "Only the organizer can set the address.");
    if (state.rows[0].state !== "open") return fail(res, 409, "CART_LOCKED", "Address cannot be changed after checkout lock.");
    await inTransaction(async client => {
      await client.query("UPDATE shared_carts SET address_ciphertext=$2,address_confirmed_at=now(),updated_at=now() WHERE id=$1", [id, encryptAddress(address, secret)]);
      await client.query("UPDATE shared_cart_members SET address_confirmed_at=NULL,address_fingerprint=NULL WHERE cart_id=$1", [id]);
      await client.query("UPDATE shared_cart_members SET address_confirmed_at=now(),address_fingerprint=$3 WHERE cart_id=$1 AND user_id=$2", [id, req.auth!.id, addressFingerprint(address, secret)]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'address_set')", [id, req.auth!.id]);
    });
    return res.json({ confirmed: true });
  } catch { return fail(res, 503, "ADDRESS_UPDATE_FAILED", "Could not save the delivery address."); }
});

router.post("/:cartId/address-confirmation", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const address = text(req.body?.address, 500);
  if (typeof id !== "string" || !idPattern.test(id) || !address || address.length < 8) return fail(res, 400, "INVALID_ADDRESS", "Enter the shared delivery address to confirm it.");
  const secret = key(); if (!secret) return fail(res, 503, "ADDRESS_STORAGE_UNCONFIGURED", "Secure address storage is not configured.");
  try {
    const result = await inTransaction(async client => {
      const row = await client.query<{ address_ciphertext: string | null; state: string }>("SELECT c.address_ciphertext,c.state FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2 FOR UPDATE", [id, req.auth!.id]);
      if (!row.rowCount) return "missing";
      if (row.rows[0].state !== "open" || !row.rows[0].address_ciphertext) return "unavailable";
      const organizerAddress = decryptAddress(row.rows[0].address_ciphertext, secret);
      if (addressFingerprint(organizerAddress, secret) !== addressFingerprint(address, secret)) return "mismatch";
      await client.query("UPDATE shared_cart_members SET address_confirmed_at=now(),address_fingerprint=$3 WHERE cart_id=$1 AND user_id=$2", [id, req.auth!.id, addressFingerprint(address, secret)]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'address_confirmed')", [id, req.auth!.id]);
      return "ok";
    });
    if (result === "missing") return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
    if (result === "mismatch") return fail(res, 409, "ADDRESS_MISMATCH", "The address does not match the organizer's delivery address.");
    if (result !== "ok") return fail(res, 409, "ADDRESS_UNAVAILABLE", "The organizer has not set an editable address for this cart.");
    return res.json({ confirmed: true });
  } catch { return fail(res, 503, "ADDRESS_CONFIRMATION_FAILED", "Could not confirm the address."); }
});

router.get("/:cartId/events", async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const after = Math.max(0, Number(req.query.after) || 0);
  if (typeof id !== "string" || !idPattern.test(id)) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
  try {
    if (!(await member(id, req.auth!.id)).rowCount) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
    const rows = await query("SELECT id,event_type AS type,payload,created_at AS " + '"createdAt"' + " FROM shared_cart_events WHERE cart_id=$1 AND id>$2 ORDER BY id LIMIT 100", [id, after]);
    return res.json({ events: rows.rows });
  } catch { return fail(res, 503, "EVENTS_UNAVAILABLE", "Shared cart updates are temporarily unavailable."); }
});

router.post("/:cartId/lock", requireCsrf, async (req: AuthenticatedRequest, res) => {
  // Existing provider comparisons expose lower-bound estimates, not an authoritative checkout quote.
  // Locking would create a false bill/payment amount, so fail closed until a real provider quote exists.
  return fail(res, 409, "CHECKOUT_QUOTE_UNAVAILABLE", "This cart can be collaborated on, but FoodLens does not yet have an authoritative provider checkout quote. No payment request was created.");
});

export const sharedCartRouter = router;
