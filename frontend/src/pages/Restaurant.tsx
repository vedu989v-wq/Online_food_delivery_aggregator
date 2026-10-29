import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, inr } from '../api';
import type { Compare, Detail, Priority } from '../types';
import { ProviderCard } from '../components/ProviderCard';
import { ReputationPanel } from '../components/ReputationPanel';
import { SourcesPanel } from '../components/SourcesPanel';
import { useAuth } from '../AuthContext';

const PRIORITIES: [Priority, string][] = [['value', 'Best value'], ['cheapest', 'Cheapest'], ['fastest', 'Fastest'], ['reliable', 'Most reliable'], ['rated', 'Best rated']];

export default function Restaurant() {
  const { user } = useAuth();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailErr, setDetailErr] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const [compareErr, setCompareErr] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [priority, setPriority] = useState<Priority>('value');
  const [maxEta, setMaxEta] = useState('');
  const [compare, setCompare] = useState<Compare | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'compare' | 'reputation' | 'sources'>('compare');
  const [saved, setSaved] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const recordedViews = useRef(new Set<string>());

  useEffect(() => {
    setDetail(null);
    setDetailErr('');
    if (!id) return;
    api<Detail>(`/restaurants/${encodeURIComponent(id)}`).then(data => {
      setDetail(data);
      const requestedItem = searchParams.get('item');
      const requestedQuantity = Number(searchParams.get('qty') || 1);
      const item = data.items.find(candidate => candidate.id === requestedItem) ?? data.items[0];
      const quantity = Number.isInteger(requestedQuantity) && requestedQuantity > 0 ? Math.min(20, requestedQuantity) : 1;
      setQty(item ? { [item.id]: quantity } : {});
    }).catch(error => setDetailErr(error instanceof Error ? error.message : 'Could not load this restaurant.'));
  }, [id, searchParams, detailRetry]);

  useEffect(() => {
    if (!detail || !user) { setSaved(false); return; }
    let cancelled = false;
    api<{ restaurants: Array<{ id: string }> }>('/customer/saved-restaurants').then(result => {
      if (!cancelled) setSaved(result.restaurants.some(item => item.id === detail.id));
    }).catch(() => { if (!cancelled) setSaved(false); });
    return () => { cancelled = true; };
  }, [detail?.id, user?.id]);

  useEffect(() => {
    if (!detail || !user?.profile.interactionConsent || recordedViews.current.has(detail.id)) return;
    recordedViews.current.add(detail.id);
    api('/customer/interactions', { method: 'POST', body: JSON.stringify({ eventType: 'restaurant_viewed', restaurantId: detail.id, cuisine: detail.cuisines[0] }) }).catch(() => undefined);
  }, [detail?.id, user?.id, user?.profile.interactionConsent]);

  useEffect(() => {
    if (!detail) return;
    const selections = Object.entries(qty).filter(([, quantity]) => quantity > 0).map(([itemId, quantity]) => ({ itemId, qty: quantity }));
    if (!selections.length) { setCompare(null); setCompareErr(''); return; }
    let cancelled = false;
    setBusy(true);
    setCompare(null);
    setCompareErr('');
    api<Compare>('/compare', {
      method: 'POST',
      body: JSON.stringify({ restaurantId: detail.id, selections, priority, maxEta: maxEta ? Number(maxEta) : undefined }),
    }).then(data => { if (!cancelled) setCompare(data); })
      .catch(error => { if (!cancelled) setCompareErr(error instanceof Error ? error.message : 'Could not compare providers.'); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [detail, qty, priority, maxEta]);

  if (detailErr) return <div className="state error" role="alert">{detailErr} <button className="btn ghost" onClick={() => setDetailRetry(count => count + 1)}>Retry</button></div>;
  if (!detail) return <div className="state">Loading restaurant…</div>;
  const setItemQuantity = (itemId: string, quantity: number) => setQty(current => ({ ...current, [itemId]: Math.max(0, Math.min(20, quantity)) }));

  async function toggleSaved() {
    if (!user || !detail) return;
    setSaveBusy(true);
    setSaveError('');
    try {
      if (saved) await api<void>(`/customer/saved-restaurants/${encodeURIComponent(detail.id)}`, { method: 'DELETE' });
      else await api(`/customer/saved-restaurants`, { method: 'POST', body: JSON.stringify({ restaurantId: detail.id }) });
      setSaved(!saved);
    } catch (error) { setSaveError(error instanceof Error ? error.message : 'Could not update saved restaurants.'); }
    finally { setSaveBusy(false); }
  }

  return (
    <>
      <div className="rhead row between wrap"><div><h1>{detail.name}</h1><p className="muted">{detail.area} · {detail.cuisines.join(', ')}{detail.phone ? ` · ${detail.phone}` : ''} · listed on {detail.listings.length} provider(s)</p></div>{user && <button className="btn ghost" onClick={toggleSaved} disabled={saveBusy} aria-pressed={saved}>{saveBusy ? 'Saving…' : saved ? 'Saved ★' : 'Save restaurant ☆'}</button>}</div>
      {saveError && <div className="state error" role="alert">{saveError}</div>}
      <div className="tabs" role="tablist">{(['compare', 'reputation', 'sources'] as const).map(item => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'on' : ''} onClick={() => setTab(item)}>{{ compare: 'Compare prices', reputation: 'Reputation', sources: 'Sources & freshness' }[item]}</button>)}</div>
      {tab === 'reputation' && <ReputationPanel d={detail} />}
      {tab === 'sources' && <SourcesPanel d={detail} />}
      {tab === 'compare' && (
        <div className="split">
          <aside className="card menu"><h3>Your basket</h3>
            {detail.items.map(item => {
              const knownPrices = item.offers.filter(offer => offer.price != null).map(offer => offer.price as number);
              return (
                <div key={item.id} className="item"><div><b>{item.veg ? '🟢 ' : '🔴 '}{item.name}</b><br /><span className="muted small">{item.offers.filter(offer => offer.available).length}/{detail.listings.length} providers · {inr(knownPrices.length ? Math.min(...knownPrices) : null)} up</span></div>
                  <div className="stepper"><button aria-label={`Remove one ${item.name}`} onClick={() => setItemQuantity(item.id, (qty[item.id] ?? 0) - 1)}>−</button><span>{qty[item.id] ?? 0}</span><button aria-label={`Add one ${item.name}`} onClick={() => setItemQuantity(item.id, (qty[item.id] ?? 0) + 1)}>+</button></div></div>
              );
            })}
          </aside>
          <section>
            <div className="controls">
              <div className="chips">{PRIORITIES.map(([key, label]) => <button key={key} className={'chip' + (priority === key ? ' on' : '')} onClick={() => setPriority(key)}>{label}</button>)}</div>
              <label className="muted">Max delivery time <input type="number" min={10} placeholder="any" value={maxEta} onChange={event => setMaxEta(event.target.value)} /> min</label>
            </div>
            {!compare && !busy && !compareErr && <div className="state">Add at least one item to compare providers.</div>}
            {busy && !compare && <div className="state">Comparing…</div>}
            {compareErr && <div className="state error" role="alert">{compareErr}</div>}
            {compare && <div className="grid cards">{compare.options.map(option => <ProviderCard key={option.providerId} o={option} />)}</div>}
            {compare?.options.length === 0 && <div className="state">No provider can fulfil this basket within your limits.</div>}
            {compare?.excluded.map(option => <div key={option.providerId} className="state excluded"><b>{option.providerName}</b>: {option.reason}</div>)}
            {compare && <p className="muted small">{compare.disclaimer} Weights are starting hypotheses, not facts.</p>}
          </section>
        </div>
      )}
    </>
  );
}
