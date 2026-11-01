import type { Option } from '../types';
import { inr } from '../api';
import { FreshPill } from './FreshPill';

export function ProviderCard({ o }: { o: Option }) {
  const p = o.pricing;
  return (
    <article className={'card prov-card' + (o.rank === 1 ? ' top' : '')}>
      <div className="provider-head"><h3>{o.rank === 1 && <span className="rank">Top pick · </span>}{o.providerName}</h3><FreshPill f={o.freshness} /></div>
      <div className="badges">{o.badges.map(b => <span key={b} className="badge">{b}</span>)}</div>
      <div className="total"><span>{p.isLowerBound ? 'At least' : 'Estimate'}</span><strong>{inr(p.total)}</strong><small>{o.etaMin ? `${o.etaMin} min` : 'Time unknown'}</small></div>
      <table className="break"><tbody>
        <tr><td>Items</td><td>{inr(p.subtotal)}</td></tr>
        <tr><td>Food GST (assumed)</td><td>{inr(p.foodTax)}</td></tr>
        <tr><td>Delivery fee</td><td className={p.deliveryFee == null ? 'unk' : ''}>{p.deliveryFee == null ? 'unknown' : inr(p.deliveryFee)}</td></tr>
        <tr><td>Platform fee</td><td className={p.platformFee == null ? 'unk' : ''}>{p.platformFee == null ? 'unknown' : inr(p.platformFee)}</td></tr>
        <tr><td>GST on fees (assumed)</td><td>{inr(p.feeTax)}</td></tr>
        {p.discount > 0 && <tr><td>Discount</td><td className="good">−{inr(p.discount)}</td></tr>}
      </tbody></table>
      {p.discountNote && <p className="muted small">{p.discountNote}</p>}
      <p className="muted small">{p.verified ? 'Verified by provider checkout' : 'Estimate, not a verified checkout total'}</p>
      <details><summary>Why this rank?</summary>
        <ul className="reasons">{o.reasons.map(r => <li key={r}>{r}</li>)}</ul>
        {o.factors.map(f => (
          <div key={f.factor} className="factor"><span>{f.factor} <em>(weight {f.weight})</em>{!f.known && ' · unknown → neutral'}</span>
            <div className="bar"><i style={{ width: `${f.value * 100}%` }} /></div></div>))}
      </details>
      {o.url ? <a className="btn" href={o.url} target="_blank" rel="noopener noreferrer">Open on {o.providerName}</a> : <span className="muted small">Provider link unavailable in synthetic data.</span>}
    </article>
  );
}
