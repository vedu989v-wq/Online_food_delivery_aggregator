import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inr } from '../api';
import { useAuth } from '../AuthContext';
import type { Detail, SearchResult } from '../types';

interface Member { userId: string; name: string; role: 'organizer' | 'member'; addressConfirmed: boolean }
interface CartItem { id: string; itemId: string; itemName: string; ownerId: string; ownerName: string; quantity: number; unitPricePaise?: number | null }
interface Allocation { currency: string; providerName: string; totalPaise: number; subtotalPaise: number; deliveryPaise: number; platformPaise: number; foodTaxPaise: number; feeTaxPaise: number; discountPaise: number; disclaimer: string; shares: Array<{ userId: string; amountPaise: number }>; payments: Array<{ id: string; userId: string; amountPaise: string; status: string; imageUrl?: string | null; expiresAt?: string | null }> }
interface SharedCartData { id: string; restaurantId: string; restaurantName: string; selectedProviderId?: string | null; state: string; version: number; organizerId: string; address?: string; members: Member[]; items: CartItem[]; allocation?: Allocation }
interface CartListEntry { id: string; restaurantName: string; state: string; memberCount: number }

export default function SharedCart() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [carts, setCarts] = useState<CartListEntry[]>([]);
  const [cart, setCart] = useState<SharedCartData | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [estimateProviderId, setEstimateProviderId] = useState('');
  const [invite, setInvite] = useState('');
  const [shareLink, setShareLink] = useState('');
  const [paymentQr, setPaymentQr] = useState<{ imageUrl: string; amountPaise: number } | null>(null);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const eventCursor = useRef('0');

  const refreshCarts = useCallback(async () => {
    const data = await api<{ carts: CartListEntry[] }>('/shared-carts');
    setCarts(data.carts);
  }, []);
  const refreshCart = useCallback(async (id: string) => {
    const data = await api<{ cart: SharedCartData }>(`/shared-carts/${id}`);
    setCart(data.cart);
    if (data.cart.address) setAddress(data.cart.address);
    return data.cart;
  }, [user?.id]);

  useEffect(() => { refreshCarts().catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load shared carts.')); }, [refreshCarts]);
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('invite');
    if (!token) return;
    setInvite(token);
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, []);
  useEffect(() => {
    if (!cart) return;
    let alive = true;
    eventCursor.current = '0';
    const poll = async () => {
      const updates = await api<{ events: Array<{ id: string | number }> }>(`/shared-carts/${cart.id}/events?after=${eventCursor.current}`);
      if (updates.events.length) {
        eventCursor.current = String(updates.events[updates.events.length - 1].id);
        if (alive) await refreshCart(cart.id);
      }
    };
    const timer = window.setInterval(() => { if (alive) void poll().catch(() => undefined); }, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [cart?.id, refreshCart]);
  useEffect(() => {
    if (!cart) { setDetail(null); return; }
    let alive = true;
    api<Detail>(`/restaurants/${encodeURIComponent(cart.restaurantId)}`).then(value => { if (alive) { setDetail(value); setItemId(value.items[0]?.id ?? ''); setEstimateProviderId(value.listings[0]?.providerId ?? ''); } }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Could not load the menu.'); });
    return () => { alive = false; };
  }, [cart?.restaurantId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(query)}&limit=20`).then(value => setResults(value.results)).catch(() => setResults([]));
    }, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The request could not be completed.'); }
    finally { setBusy(false); }
  }
  const ownerEstimate = (ownerId: string): number | null => {
    const owned = (cart?.items ?? []).filter(line => line.ownerId === ownerId);
    if (!owned.length) return 0;
    let total = 0;
    for (const line of owned) {
      const menuItem = detail?.items.find(item => item.id === line.itemId);
      const offer = menuItem?.offers.find(value => value.providerId === estimateProviderId && value.available && value.price != null);
      if (!offer || offer.price == null) return null;
      total += offer.price * line.quantity;
    }
    return total;
  };
  const selectCart = (value: SharedCartData) => { setCart(value); setShareLink(''); setPaymentQr(null); };

  if (!user) return <div className="feature-page"><div className="state">Sign in to create or join a synchronized shared basket. <Link to="/login">Sign in</Link></div></div>;
  return <div className="feature-page">
    <div className="eyebrow">BASKET SPLIT <span className="demo-pill">Collaborative basket · test payments only</span></div>
    <div className="feature-hero"><div><h1>Build one basket together.</h1><p>Invited members can add their own items, confirm the shared address, and see changes as they happen.</p></div></div>
    {error && <div className="state error" role="alert">{error}</div>}
    {!cart ? <div className="cart-layout">
      <section className="card group-card"><div className="section-heading"><h2>Create a group basket</h2></div>
        <label htmlFor="cart-search">Choose a restaurant</label><input id="cart-search" className="field" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search restaurants or dishes" />
        <div className="member-list">{results.slice(0, 8).map(result => <button type="button" key={result.id} disabled={busy} className="btn ghost full" onClick={() => void act(async () => { const data = await api<{ cart: SharedCartData }>('/shared-carts', { method: 'POST', body: JSON.stringify({ restaurantId: result.id }) }); selectCart(data.cart); await refreshCarts(); })}>{result.name} · {result.area || 'Area unavailable'}</button>)}</div>
      </section>
      <section className="card"><div className="section-heading"><h2>Join by invitation</h2></div><label>Invitation token or link<input className="field" value={invite} onChange={event => setInvite(event.target.value)} placeholder="Paste a FoodLens invite link" /></label><button className="btn" disabled={!invite || busy} onClick={() => void act(async () => { const value = invite.includes('invite=') ? new URL(invite).hash.split('invite=')[1] : invite; const data = await api<{ cart: SharedCartData }>('/shared-carts/join', { method: 'POST', body: JSON.stringify({ inviteToken: decodeURIComponent(value) }) }); selectCart(data.cart); setInvite(''); await refreshCarts(); })}>Join basket</button>
        <h2 className="section-heading">Your baskets</h2>{carts.map(value => <button className="btn ghost full" key={value.id} onClick={() => void act(async () => selectCart(await refreshCart(value.id)))}>{value.restaurantName} · {value.memberCount} member{value.memberCount === 1 ? '' : 's'} · {value.state.replace(/_/g, ' ')}</button>)}{carts.length === 0 && <p className="muted small">No shared baskets yet.</p>}
      </section>
    </div> : <div className="cart-layout">
      <section className="card group-card"><div className="section-heading"><div><span className="kicker">SHARED BASKET</span><h2>{cart.restaurantName}</h2></div><button className="btn ghost" onClick={() => setCart(null)}>All baskets</button></div>
        <p className="muted small">Room code {cart.id} · version {cart.version} · {cart.state.replace(/_/g, ' ')}</p>
        <h3>Members</h3>{cart.members.map(member => <div className="share-row" key={member.userId}><b>{member.name}{member.userId === user.id ? ' (you)' : ''}</b><span className="muted small">{member.role}{member.addressConfirmed ? ' · address confirmed' : ' · address not confirmed'}{cart.organizerId === user.id && member.role === 'member' && ['created','inviting','open','address_confirmation'].includes(cart.state) && <button className="icon-btn" aria-label={`Remove ${member.name}`} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/members/${member.userId}`, { method: 'DELETE' }); await refreshCart(cart.id); })}>×</button>}</span></div>)}
        {cart.organizerId === user.id && <><button className="btn ghost full" disabled={busy || !['created','inviting','open','address_confirmation'].includes(cart.state)} onClick={() => void act(async () => { const value = await api<{ inviteToken: string }>(`/shared-carts/${cart.id}/invitations`, { method: 'POST', body: '{}' }); const link = `${location.origin}/shared-cart#invite=${encodeURIComponent(value.inviteToken)}`; setShareLink(link); await navigator.clipboard?.writeText(link); })}>Create invite link</button>{shareLink && <p className="muted small">One-time invite link copied. It expires in 24 hours: <a href={shareLink}>{shareLink}</a></p>}
        <button className="btn ghost full" disabled={busy || !['created','inviting','open','address_confirmation'].includes(cart.state)} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/invitations`, { method: 'DELETE' }); setShareLink(''); })}>Revoke pending invitations</button>
        <label>Shared delivery address<textarea className="field" value={address} onChange={event => setAddress(event.target.value)} maxLength={500} disabled={!['created','inviting','open','address_confirmation'].includes(cart.state)} /></label><p className="small muted">All basket members can view this address to confirm they are using the same destination.</p><button className="btn" disabled={busy || address.trim().length < 8 || !['created','inviting','open','address_confirmation'].includes(cart.state)} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/address`, { method: 'PUT', body: JSON.stringify({ address }) }); await refreshCart(cart.id); })}>Save shared address</button><button className="btn ghost" disabled={busy || !['created','inviting','open','address_confirmation'].includes(cart.state)} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/cancel`, { method: 'POST', body: '{}' }); await refreshCarts(); setCart(null); })}>Cancel basket</button></>}
        {cart.organizerId !== user.id && <><p className="small muted">Shared delivery address: {cart.address || 'The organizer has not set an address yet.'}</p><label>Confirm the organizer&apos;s delivery address<input className="field" value={address} onChange={event => setAddress(event.target.value)} maxLength={500} disabled={!['created','inviting','open','address_confirmation'].includes(cart.state)} /></label><button className="btn" disabled={busy || address.trim().length < 8 || !['created','inviting','open','address_confirmation'].includes(cart.state)} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/address-confirmation`, { method: 'POST', body: JSON.stringify({ address }) }); await refreshCart(cart.id); })}>Confirm same address</button></>}
        {cart.organizerId !== user.id && ['created','inviting','open','address_confirmation'].includes(cart.state) && <button className="btn ghost" disabled={busy} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/leave`, { method: 'POST', body: '{}' }); await refreshCarts(); setCart(null); })}>Leave basket</button>}
      </section>
      <section className="card"><div className="section-heading"><div><span className="kicker">MENU</span><h2>Items for everyone</h2></div></div>
        {detail && ['created','inviting','open','address_confirmation'].includes(cart.state) && <div className="row wrap"><select className="field" aria-label="Menu item" value={itemId} onChange={event => setItemId(event.target.value)}>{detail.items.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><input className="field" type="number" aria-label="Quantity" min={1} max={20} value={quantity} onChange={event => setQuantity(Number(event.target.value))} /><button className="btn" disabled={busy || !itemId} onClick={() => void act(async () => { const data = await api<{ cart: SharedCartData }>(`/shared-carts/${cart.id}/items`, { method: 'POST', body: JSON.stringify({ itemId, quantity }) }); setCart(data.cart); })}>Add to my items</button></div>}
        {cart.items?.map(item => <div className="cart-item" key={item.id}><div className="cart-item-info"><b>{item.itemName}</b><small className="muted">{item.quantity} × · added by {item.ownerName}{item.unitPricePaise != null ? ` · locked at ${inr(item.unitPricePaise / 100)} each` : ''}</small></div>{item.ownerId === user.id && ['created','inviting','open','address_confirmation'].includes(cart.state) && <><button type="button" className="icon-btn" aria-label={`Reduce quantity of ${item.itemName}`} disabled={busy || item.quantity <= 1} onClick={() => void act(async () => { const data = await api<{ cart: SharedCartData }>(`/shared-carts/${cart.id}/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: item.quantity - 1 }) }); setCart(data.cart); })}>−</button><button type="button" className="icon-btn" aria-label={`Increase quantity of ${item.itemName}`} disabled={busy || item.quantity >= 20} onClick={() => void act(async () => { const data = await api<{ cart: SharedCartData }>(`/shared-carts/${cart.id}/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: item.quantity + 1 }) }); setCart(data.cart); })}>+</button><button type="button" className="icon-btn" aria-label={`Remove ${item.itemName}`} disabled={busy} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/items/${item.id}`, { method: 'DELETE' }); await refreshCart(cart.id); })}>×</button></>}</div>)}
        {!cart.items?.length && <p className="state">Add an item to start the group basket.</p>}
        {detail && cart.items?.length > 0 && ['created','inviting','open','address_confirmation'].includes(cart.state) && <div className="card"><h3>Provider item subtotal preview</h3><label>Provider menu<select className="field" value={estimateProviderId} onChange={event => setEstimateProviderId(event.target.value)}>{detail.listings.map(listing => <option key={listing.providerId} value={listing.providerId}>{listing.providerName}</option>)}</select></label>{cart.members.map(member => <div className="share-row" key={member.userId}><b>{member.name}</b><strong>{ownerEstimate(member.userId) == null ? 'unknown' : inr(ownerEstimate(member.userId))}</strong></div>)}<p className="muted small">Preview only. Basket lock rechecks current synthetic menu data and fee records. This is not a live provider quote or order total.</p></div>}
        {cart.organizerId === user.id && detail && ['created','inviting','open','address_confirmation'].includes(cart.state) && <section className="card"><h3>Lock basket and split estimated cost</h3><p className="muted small">Choose one provider listing. Every participant must confirm the shared address first. Locking snapshots menu prices and fee assumptions from synthetic FoodLens data.</p><label>Provider for this basket<select className="field" value={estimateProviderId} onChange={event => setEstimateProviderId(event.target.value)}>{detail.listings.map(listing => <option key={listing.providerId} value={listing.providerId}>{listing.providerName} · delivery {listing.deliveryFee == null ? 'unknown' : inr(listing.deliveryFee)} · platform {listing.platformFee == null ? 'unknown' : inr(listing.platformFee)}</option>)}</select></label><button className="btn" disabled={busy || !(cart.items?.length) || !cart.members?.every(member => member.addressConfirmed)} onClick={() => void act(async () => { const data = await api<{ cart: SharedCartData }>(`/shared-carts/${cart.id}/lock`, { method: 'POST', body: JSON.stringify({ providerId: estimateProviderId }) }); setCart(data.cart); })}>Lock and calculate shares</button></section>}
        {cart.allocation && <section className="card"><h3>Locked group split · {cart.allocation.providerName}</h3><div className="share-row"><span>Items</span><b>{inr(cart.allocation.subtotalPaise / 100)}</b></div><div className="share-row"><span>Delivery + platform fees</span><b>{inr((cart.allocation.deliveryPaise + cart.allocation.platformPaise) / 100)}</b></div><div className="share-row"><span>Estimated taxes</span><b>{inr((cart.allocation.foodTaxPaise + cart.allocation.feeTaxPaise) / 100)}</b></div><div className="share-row"><span>Provider discount</span><b>−{inr(cart.allocation.discountPaise / 100)}</b></div><div className="share-row"><strong>Total estimate</strong><strong>{inr(cart.allocation.totalPaise / 100)}</strong></div><h4>Per-person shares</h4>{cart.allocation.shares.map(share => <div className="share-row" key={share.userId}><b>{cart.members.find(member => member.userId === share.userId)?.name ?? 'Participant'}</b><strong>{inr(share.amountPaise / 100)}</strong></div>)}{cart.allocation.payments.map(payment => <div className="share-row" key={payment.id}><span>{cart.members.find(member => member.userId === payment.userId)?.name ?? 'Participant'} · {payment.status}</span>{payment.imageUrl && <img src={payment.imageUrl} alt="Participant-specific Razorpay test payment QR" width="128" height="128" />}</div>)}<p className="muted small">{cart.allocation.disclaimer}</p>{['awaiting_payments','partially_paid','payment_failed'].includes(cart.state) && <button className="btn" disabled={busy || cart.allocation.payments.some(payment => payment.userId === user.id && payment.status === 'paid')} onClick={() => void act(async () => { const data = await api<{ payment: { imageUrl: string; amountPaise: number } }>(`/shared-carts/${cart.id}/payment-request`, { method: 'POST', body: '{}' }); setPaymentQr({ imageUrl: data.payment.imageUrl, amountPaise: data.payment.amountPaise }); await refreshCart(cart.id); })}>Create or show my test payment QR</button>}{paymentQr && <div><p>Test payment request: {inr(paymentQr.amountPaise / 100)}</p><img src={paymentQr.imageUrl} alt="Razorpay test payment QR" width="220" height="220" /><p className="muted small">On a phone, save the QR and use your UPI app&apos;s scan-from-gallery feature if available; otherwise scan it with another device. No UPI PIN is entered in FoodLens.</p><a className="btn ghost" href={paymentQr.imageUrl} target="_blank" rel="noreferrer">Open QR image</a></div>}{cart.organizerId === user.id && ['awaiting_payments','partially_paid','payment_failed'].includes(cart.state) && <button className="btn ghost" disabled={busy || cart.allocation.payments.some(payment => payment.status === 'paid')} onClick={() => void act(async () => { const data = await api<{ cart: SharedCartData }>(`/shared-carts/${cart.id}/reopen`, { method: 'POST', body: '{}' }); selectCart(data.cart); })}>Reopen basket and cancel unpaid requests</button>}</section>}
        {['ready_for_checkout','completed'].includes(cart.state) && <div className="state">All allocated participant payments are verified. This basket is ready for an authorized provider checkout; FoodLens has not placed a restaurant order.</div>}
        {!cart.allocation && <div className="state">Your items and ownership synchronize across participants. No payment split is available until the organizer locks the basket after all members confirm the shared address.</div>}
      </section>
    </div>}
  </div>;
}
