import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { Router, type Response } from "express";
import { authenticate, requireCsrf, type AuthenticatedRequest } from "./auth-routes.js";
import { inTransaction, query } from "./db.js";
import { tokenHash } from "./auth.js";
import { calculateShares } from "./cost-allocation.js";
import { configuredPaymentProvider } from "./payment-provider.js";

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
  await query("UPDATE shared_carts SET state='expired',updated_at=now() WHERE id=$1 AND state IN ('created','inviting','open','address_confirmation') AND expires_at<=now()", [cartId]);
  await query("UPDATE shared_cart_payments SET status='expired',updated_at=now() WHERE cart_id=$1 AND status='pending' AND expires_at<=now()", [cartId]);
  await query("UPDATE shared_carts SET state='payment_failed',updated_at=now() WHERE id=$1 AND state IN ('awaiting_payments','partially_paid') AND EXISTS(SELECT 1 FROM shared_cart_payments WHERE cart_id=$1 AND status='expired')", [cartId]);
  await query("UPDATE shared_carts c SET state='expired',updated_at=now() WHERE c.id=$1 AND c.expires_at<=now() AND c.state IN ('awaiting_payments','partially_paid','payment_failed') AND NOT EXISTS(SELECT 1 FROM shared_cart_payments p WHERE p.cart_id=c.id AND p.status='paid')", [cartId]);
  const result = await query(`SELECT c.id,c.restaurant_id AS "restaurantId",c.restaurant_name AS "restaurantName",c.selected_provider_id AS "selectedProviderId",c.state,c.version,c.organizer_id AS "organizerId",c.address_ciphertext AS "addressCiphertext",c.address_confirmed_at AS "organizerConfirmedAt",c.created_at AS "createdAt",
    COALESCE((SELECT json_agg(json_build_object('userId',u.id,'name',u.display_name,'role',m.role,'addressConfirmed',m.address_confirmed_at IS NOT NULL) ORDER BY m.joined_at) FROM shared_cart_members m JOIN customer_users u ON u.id=m.user_id WHERE m.cart_id=c.id), '[]'::json) AS members,
    COALESCE((SELECT json_agg(json_build_object('id',i.id,'itemId',i.item_id,'itemName',i.item_name,'ownerId',i.owner_id,'ownerName',u.display_name,'quantity',i.quantity,'unitPricePaise',i.unit_price_paise) ORDER BY i.created_at) FROM shared_cart_items i JOIN customer_users u ON u.id=i.owner_id WHERE i.cart_id=c.id), '[]'::json) AS items
    FROM shared_carts c WHERE c.id=$1`, [cartId]);
  const row = result.rows[0];
  if (row.addressCiphertext) {
    const secret = key();
    if (secret) row.address = decryptAddress(row.addressCiphertext, secret);
  }
  delete row.addressCiphertext;
  const allocation = await query<{ breakdown: any }>("SELECT breakdown FROM shared_cart_allocations WHERE cart_id=$1 AND version=$2", [cartId, row.version]);
  if (allocation.rowCount) {
    const breakdown = allocation.rows[0].breakdown;
    const organizer = row.organizerId === userId;
    const payments = await query("SELECT id,user_id AS \"userId\",amount_paise::text AS \"amountPaise\",status,qr_image_url AS \"imageUrl\",expires_at AS \"expiresAt\" FROM shared_cart_payments WHERE cart_id=$1 AND allocation_version=$2", [cartId, row.version]);
    row.allocation = { ...breakdown, shares: breakdown.shares.filter((share: any) => organizer || share.userId === userId), payments: payments.rows.filter(payment => organizer || payment.userId === userId) };
  }
  return row;
}
router.use(authenticate);

