import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inr } from '../api';
import { useAuth } from '../AuthContext';
import type { Detail, SearchResult } from '../types';

interface Member { userId: string; name: string; role: 'organizer' | 'member'; addressConfirmed: boolean }
interface CartItem { id: string; itemId: string; itemName: string; ownerId: string; ownerName: string; quantity: number }
interface SharedCartData { id: string; restaurantId: string; restaurantName: string; state: string; version: number; organizerId: string; address?: string; members: Member[]; items: CartItem[] }
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
  const selectCart = (value: SharedCartData) => { setCart(value); setShareLink(''); };

  if (!user) return <div className="feature-page"><div className="state">Sign in to create or join a synchronized shared basket. <Link to="/login">Sign in</Link></div></div>;
  return <div className="feature-page">
    <div className="eyebrow">BASKET SPLIT <span className="demo-pill">Persisted group cart · payments unavailable</span></div>
    <div className="feature-hero"><div><h1>Build one basket together.</h1><p>Invited members can add their own items, confirm the shared address, and see changes as they happen.</p></div></div>
    {error && <div className="state error" role="alert">{error}</div>}
    {!cart ? <div className="cart-layout">
      <section className="card group-card"><div className="section-heading"><h2>Create a group basket</h2></div>
        <label htmlFor="cart-search">Choose a restaurant</label><input id="cart-search" className="field" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search restaurants or dishes" />
        <div className="member-list">{results.slice(0, 8).map(result => <button type="button" key={result.id} disabled={busy} className="btn ghost full" onClick={() => void act(async () => { const data = await api<{ cart: SharedCartData }>('/shared-carts', { method: 'POST', body: JSON.stringify({ restaurantId: result.id }) }); selectCart(data.cart); await refreshCarts(); })}>{result.name} · {result.area || 'Area unavailable'}</button>)}</div>
      </section>
      <section className="card"><div className="section-heading"><h2>Join by invitation</h2></div><label>Invitation token or link<input className="field" value={invite} onChange={event => setInvite(event.target.value)} placeholder="Paste a FoodLens invite link" /></label><button className="btn" disabled={!invite || busy} onClick={() => void act(async () => { const value = invite.includes('invite=') ? new URL(invite).hash.split('invite=')[1] : invite; const data = await api<{ cart: SharedCartData }>('/shared-carts/join', { method: 'POST', body: JSON.stringify({ inviteToken: decodeURIComponent(value) }) }); selectCart(data.cart); setInvite(''); await refreshCarts(); })}>Join basket</button>
        <h2 className="section-heading">Your active baskets</h2>{carts.map(value => <button className="btn ghost full" key={value.id} onClick={() => void act(async () => selectCart(await refreshCart(value.id)))}>{value.restaurantName} · {value.memberCount} member{value.memberCount === 1 ? '' : 's'} · {value.state}</button>)}{carts.length === 0 && <p className="muted small">No active shared baskets yet.</p>}
      </section>
    </div> : <div className="cart-layout">
      <section className="card group-card"><div className="section-heading"><div><span className="kicker">SHARED BASKET</span><h2>{cart.restaurantName}</h2></div><button className="btn ghost" onClick={() => setCart(null)}>All baskets</button></div>
        <p className="muted small">Version {cart.version} · {cart.state}</p>
        <h3>Members</h3>{cart.members.map(member => <div className="share-row" key={member.userId}><b>{member.name}{member.userId === user.id ? ' (you)' : ''}</b><span className="muted small">{member.role}{member.addressConfirmed ? ' · address confirmed' : ' · address not confirmed'}</span></div>)}
        {cart.organizerId === user.id && <><button className="btn ghost full" disabled={busy} onClick={() => void act(async () => { const value = await api<{ inviteToken: string }>(`/shared-carts/${cart.id}/invitations`, { method: 'POST', body: '{}' }); const link = `${location.origin}/shared-cart#invite=${encodeURIComponent(value.inviteToken)}`; setShareLink(link); await navigator.clipboard?.writeText(link); })}>Create invite link</button>{shareLink && <p className="muted small">One-time invite link copied. It expires in 24 hours: <a href={shareLink}>{shareLink}</a></p>}
        <label>Shared delivery address<textarea className="field" value={address} onChange={event => setAddress(event.target.value)} maxLength={500} /></label><p className="small muted">All basket members can view this address to confirm they are using the same destination.</p><button className="btn" disabled={busy || address.trim().length < 8} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/address`, { method: 'PUT', body: JSON.stringify({ address }) }); await refreshCart(cart.id); })}>Save shared address</button><button className="btn ghost" disabled={busy || cart.state !== 'open'} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/cancel`, { method: 'POST', body: '{}' }); await refreshCarts(); setCart(null); })}>Cancel basket</button></>}
        {cart.organizerId !== user.id && <><p className="small muted">Shared delivery address: {cart.address || 'The organizer has not set an address yet.'}</p><label>Confirm the organizer&apos;s delivery address<input className="field" value={address} onChange={event => setAddress(event.target.value)} maxLength={500} /></label><button className="btn" disabled={busy || address.trim().length < 8} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/address-confirmation`, { method: 'POST', body: JSON.stringify({ address }) }); await refreshCart(cart.id); })}>Confirm same address</button></>}
      </section>
      <section className="card"><div className="section-heading"><div><span className="kicker">MENU</span><h2>Items for everyone</h2></div></div>
        {detail && <div className="row wrap"><select className="field" aria-label="Menu item" value={itemId} onChange={event => setItemId(event.target.value)}>{detail.items.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><input className="field" type="number" aria-label="Quantity" min={1} max={20} value={quantity} onChange={event => setQuantity(Number(event.target.value))} /><button className="btn" disabled={busy || !itemId} onClick={() => void act(async () => { const data = await api<{ cart: SharedCartData }>(`/shared-carts/${cart.id}/items`, { method: 'POST', body: JSON.stringify({ itemId, quantity }) }); setCart(data.cart); })}>Add to my items</button></div>}
        {cart.items?.map(item => <div className="cart-item" key={item.id}><div className="cart-item-info"><b>{item.itemName}</b><small className="muted">{item.quantity} × · added by {item.ownerName}</small></div>{item.ownerId === user.id && <button type="button" className="icon-btn" aria-label={`Remove ${item.itemName}`} disabled={busy} onClick={() => void act(async () => { await api(`/shared-carts/${cart.id}/items/${item.id}`, { method: 'DELETE' }); await refreshCart(cart.id); })}>×</button>}</div>)}
        {!cart.items?.length && <p className="state">Add an item to start the group basket.</p>}
        {detail && cart.items?.length > 0 && <div className="card"><h3>Item subtotal estimates</h3><label>Provider menu<select className="field" value={estimateProviderId} onChange={event => setEstimateProviderId(event.target.value)}>{detail.listings.map(listing => <option key={listing.providerId} value={listing.providerId}>{listing.providerName}</option>)}</select></label>{cart.members.map(member => <div className="share-row" key={member.userId}><b>{member.name}</b><strong>{ownerEstimate(member.userId) == null ? 'unknown' : inr(ownerEstimate(member.userId))}</strong></div>)}<p className="muted small">These are listed item prices only from synthetic menu data. Fees, taxes, discounts, availability, and final checkout amounts may differ; these are not payment shares.</p></div>}
        <div className="state">Checkout and payment collection are unavailable. Current provider comparisons omit or estimate fees, so FoodLens cannot produce a reliable payable split yet. Your cart items and item ownership are synchronized and persisted.</div>
      </section>
    </div>}
  </div>;
}
