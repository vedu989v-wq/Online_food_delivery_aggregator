import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, inr } from '../api';
import type { Detail, SearchResult } from '../types';
import type { CustomerUser } from '../AuthContext';

const demoFriends = [
  { id: 'demo-friend-vedansh', name: 'Vedansh', status: 'Active now' },
  { id: 'demo-friend-vijendra', name: 'Vijendra', status: 'Active now' },
] as const;

interface FriendState { added: boolean; selected: boolean; sent: boolean; verified: boolean; otp: string }
interface OrderLine { id: string; itemId: string; quantity: number }
const emptyFriendState = (): FriendState => ({ added: false, selected: false, sent: false, verified: false, otp: '' });

export default function FriendBasketDemo({ user }: { user: CustomerUser }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [restaurant, setRestaurant] = useState<SearchResult | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [friendState, setFriendState] = useState<Record<string, FriendState>>({});
  const [providerId, setProviderId] = useState('');
  const [address, setAddress] = useState('');
  const [draftItem, setDraftItem] = useState<Record<string, string>>({});
  const [draftQuantity, setDraftQuantity] = useState<Record<string, number>>({});
  const [orders, setOrders] = useState<Record<string, OrderLine[]>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(query)}&limit=12`)
        .then(response => setResults(response.results))
        .catch(reason => setError(reason instanceof Error ? reason.message : 'Restaurant search is unavailable.'));
    }, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!restaurant) { setDetail(null); return; }
    let active = true;
    api<Detail>(`/restaurants/${encodeURIComponent(restaurant.id)}`)
      .then(value => {
        if (!active) return;
        setDetail(value);
        setProviderId(value.listings?.[0]?.providerId ?? '');
        setOrders({});
        setError('');
      })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load this restaurant menu.'); });
    return () => { active = false; };
  }, [restaurant?.id]);

  const participants = useMemo(() => [
    { id: user.id, name: `${user.displayName} (you)` },
    ...demoFriends.filter(friend => friendState[friend.id]?.verified).map(friend => ({ id: friend.id, name: friend.name })),
  ], [user.id, user.displayName, friendState]);
  const menuItems = (detail?.items ?? []).filter(item => item.offers.some(offer => offer.providerId === providerId && offer.available && offer.price != null));
  const linePrice = (line: OrderLine) => {
    const item = (detail?.items ?? []).find(value => value.id === line.itemId);
    return item?.offers.find(offer => offer.providerId === providerId && offer.available && offer.price != null)?.price ?? null;
  };
  const participantTotal = (participantId: string) => (orders[participantId] ?? []).reduce((sum, line) => sum + (linePrice(line) ?? 0) * line.quantity, 0);
  const payingParticipants = participants.filter(person => (orders[person.id] ?? []).length > 0);
  const hasUnknownPrice = payingParticipants.some(person => (orders[person.id] ?? []).some(line => linePrice(line) == null));

  const updateFriend = (id: string, patch: Partial<FriendState>) => setFriendState(current => ({
    ...current,
    [id]: Object.assign(emptyFriendState(), current[id], patch),
  }));

  const addItem = (participantId: string) => {
    const itemId = draftItem[participantId] || menuItems[0]?.id;
    if (!itemId) return;
    const line: OrderLine = { id: `${participantId}-${Date.now()}-${Math.random()}`, itemId, quantity: Math.max(1, Math.min(20, draftQuantity[participantId] || 1)) };
    setOrders(current => ({ ...current, [participantId]: [...(current[participantId] ?? []), line] }));
  };

  const startOver = () => {
    setRestaurant(null); setDetail(null); setFriendState({}); setAddress(''); setOrders({}); setError('');
  };

  const proceedToCheckout = () => {
    if (!restaurant || !detail) return;
    navigate('/shared-cart/demo-checkout', { state: {
      restaurantName: detail.name,
      providerName: detail.listings.find(listing => listing.providerId === providerId)?.providerName ?? providerId,
      address,
      participants: payingParticipants.map(person => {
        const lines = (orders[person.id] ?? []).map(line => {
          const item = detail.items.find(value => value.id === line.itemId);
          const unitPricePaise = Math.round((linePrice(line) ?? 0) * 100);
          return { name: item?.name ?? 'Menu item', quantity: line.quantity, unitPricePaise };
        });
        return { id: person.id, name: person.name, items: lines, amountPaise: lines.reduce((sum, line) => sum + line.unitPricePaise * line.quantity, 0) };
      }),
    } });
  };

  return <section className="card friend-demo-card">
    <div className="section-heading"><div><span className="kicker">PRESENTATION DEMO</span><h2>Split a basket with friends</h2></div><span className="demo-pill">Demo mode · no real OTP or payment</span></div>
    <p className="muted">Choose one restaurant, add active friends, record their OTP confirmation and item choices, then preview one illustrative QR per person.</p>
    {error && <div className="state error" role="alert">{error}</div>}

    {!restaurant ? <div className="friend-demo-step"><h3>1. Choose one restaurant</h3><label htmlFor="friend-demo-search">Search restaurants<input id="friend-demo-search" className="field" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search a restaurant or dish" /></label>
      <div className="friend-demo-results">{results.slice(0, 6).map(result => <button key={result.id} className="btn ghost" onClick={() => { setRestaurant(result); setQuery(''); }}>{result.name} · {result.area || 'Area unavailable'}</button>)}</div>
    </div> : <>
      <div className="friend-demo-restaurant"><div><span className="kicker">ONE RESTAURANT FOR EVERYONE</span><h3>{detail?.name ?? restaurant.name}</h3><p className="muted">{restaurant.area || 'Area unavailable'} · all friend orders use this restaurant</p></div><button type="button" className="btn ghost" onClick={startOver}>Start over</button></div>

      <div className="friend-demo-step"><h3>2. Add friends and confirm demo OTP</h3><p className="muted small">The friend list is hardcoded for this Basket Split page. “Send OTP” is simulated; any non-empty code will verify a demo friend.</p>
        <div className="friend-demo-friends">{demoFriends.map(friend => {
          const state = friendState[friend.id] ?? emptyFriendState();
          return <article className="friend-demo-friend" key={friend.id}><div><b>{friend.name}</b><span className="friend-active"><i />{friend.status}</span></div>
            {!state.added ? <button type="button" className="btn ghost" onClick={() => updateFriend(friend.id, { added: true })}>Add friend</button> : state.verified ? <span className="status-dot">Verified for this demo</span> : <div className="friend-otp-row">
              {!state.sent ? <button type="button" className="btn ghost" onClick={() => updateFriend(friend.id, { selected: true, sent: true })}>Select and send OTP</button> : <><label>Enter {friend.name}&apos;s OTP<input className="field" inputMode="numeric" value={state.otp} onChange={event => updateFriend(friend.id, { otp: event.target.value })} placeholder="Any non-empty code" /></label><button type="button" className="btn" disabled={!state.otp.trim()} onClick={() => updateFriend(friend.id, { verified: true })}>Verify demo friend</button></>}
            </div>}
          </article>;
        })}</div>
      </div>

      <div className="friend-demo-step"><h3>3. Confirm the shared delivery address</h3><label htmlFor="friend-demo-address">One address for the whole basket<textarea id="friend-demo-address" className="field" value={address} onChange={event => setAddress(event.target.value)} maxLength={500} placeholder="Enter the single delivery address" /></label></div>

      <div className="friend-demo-step"><h3>4. Enter each person&apos;s food choices</h3>
        {!detail ? <p className="state">Loading this restaurant&apos;s menu…</p> : <>
          <label>Menu provider<select className="field" value={providerId} onChange={event => { setProviderId(event.target.value); setOrders({}); setDraftItem({}); }}>{(detail.listings ?? []).map(listing => <option key={listing.providerId} value={listing.providerId}>{listing.providerName}</option>)}</select></label>
          <div className="friend-demo-orders">{participants.map(person => <article className="friend-demo-order" key={person.id}><div className="section-heading"><h4>{person.name}&apos;s choices</h4><b>{inr(participantTotal(person.id))}</b></div>
            <div className="row wrap"><select className="field" aria-label={`Choose food for ${person.name}`} value={draftItem[person.id] ?? menuItems[0]?.id ?? ''} onChange={event => setDraftItem(current => ({ ...current, [person.id]: event.target.value }))}>{menuItems.map(item => <option key={item.id} value={item.id}>{item.name} · {inr(item.offers.find(offer => offer.providerId === providerId)?.price)}</option>)}</select><input className="field friend-qty" aria-label={`Quantity for ${person.name}`} type="number" min={1} max={20} value={draftQuantity[person.id] ?? 1} onChange={event => setDraftQuantity(current => ({ ...current, [person.id]: Number(event.target.value) }))} /><button type="button" className="btn" disabled={!menuItems.length} onClick={() => addItem(person.id)}>Add item</button></div>
              {(orders[person.id] ?? []).map(line => {
              const item = (detail.items ?? []).find(value => value.id === line.itemId);
              return <div className="share-row" key={line.id}><span>{item?.name ?? 'Menu item'} × {line.quantity}</span><b>{linePrice(line) == null ? 'Price unavailable' : inr(linePrice(line)! * line.quantity)}</b><button type="button" className="text-button" onClick={() => setOrders(current => ({ ...current, [person.id]: (current[person.id] ?? []).filter(value => value.id !== line.id) }))}>Remove</button></div>;
            })}
            {!(orders[person.id] ?? []).length && <p className="muted small">No items added yet.</p>}
          </article>)}</div>
          {!menuItems.length && <p className="state">No priced, available menu items are listed for this provider.</p>}
        </>}
      </div>

      <div className="friend-demo-checkout"><h3>5. Checkout</h3><p className="muted small">Only participants who added food items receive a QR. Each person pays for their selected items only; fees, taxes and discounts are excluded. Product data is synthetic; this demo does not place an order.</p>
        <button type="button" className="btn" disabled={!detail || !payingParticipants.length || address.trim().length < 8 || payingParticipants.some(person => participantTotal(person.id) <= 0) || hasUnknownPrice} onClick={proceedToCheckout}>Proceed to checkout</button>
      </div>
    </>}
  </section>;
}