router.get("/", async (req: AuthenticatedRequest, res) => {
  try {
    await query("UPDATE shared_carts SET state='expired',updated_at=now() WHERE state IN ('created','inviting','open','address_confirmation') AND expires_at<=now()");
    await query("UPDATE shared_cart_payments SET status='expired',updated_at=now() WHERE status='pending' AND expires_at<=now()");
    await query("UPDATE shared_carts c SET state='expired',updated_at=now() WHERE c.expires_at<=now() AND c.state IN ('awaiting_payments','partially_paid','payment_failed') AND NOT EXISTS(SELECT 1 FROM shared_cart_payments p WHERE p.cart_id=c.id AND p.status='paid')");
    const rows = await query(`SELECT c.id,c.restaurant_id AS "restaurantId",c.restaurant_name AS "restaurantName",c.state,c.version,c.created_at AS "createdAt",m.role,
      (SELECT count(*)::int FROM shared_cart_members x WHERE x.cart_id=c.id) AS "memberCount"
      FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE m.user_id=$1 ORDER BY c.updated_at DESC LIMIT 50`, [req.auth!.id]);
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
      const created = await client.query<{ id: string }>("INSERT INTO shared_carts(organizer_id,restaurant_id,restaurant_name,state) VALUES($1,$2,$3,'created') RETURNING id", [req.auth!.id, restaurantId, text(restaurant.name, 160) || restaurantId]);
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
      const row = await client.query("SELECT state FROM shared_carts WHERE id=$1 AND organizer_id=$2 AND expires_at>now() FOR UPDATE", [id, req.auth!.id]);
      if (!row.rowCount) return "missing";
      if (!["created", "inviting", "open", "address_confirmation"].includes(row.rows[0].state)) return "closed";
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
      const cart = await client.query("SELECT state FROM shared_carts WHERE id=$1 AND organizer_id=$2 AND expires_at>now() FOR UPDATE", [id, req.auth!.id]);
      if (!cart.rowCount || !["created", "open", "inviting", "address_confirmation"].includes(cart.rows[0].state)) return false;
      await client.query("UPDATE shared_carts SET state='inviting',updated_at=now() WHERE id=$1", [id]);
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
      const found = await client.query<{ cart_id: string }>("SELECT i.cart_id,c.id AS locked_cart FROM shared_cart_invitations i JOIN shared_carts c ON c.id=i.cart_id WHERE i.token_hash=$1 AND i.expires_at>now() AND i.accepted_at IS NULL AND c.state IN ('open','inviting','address_confirmation') AND c.expires_at>now() FOR UPDATE OF c,i", [tokenHash(invite)]);
      if (!found.rowCount) return null;
      const id = found.rows[0].cart_id;
      const maxMembers = Math.max(2, Math.min(20, Number(process.env.SHARED_CART_MAX_MEMBERS) || 8));
      const current = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM shared_cart_members WHERE cart_id=$1", [id]);
      if (current.rows[0].count >= maxMembers) return null;
      const joined = await client.query("INSERT INTO shared_cart_members(cart_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING RETURNING user_id", [id, req.auth!.id]);
      if (!joined.rowCount) {
        await client.query("UPDATE shared_cart_invitations SET accepted_by=$2,accepted_at=now() WHERE token_hash=$1", [tokenHash(invite), req.auth!.id]);
        return id;
      }
      await client.query("UPDATE shared_cart_invitations SET accepted_by=$2,accepted_at=now() WHERE token_hash=$1", [tokenHash(invite), req.auth!.id]);
      await client.query("UPDATE shared_carts SET state='open',version=version+1,updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'member_joined')", [id, req.auth!.id]);
      return id;
    });
    if (!cartId) return fail(res, 404, "INVITATION_EXPIRED", "This invitation is invalid, expired, or already used.");
    return res.json({ cart: await loadCart(cartId, req.auth!.id, res) });
  } catch { return fail(res, 503, "JOIN_FAILED", "Could not join this cart."); }
});

router.post("/:cartId/leave", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId;
  if (typeof id !== "string" || !idPattern.test(id)) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
  try {
    const result = await inTransaction(async client => {
      const cart = await client.query<{ state: string; organizer_id: string }>("SELECT c.state,c.organizer_id FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2 AND c.expires_at>now() FOR UPDATE OF c", [id, req.auth!.id]);
      if (!cart.rowCount) return "missing";
      if (cart.rows[0].organizer_id === req.auth!.id) return "organizer";
      if (!["created", "inviting", "open", "address_confirmation"].includes(cart.rows[0].state)) return "locked";
      await client.query("DELETE FROM shared_cart_members WHERE cart_id=$1 AND user_id=$2", [id, req.auth!.id]);
      await client.query("UPDATE shared_carts SET version=version+1,updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'member_left')", [id, req.auth!.id]);
      return "ok";
    });
    if (result === "missing") return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
    if (result === "organizer") return fail(res, 409, "ORGANIZER_CANNOT_LEAVE", "The organizer must cancel or transfer the basket.");
    if (result === "locked") return fail(res, 409, "CART_LOCKED", "Members cannot leave after the basket is locked.");
    return res.status(204).end();
  } catch { return fail(res, 503, "LEAVE_FAILED", "Could not leave this basket."); }
});

router.delete("/:cartId/members/:userId", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const userId = req.params.userId;
  if (typeof id !== "string" || typeof userId !== "string" || !idPattern.test(id) || !idPattern.test(userId)) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
  try {
    const result = await inTransaction(async client => {
      const cart = await client.query<{ state: string }>("SELECT state FROM shared_carts WHERE id=$1 AND organizer_id=$2 AND expires_at>now() FOR UPDATE", [id, req.auth!.id]);
      if (!cart.rowCount) return "missing";
      if (!["created", "inviting", "open", "address_confirmation"].includes(cart.rows[0].state)) return "locked";
      const removed = await client.query("DELETE FROM shared_cart_members WHERE cart_id=$1 AND user_id=$2 AND role='member'", [id, userId]);
      if (!removed.rowCount) return "member_missing";
      await client.query("UPDATE shared_carts SET version=version+1,updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type,payload) VALUES($1,$2,'member_removed',$3)", [id, req.auth!.id, JSON.stringify({ userId })]);
      return "ok";
    });
    if (result === "missing" || result === "member_missing") return fail(res, 404, "MEMBER_NOT_FOUND", "Only the organizer can remove a current member.");
    if (result === "locked") return fail(res, 409, "CART_LOCKED", "Members cannot be removed after the basket is locked.");
    return res.status(204).end();
  } catch { return fail(res, 503, "MEMBER_REMOVE_FAILED", "Could not remove this member."); }
});

router.delete("/:cartId/invitations", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId;
  if (typeof id !== "string" || !idPattern.test(id)) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
  try {
    const owner = await query("SELECT 1 FROM shared_carts WHERE id=$1 AND organizer_id=$2", [id, req.auth!.id]);
    if (!owner.rowCount) return fail(res, 404, "CART_NOT_FOUND", "Only the organizer can revoke invitations.");
    await inTransaction(async client => {
      await client.query("UPDATE shared_cart_invitations SET expires_at=now() WHERE cart_id=$1 AND accepted_at IS NULL", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'invitations_revoked')", [id, req.auth!.id]);
    });
    return res.status(204).end();
  } catch { return fail(res, 503, "INVITATION_REVOKE_FAILED", "Could not revoke invitations."); }
});

router.post("/:cartId/items", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const itemId = text(req.body?.itemId, 200); const quantity = Number(req.body?.quantity ?? 1);
  if (typeof id !== "string" || !idPattern.test(id) || !itemId || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return fail(res, 400, "INVALID_ITEM", "Choose a menu item and quantity from 1 to 20.");
  try {
    const cart = await query<{ restaurant_id: string; state: string }>("SELECT restaurant_id,state FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2 AND c.expires_at>now()", [id, req.auth!.id]);
    if (!cart.rowCount) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
    if (!["created", "inviting", "open", "address_confirmation"].includes(cart.rows[0].state)) return fail(res, 409, "CART_LOCKED", "This cart is not open for changes.");
    const base = (process.env.PYTHON_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/restaurants/${encodeURIComponent(cart.rows[0].restaurant_id)}`, { signal: AbortSignal.timeout(7000) });
    if (!response.ok) return fail(res, 503, "MENU_UNAVAILABLE", "The menu could not be verified.");
    const detail = await response.json() as { items?: Array<{ id?: string; name?: string }> };
    const item = detail.items?.find(candidate => candidate.id === itemId);
    if (!item) return fail(res, 400, "ITEM_NOT_IN_MENU", "That item is not part of this cart's restaurant menu.");
    const added = await inTransaction(async client => {
      const locked = await client.query<{ state: string }>("SELECT state FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2 AND c.expires_at>now() FOR UPDATE OF c", [id, req.auth!.id]);
      if (!locked.rowCount || !["created", "inviting", "open", "address_confirmation"].includes(locked.rows[0].state)) return false;
      await client.query("INSERT INTO shared_cart_items(cart_id,owner_id,item_id,item_name,quantity) VALUES($1,$2,$3,$4,$5)", [id, req.auth!.id, itemId, text(item.name, 200) || itemId, quantity]);
      await client.query("UPDATE shared_carts SET state=CASE WHEN state='created' THEN 'open' ELSE state END,version=version+1,updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type,payload) VALUES($1,$2,'item_added',$3)", [id, req.auth!.id, JSON.stringify({ itemId, quantity })]);
      return true;
    });
    if (!added) return fail(res, 409, "CART_LOCKED", "This cart is not open for changes.");
    return res.status(201).json({ cart: await loadCart(id, req.auth!.id, res) });
  } catch { return fail(res, 503, "ITEM_ADD_FAILED", "Could not add this item."); }
});

router.delete("/:cartId/items/:itemId", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const item = req.params.itemId;
  if (typeof id !== "string" || typeof item !== "string" || !idPattern.test(id) || !idPattern.test(item)) return fail(res, 404, "ITEM_NOT_FOUND", "This cart item is unavailable.");
  try {
    const removed = await inTransaction(async client => {
      const cart = await client.query("SELECT c.state FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2 AND c.expires_at>now() FOR UPDATE", [id, req.auth!.id]);
      if (!cart.rowCount) return "missing";
      if (!["created", "inviting", "open", "address_confirmation"].includes(cart.rows[0].state)) return "locked";
      const result = await client.query("DELETE FROM shared_cart_items WHERE cart_id=$1 AND id=$2 AND owner_id=$3", [id, item, req.auth!.id]);
      if (result.rowCount) { await client.query("UPDATE shared_carts SET version=version+1,updated_at=now() WHERE id=$1", [id]); await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'item_removed')", [id, req.auth!.id]); }
      return result.rowCount ? "ok" : "missing";
    });
    if (removed === "locked") return fail(res, 409, "CART_LOCKED", "This cart is not open for changes.");
    if (removed !== "ok") return fail(res, 404, "ITEM_NOT_FOUND", "Only the owner can remove this item.");
    return res.status(204).end();
  } catch { return fail(res, 503, "ITEM_REMOVE_FAILED", "Could not remove this item."); }
});

router.patch("/:cartId/items/:itemId", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const itemId = req.params.itemId; const quantity = Number(req.body?.quantity);
  if (typeof id !== "string" || typeof itemId !== "string" || !idPattern.test(id) || !idPattern.test(itemId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return fail(res, 400, "INVALID_QUANTITY", "Quantity must be an integer from 1 to 20.");
  try {
    const result = await inTransaction(async client => {
      const cart = await client.query<{ state: string }>("SELECT c.state FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2 AND c.expires_at>now() FOR UPDATE OF c", [id, req.auth!.id]);
      if (!cart.rowCount) return "missing";
      if (!["created", "inviting", "open", "address_confirmation"].includes(cart.rows[0].state)) return "locked";
      const changed = await client.query("UPDATE shared_cart_items SET quantity=$4 WHERE cart_id=$1 AND id=$2 AND owner_id=$3", [id, itemId, req.auth!.id, quantity]);
      if (!changed.rowCount) return "item_missing";
      await client.query("UPDATE shared_carts SET version=version+1,updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type,payload) VALUES($1,$2,'item_updated',$3)", [id, req.auth!.id, JSON.stringify({ itemId, quantity })]);
      return "ok";
    });
    if (result === "missing" || result === "item_missing") return fail(res, 404, "ITEM_NOT_FOUND", "Only the owner can edit this item.");
    if (result === "locked") return fail(res, 409, "CART_LOCKED", "This cart is not open for changes.");
    return res.json({ cart: await loadCart(id, req.auth!.id, res) });
  } catch { return fail(res, 503, "ITEM_UPDATE_FAILED", "Could not update this item."); }
});

router.put("/:cartId/address", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const address = text(req.body?.address, 500);
  if (typeof id !== "string" || !idPattern.test(id) || !address || address.length < 8) return fail(res, 400, "INVALID_ADDRESS", "Enter a delivery address.");
  const secret = key(); if (!secret) return fail(res, 503, "ADDRESS_STORAGE_UNCONFIGURED", "Secure address storage is not configured. Set FOODLENS_PII_KEY to a random 32-byte hex key.");
  try {
    const updated = await inTransaction(async client => {
      const state = await client.query<{ state: string }>("SELECT state FROM shared_carts WHERE id=$1 AND organizer_id=$2 AND expires_at>now() FOR UPDATE", [id, req.auth!.id]);
      if (!state.rowCount) return "missing";
      if (!["created", "inviting", "open", "address_confirmation"].includes(state.rows[0].state)) return "closed";
      await client.query("UPDATE shared_carts SET address_ciphertext=$2,address_confirmed_at=now(),state='address_confirmation',version=version+1,updated_at=now() WHERE id=$1", [id, encryptAddress(address, secret)]);
      await client.query("UPDATE shared_cart_members SET address_confirmed_at=NULL,address_fingerprint=NULL WHERE cart_id=$1", [id]);
      await client.query("UPDATE shared_cart_members SET address_confirmed_at=now(),address_fingerprint=$3 WHERE cart_id=$1 AND user_id=$2", [id, req.auth!.id, addressFingerprint(address, secret)]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'address_set')", [id, req.auth!.id]);
      return "ok";
    });
    if (updated === "missing") return fail(res, 404, "CART_NOT_FOUND", "Only the organizer can set the address.");
    if (updated === "closed") return fail(res, 409, "CART_LOCKED", "Address cannot be changed after checkout lock.");
    return res.json({ confirmed: true });
  } catch { return fail(res, 503, "ADDRESS_UPDATE_FAILED", "Could not save the delivery address."); }
});

router.post("/:cartId/address-confirmation", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const address = text(req.body?.address, 500);
  if (typeof id !== "string" || !idPattern.test(id) || !address || address.length < 8) return fail(res, 400, "INVALID_ADDRESS", "Enter the shared delivery address to confirm it.");
  const secret = key(); if (!secret) return fail(res, 503, "ADDRESS_STORAGE_UNCONFIGURED", "Secure address storage is not configured.");
  try {
    const result = await inTransaction(async client => {
      const row = await client.query<{ address_ciphertext: string | null; state: string }>("SELECT c.address_ciphertext,c.state FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2 AND c.expires_at>now() FOR UPDATE OF c", [id, req.auth!.id]);
      if (!row.rowCount) return "missing";
      if (!["created", "inviting", "open", "address_confirmation"].includes(row.rows[0].state) || !row.rows[0].address_ciphertext) return "unavailable";
      const organizerAddress = decryptAddress(row.rows[0].address_ciphertext, secret);
      if (addressFingerprint(organizerAddress, secret) !== addressFingerprint(address, secret)) return "mismatch";
      await client.query("UPDATE shared_cart_members SET address_confirmed_at=now(),address_fingerprint=$3 WHERE cart_id=$1 AND user_id=$2", [id, req.auth!.id, addressFingerprint(address, secret)]);
      await client.query("UPDATE shared_carts SET version=version+1,updated_at=now() WHERE id=$1", [id]);
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

router.post("/:cartId/reopen", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId;
  if (typeof id !== "string" || !idPattern.test(id)) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
  try {
    const prepared = await inTransaction(async client => {
      const cart = await client.query<{ state: string }>("SELECT state FROM shared_carts WHERE id=$1 AND organizer_id=$2 AND expires_at>now() FOR UPDATE", [id, req.auth!.id]);
      if (!cart.rowCount) return { error: "missing" };
      if (!["awaiting_payments", "partially_paid", "payment_failed"].includes(cart.rows[0].state)) return { error: "not_ready" };
      if ((await client.query("SELECT 1 FROM shared_cart_payments WHERE cart_id=$1 AND status='paid' LIMIT 1", [id])).rowCount) return { error: "paid" };
      const requests = await client.query<{ id: string; provider_reference: string | null; amount_paise: string }>("SELECT id,provider_reference,amount_paise::text FROM shared_cart_payments WHERE cart_id=$1 AND status='pending' FOR UPDATE", [id]);
      await client.query("UPDATE shared_carts SET state='reopening',updated_at=now() WHERE id=$1", [id]);
      return { previousState: cart.rows[0].state, requests: requests.rows };
    });
    if ("error" in prepared) {
      if (prepared.error === "missing") return fail(res, 404, "CART_NOT_FOUND", "Only the organizer can reopen this basket.");
      return fail(res, 409, prepared.error === "paid" ? "PAYMENT_ALREADY_RECEIVED" : "REOPEN_NOT_ALLOWED", prepared.error === "paid" ? "A participant payment has already been recorded." : "Only an unpaid basket in the payment stage can be reopened.");
    }
    const requests = prepared.requests;
    const provider = configuredPaymentProvider();
    const restorePaymentState = () => inTransaction(async client => {
      const current = await client.query<{ state: string }>("SELECT state FROM shared_carts WHERE id=$1 FOR UPDATE", [id]);
      if (!current.rowCount || current.rows[0].state !== "reopening") return;
      const progress = await client.query<{ total: number; paid: number }>(`SELECT jsonb_array_length(a.breakdown->'shares')::int AS total,
        count(p.id) FILTER (WHERE p.status='paid')::int AS paid FROM shared_carts c
        JOIN shared_cart_allocations a ON a.cart_id=c.id AND a.version=c.version
        LEFT JOIN shared_cart_payments p ON p.cart_id=c.id AND p.allocation_version=c.version
        WHERE c.id=$1 GROUP BY a.breakdown`, [id]);
      const paid = progress.rows[0]?.paid || 0; const total = progress.rows[0]?.total || 0;
      const state = paid >= total && total > 0 ? "ready_for_checkout" : paid > 0 ? "partially_paid" : prepared.previousState;
      await client.query("UPDATE shared_carts SET state=$2,updated_at=now() WHERE id=$1 AND state='reopening'", [id, state]);
    });
    if (requests.some(payment => payment.provider_reference) && !provider) {
      await restorePaymentState();
      return fail(res, 503, "TEST_PAYMENTS_UNCONFIGURED", "Configure Razorpay test credentials to safely close outstanding payment QRs.");
    }
    let receivedPayment = false;
    try {
      for (const payment of requests) {
        if (!payment.provider_reference) continue;
        let status = await provider!.verifyQrPayment(payment.provider_reference, Number(payment.amount_paise));
        if (status.status === "paid") {
          await query("UPDATE shared_cart_payments SET status='paid',provider_payment_id=$2,updated_at=now() WHERE id=$1 AND status='pending'", [payment.id, status.paymentId || null]);
          receivedPayment = true;
          break;
        }
        await provider!.closeSingleUseUpiQr(payment.provider_reference);
        // Recheck after closing to catch a capture that raced the close request.
        status = await provider!.verifyQrPayment(payment.provider_reference, Number(payment.amount_paise));
        if (status.status === "paid") {
          await query("UPDATE shared_cart_payments SET status='paid',provider_payment_id=$2,updated_at=now() WHERE id=$1 AND status='pending'", [payment.id, status.paymentId || null]);
          receivedPayment = true;
          break;
        }
        await query("UPDATE shared_cart_payments SET status='cancelled',updated_at=now() WHERE id=$1 AND status='pending'", [payment.id]);
      }
    } catch {
      await restorePaymentState();
      return fail(res, 503, "QR_CLOSE_FAILED", "At least one outstanding QR could not be safely cancelled. The basket was not reopened.");
    }
    if (receivedPayment) {
      await query(`UPDATE shared_carts c SET state=CASE
        WHEN (SELECT count(*) FROM shared_cart_payments p WHERE p.cart_id=c.id AND p.allocation_version=c.version AND p.status='paid') >= jsonb_array_length(a.breakdown->'shares') THEN 'ready_for_checkout'
        ELSE 'partially_paid' END,updated_at=now()
        FROM shared_cart_allocations a WHERE c.id=$1 AND a.cart_id=c.id AND a.version=c.version`, [id]);
      return fail(res, 409, "PAYMENT_ALREADY_RECEIVED", "A participant payment reached the provider. Refresh this basket before continuing.");
    }
    const reopened = await inTransaction(async client => {
      const current = await client.query<{ state: string }>("SELECT state FROM shared_carts WHERE id=$1 AND organizer_id=$2 AND expires_at>now() FOR UPDATE", [id, req.auth!.id]);
      if (!current.rowCount || current.rows[0].state !== "reopening") return false;
      const paid = await client.query("SELECT 1 FROM shared_cart_payments WHERE cart_id=$1 AND status='paid' LIMIT 1", [id]);
      if (paid.rowCount) {
        const progress = await client.query<{ total: number; paid: number }>(`SELECT jsonb_array_length(a.breakdown->'shares')::int AS total,
          count(p.id) FILTER (WHERE p.status='paid')::int AS paid FROM shared_carts c
          JOIN shared_cart_allocations a ON a.cart_id=c.id AND a.version=c.version
          LEFT JOIN shared_cart_payments p ON p.cart_id=c.id AND p.allocation_version=c.version
          WHERE c.id=$1 GROUP BY a.breakdown`, [id]);
        const countPaid = progress.rows[0]?.paid || 0; const total = progress.rows[0]?.total || 0;
        await client.query("UPDATE shared_carts SET state=$2,updated_at=now() WHERE id=$1", [id, countPaid >= total && total > 0 ? "ready_for_checkout" : "partially_paid"]);
        return "paid";
      }
      await client.query("UPDATE shared_cart_payments SET status='cancelled',updated_at=now() WHERE cart_id=$1 AND status='pending'", [id]);
      await client.query("UPDATE shared_carts SET state=CASE WHEN address_ciphertext IS NULL THEN 'open' ELSE 'address_confirmation' END,selected_provider_id=NULL,locked_at=NULL,version=version+1,updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type) VALUES($1,$2,'cart_reopened')", [id, req.auth!.id]);
      return "reopened";
    });
    if (reopened === "paid") return fail(res, 409, "PAYMENT_ALREADY_RECEIVED", "A participant payment arrived while reopening. Refresh this basket before continuing.");
    if (reopened !== "reopened") return fail(res, 409, "REOPEN_NOT_ALLOWED", "This basket changed before it could be reopened.");
    return res.json({ cart: await loadCart(id, req.auth!.id, res) });
  } catch { return fail(res, 503, "CART_REOPEN_FAILED", "Could not safely cancel payment requests and reopen this basket."); }
});

router.post("/:cartId/lock", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId; const providerId = text(req.body?.providerId, 64);
  if (typeof id !== "string" || !idPattern.test(id) || !providerId) return fail(res, 400, "INVALID_CHECKOUT", "Choose a provider listing for this basket.");
  const base = (process.env.PYTHON_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
  try {
    const snapshot = await query<any>(`SELECT c.restaurant_id,c.state,c.version,c.organizer_id,
      (SELECT json_agg(json_build_object('id',i.id,'itemId',i.item_id,'itemName',i.item_name,'ownerId',i.owner_id,'quantity',i.quantity) ORDER BY i.id) FROM shared_cart_items i WHERE i.cart_id=c.id) AS items,
      (SELECT json_agg(json_build_object('userId',m.user_id,'confirmed',m.address_confirmed_at IS NOT NULL) ORDER BY m.joined_at) FROM shared_cart_members m WHERE m.cart_id=c.id) AS members
      FROM shared_carts c WHERE c.id=$1 AND c.expires_at>now()`, [id]);
    if (!snapshot.rowCount || snapshot.rows[0].organizer_id !== req.auth!.id) return fail(res, 404, "CART_NOT_FOUND", "Only the organizer can lock this basket.");
    const cart = snapshot.rows[0];
    if (!["created", "inviting", "open", "address_confirmation"].includes(cart.state)) return fail(res, 409, "CART_NOT_OPEN", "This basket cannot be locked from its current state.");
    if (!cart.items?.length) return fail(res, 409, "EMPTY_CART", "Add at least one item before locking this basket.");
    if (!cart.members?.every((member: any) => member.confirmed)) return fail(res, 409, "ADDRESS_CONFIRMATION_REQUIRED", "Every participant must confirm the shared address before locking.");
    const response = await fetch(`${base}/api/restaurants/${encodeURIComponent(cart.restaurant_id)}`, { signal: AbortSignal.timeout(7000) });
    if (!response.ok) return fail(res, 503, "MENU_UNAVAILABLE", "The provider menu could not be checked.");
    const detail = await response.json() as { items?: Array<{ id: string; name: string; offers: Array<{ providerId: string; price: number | null; available: boolean; providerItemName: string }> }>; listings?: Array<{ providerId: string; providerName: string; deliveryFee: number | null; platformFee: number | null }> };
    const listing = detail.listings?.find(value => value.providerId === providerId);
    if (!listing) return fail(res, 400, "PROVIDER_NOT_FOUND", "That provider is not available for this restaurant.");
    if (listing.deliveryFee == null || listing.platformFee == null) return fail(res, 409, "FEES_UNKNOWN", "This listing has unknown delivery or platform charges and cannot be costed.");
    const prices: Array<{ itemId: string; ownerId: string; quantity: number; unitPricePaise: number; itemName: string; providerItemName: string }> = [];
    for (const item of cart.items as Array<{ itemId: string; ownerId: string; quantity: number }>) {
      const menuItem = detail.items?.find(value => value.id === item.itemId);
      const offer = menuItem?.offers.find(value => value.providerId === providerId && value.available && Number.isFinite(value.price) && value.price! >= 0);
      if (!menuItem || !offer || offer.price == null) return fail(res, 409, "ITEM_UNAVAILABLE", "One or more basket items are unavailable or unpriced at this provider. Update the basket before locking.");
      prices.push({ itemId: item.itemId, ownerId: item.ownerId, quantity: item.quantity, unitPricePaise: Math.round(offer.price * 100), itemName: menuItem.name, providerItemName: offer.providerItemName });
    }
    const quoteResponse = await fetch(`${base}/api/compare`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ restaurantId: cart.restaurant_id, selections: prices.map(item => ({ itemId: item.itemId, quantity: item.quantity })) }), signal: AbortSignal.timeout(7000) });
    if (!quoteResponse.ok) return fail(res, 503, "QUOTE_UNAVAILABLE", "FoodLens could not calculate a basket breakdown.");
    const comparison = await quoteResponse.json() as { options?: Array<{ providerId: string; pricing: { subtotal: number; foodTax: number; deliveryFee: number | null; platformFee: number | null; feeTax: number; discount: number; total: number; isLowerBound: boolean; unknowns: string[] } }> };
    const option = comparison.options?.find(value => value.providerId === providerId);
    if (!option) return fail(res, 409, "PROVIDER_CANNOT_FULFILL", "This provider cannot fulfil every item in the basket.");
    if (option.pricing.isLowerBound || option.pricing.deliveryFee == null || option.pricing.platformFee == null || option.pricing.unknowns.length) return fail(res, 409, "FEES_UNKNOWN", "This listing has unknown charges and cannot be split safely.");
    const toPaise = (amount: number) => Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : NaN;
    const providerSubtotalPaise = toPaise(option.pricing.subtotal);
    const foodTaxPaise = toPaise(option.pricing.foodTax);
    const deliveryPaise = toPaise(option.pricing.deliveryFee);
    const platformPaise = toPaise(option.pricing.platformFee);
    const feeTaxPaise = toPaise(option.pricing.feeTax);
    const discountPaise = toPaise(option.pricing.discount);
    const providerTotalPaise = toPaise(option.pricing.total);
    const memberIds = (cart.members as Array<{ userId: string }>).map(value => value.userId);
    const memberWeights = new Map<string, number>(memberIds.map(userId => [userId, 0]));
    for (const item of prices) memberWeights.set(item.ownerId, (memberWeights.get(item.ownerId) ?? 0) + item.unitPricePaise * item.quantity);
    const subtotalPaise = [...memberWeights.values()].reduce((sum, value) => sum + value, 0);
    if ([providerSubtotalPaise, foodTaxPaise, deliveryPaise, platformPaise, feeTaxPaise, discountPaise, providerTotalPaise].some(value => !Number.isSafeInteger(value)) || providerSubtotalPaise !== subtotalPaise) return fail(res, 409, "QUOTE_MISMATCH", "Provider price data changed while the basket was being priced. Refresh and try again.");
    const { totalPaise, shares } = calculateShares(prices.map(item => ({ userId: item.ownerId, itemPaise: item.unitPricePaise * item.quantity })), {
      deliveryPaise, platformPaise, sharedTaxPaise: foodTaxPaise + feeTaxPaise, sharedDiscountPaise: discountPaise,
    });
    if (totalPaise !== providerTotalPaise) return fail(res, 409, "QUOTE_MISMATCH", "The provider breakdown could not be reconciled to the exact paise.");
    const allocation = {
      currency: "INR", providerId, providerName: listing.providerName, totalPaise, subtotalPaise,
      deliveryPaise, platformPaise, foodTaxPaise, feeTaxPaise, discountPaise,
      disclaimer: "Test-mode estimate from synthetic FoodLens menu data. It is not a provider checkout quote, does not place an order, and must not be collected with live payment credentials.",
      items: prices.map(item => ({ ...item, linePaise: item.unitPricePaise * item.quantity })),
      shares: [...shares].map(([userId, amountPaise]) => ({ userId, amountPaise })),
    };
    const saved = await inTransaction(async client => {
      const current = await client.query<{ state: string; version: number }>("SELECT state,version FROM shared_carts WHERE id=$1 AND organizer_id=$2 AND expires_at>now() FOR UPDATE", [id, req.auth!.id]);
      if (!current.rowCount || current.rows[0].version !== cart.version || !["created", "inviting", "open", "address_confirmation"].includes(current.rows[0].state)) return false;
      const confirmations = await client.query<{ count: number; confirmed: number }>("SELECT count(*)::int AS count,count(*) FILTER (WHERE address_confirmed_at IS NOT NULL)::int AS confirmed FROM shared_cart_members WHERE cart_id=$1", [id]);
      if (!confirmations.rows[0].count || confirmations.rows[0].count !== confirmations.rows[0].confirmed) return false;
      const version = current.rows[0].version + 1;
      await client.query("UPDATE shared_cart_items i SET unit_price_paise=p.unit_price_paise,provider_item_name=p.provider_item_name FROM jsonb_to_recordset($2::jsonb) AS p(id uuid,unit_price_paise bigint,provider_item_name text) WHERE i.id=p.id AND i.cart_id=$1", [id, JSON.stringify(prices.map((item, index) => ({ id: cart.items[index].id, unit_price_paise: item.unitPricePaise, provider_item_name: item.providerItemName })))]);
      await client.query("INSERT INTO shared_cart_allocations(cart_id,version,breakdown) VALUES($1,$2,$3)", [id, version, JSON.stringify(allocation)]);
      await client.query("UPDATE shared_carts SET state='awaiting_payments',selected_provider_id=$2,locked_at=now(),version=$3,updated_at=now() WHERE id=$1", [id, providerId, version]);
      await client.query("UPDATE shared_cart_invitations SET expires_at=now() WHERE cart_id=$1 AND accepted_at IS NULL", [id]);
      await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type,payload) VALUES($1,$2,'cart_locked',$3)", [id, req.auth!.id, JSON.stringify({ version, providerId, totalPaise })]);
      return true;
    });
    if (!saved) return fail(res, 409, "CART_CHANGED", "The basket changed while it was being priced. Refresh and try locking again.");
    return res.json({ cart: await loadCart(id, req.auth!.id, res) });
  } catch (error) {
    if (error instanceof Error && error.message.includes("allocation")) return fail(res, 409, "ALLOCATION_FAILED", "Could not calculate a safe payment split.");
    return fail(res, 503, "CART_LOCK_FAILED", "Could not lock and price this basket.");
  }
});

router.post("/:cartId/payment-request", requireCsrf, async (req: AuthenticatedRequest, res) => {
  const id = req.params.cartId;
  if (typeof id !== "string" || !idPattern.test(id)) return fail(res, 404, "CART_NOT_FOUND", "This shared cart is unavailable.");
  const provider = configuredPaymentProvider();
  if (!provider) return fail(res, 503, "TEST_PAYMENTS_UNCONFIGURED", "Individual QR requests require Razorpay test credentials and PAYMENT_ENV=test. Live payments are disabled until FoodLens has a real provider order quote.");
  try {
    type PendingPayment = { id: string; status: string; provider_reference: string | null; qr_image_url: string | null; amount_paise: string; expires_at: string | null };
    const reserved = await inTransaction<{ error: string } | { payment: PendingPayment; reused: boolean }>(async client => {
      const cart = await client.query<{ state: string; version: number }>("SELECT c.state,c.version FROM shared_carts c JOIN shared_cart_members m ON m.cart_id=c.id WHERE c.id=$1 AND m.user_id=$2 AND c.expires_at>now() FOR UPDATE OF c", [id, req.auth!.id]);
      if (!cart.rowCount) return { error: "missing" };
      if (!["awaiting_payments", "partially_paid", "payment_failed"].includes(cart.rows[0].state)) return { error: "not_ready" };
      const allocation = await client.query<{ breakdown: any }>("SELECT breakdown FROM shared_cart_allocations WHERE cart_id=$1 AND version=$2", [id, cart.rows[0].version]);
      const share = allocation.rows[0]?.breakdown?.shares?.find((value: any) => value.userId === req.auth!.id);
      if (!share || !Number.isSafeInteger(share.amountPaise) || share.amountPaise <= 0) return { error: "no_share" };
      const existing = await client.query<PendingPayment>("SELECT id,status,provider_reference,qr_image_url,amount_paise::text,expires_at FROM shared_cart_payments WHERE cart_id=$1 AND allocation_version=$2 AND user_id=$3 FOR UPDATE", [id, cart.rows[0].version, req.auth!.id]);
      if (existing.rowCount && existing.rows[0].status === "paid") return { error: "already_paid" };
      if (existing.rowCount && existing.rows[0].provider_reference && existing.rows[0].qr_image_url && existing.rows[0].status === "pending") return { payment: existing.rows[0], reused: true };
      if (existing.rowCount && existing.rows[0].status === "pending") return { error: "request_in_progress" };
      if (existing.rowCount) {
        await client.query("UPDATE shared_cart_payments SET status='pending',provider_reference=NULL,qr_image_url=NULL,updated_at=now() WHERE id=$1", [existing.rows[0].id]);
        return { payment: { ...existing.rows[0], status: "pending", provider_reference: null, qr_image_url: null }, reused: false };
      }
      const created = await client.query<PendingPayment>("INSERT INTO shared_cart_payments(cart_id,allocation_version,user_id,amount_paise,provider,status,expires_at) VALUES($1,$2,$3,$4,'razorpay','pending',now()+interval '24 hours') RETURNING id,status,provider_reference,qr_image_url,amount_paise::text,expires_at", [id, cart.rows[0].version, req.auth!.id, share.amountPaise]);
      return { payment: created.rows[0], reused: false };
    });
    if ("error" in reserved) {
      const codes: Record<string, [number, string, string]> = {
        missing: [404, "CART_NOT_FOUND", "This shared cart is unavailable."],
        not_ready: [409, "PAYMENTS_NOT_OPEN", "The organizer must lock the basket before requesting contributions."],
        no_share: [409, "NO_PAYMENT_SHARE", "There is no payable amount allocated to this participant."],
        already_paid: [409, "ALREADY_PAID", "Your contribution is already confirmed."],
        request_in_progress: [409, "PAYMENT_REQUEST_PENDING", "Your payment request is being prepared."],
      };
      const [status, code, message] = codes[reserved.error] || [409, "PAYMENT_REQUEST_INVALID", "This payment request cannot be created in the basket's current state."]; return fail(res, status, code, message);
    }
    let payment = reserved.payment;
    if (!reserved.reused) {
      try {
        const qr = await provider.createSingleUseUpiQr({ amountPaise: Number(payment.amount_paise), description: `FoodLens test basket ${id.slice(0, 8)}`, paymentRequestId: payment.id });
        await inTransaction(async client => {
          await client.query("UPDATE shared_cart_payments SET provider_reference=$2,qr_image_url=$3,updated_at=now() WHERE id=$1 AND status='pending'", [payment.id, qr.id, qr.imageUrl]);
          await client.query("UPDATE shared_carts SET state='awaiting_payments',updated_at=now() WHERE id=$1 AND state='payment_failed'", [id]);
          await client.query("INSERT INTO shared_cart_events(cart_id,actor_id,event_type,payload) VALUES($1,$2,'payment_requested',$3)", [id, req.auth!.id, JSON.stringify({ paymentId: payment.id })]);
        });
        payment = { ...payment, provider_reference: qr.id, qr_image_url: qr.imageUrl };
      } catch {
        await query("UPDATE shared_cart_payments SET status='failed',updated_at=now() WHERE id=$1 AND status='pending'", [payment.id]);
        await query("UPDATE shared_carts SET state='payment_failed',updated_at=now() WHERE id=$1", [id]);
        return fail(res, 502, "PAYMENT_QR_UNAVAILABLE", "The test payment provider could not create a QR request.");
      }
    }
    return res.status(reserved.reused ? 200 : 201).json({ payment: { id: payment.id, amountPaise: Number(payment.amount_paise), status: payment.status, qrCodeId: payment.provider_reference, imageUrl: payment.qr_image_url, expiresAt: payment.expires_at } });
  } catch { return fail(res, 503, "PAYMENT_REQUEST_FAILED", "Could not prepare an individual test payment request."); }
});

export const sharedCartRouter = router;
