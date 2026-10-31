import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inr } from '../api';
import { FreshPill } from '../components/FreshPill';
import type { Priority, RecommendationResponse } from '../types';
import { useAuth } from '../AuthContext';

interface NutritionRecord { itemId: string; dishName: string; servingSizeG: number | null; caloriesKcal: number | null; proteinG: number | null; carbohydratesG: number | null; fatG: number | null; fiberG: number | null; sodiumMg: number | null; sourceName: string; sourceReference: string; estimationMethod: string; confidenceLevel: string; verificationStatus: string }
interface HealthProfile { consented: boolean; ageYears?: number | null; heightCm?: number | null; weightKg?: number | null; activityLevel?: string | null; goal?: string | null; dietaryPreference?: string | null; calorieTarget?: number | null; proteinTargetG?: number | null }

const PRIORITIES: [Priority | 'balanced', string][] = [
  ['balanced', 'Balanced value'], ['cheapest', 'Cheapest'], ['fastest', 'Fastest'],
  ['reliable', 'Most reliable'], ['rated', 'Best rated'],
];

export default function SmartMeal() {
  const { user } = useAuth();
  const [budget, setBudget] = useState('500');
  const [people, setPeople] = useState('2');
  const [vegetarian, setVegetarian] = useState(true);
  const [cuisine, setCuisine] = useState('');
  const [priority, setPriority] = useState<Priority | 'balanced'>('balanced');
  const [cuisineOptions, setCuisineOptions] = useState<string[]>([]);
  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nutrition, setNutrition] = useState<Record<string, NutritionRecord>>({});
  const [health, setHealth] = useState<HealthProfile>({ consented: false });
  const [healthMessage, setHealthMessage] = useState('');
  const [maxEta, setMaxEta] = useState('');

  useEffect(() => {
    api<{ cuisines?: string[] }>('/meta').then(meta => setCuisineOptions(meta.cuisines ?? [])).catch(() => setCuisineOptions([]));
  }, []);

  useEffect(() => {
    if (!user) return;
    api<{ profile: HealthProfile }>('/customer/health-profile').then(data => setHealth(data.profile)).catch(() => setHealth({ consented: false }));
  }, [user]);

  useEffect(() => {
    const budgetValue = Number(budget);
    const peopleValue = Number(people);
    if (!Number.isFinite(budgetValue) || budgetValue <= 0 || !Number.isInteger(peopleValue) || peopleValue < 1 || peopleValue > 12) {
      setData(null);
      setBusy(false);
      setError('Enter a positive per-person budget and a group size from 1 to 12.');
      return;
    }
    const query = new URLSearchParams({
      budgetPerPerson: String(budgetValue), people: String(peopleValue),
      vegetarian: String(vegetarian), cuisine,
      priority: priority === 'balanced' ? 'value' : priority,
      limit: '12',
    });
    if (maxEta) {
      const etaValue = Number(maxEta);
      if (!Number.isInteger(etaValue) || etaValue < 1 || etaValue > 240) {
        setError('Delivery time must be between 1 and 240 minutes.');
        setData(null);
        return;
      }
      query.set('maxDeliveryTime', maxEta);
    }
    if (user && health.consented && health.calorieTarget) query.set('calorieTarget', String(health.calorieTarget));
    if (user && health.consented && health.proteinTargetG != null) query.set('proteinTargetG', String(health.proteinTargetG));
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setBusy(true);
      setError('');
      api<RecommendationResponse>(`${user ? '/customer/recommendations' : '/intelligence/recommendations'}?${query.toString()}`)
        .then(async response => {
          if (cancelled) return;
          setData(response);
          const ids = [...new Set(response.recommendations.map(row => row.itemId))];
          if (ids.length) {
            const enriched = await api<{ records: NutritionRecord[] }>(`/smartmeal/nutrition?itemIds=${encodeURIComponent(ids.join(','))}`).catch(() => ({ records: [] }));
            if (!cancelled) setNutrition(Object.fromEntries(enriched.records.map(row => [row.itemId, row])));
          } else setNutrition({});
        })
        .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load menu recommendations.'); })
        .finally(() => { if (!cancelled) setBusy(false); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [budget, people, vegetarian, cuisine, priority, maxEta, user, health.consented, health.calorieTarget, health.proteinTargetG]);

  async function saveHealth() {
    setHealthMessage('');
    try {
      await api('/customer/health-profile', { method: 'PUT', body: JSON.stringify(health) });
      setHealthMessage(health.consented ? 'Optional profile saved to your account.' : 'Health profile consent removed and sensitive values cleared.');
      if (!health.consented) setHealth({ consented: false });
    } catch (reason) { setHealthMessage(reason instanceof Error ? reason.message : 'Could not save the optional profile.'); }
  }

  return (
    <div className="feature-page">
      <div className="eyebrow">SMART MEAL <span className="demo-pill">CSV-backed suggestions</span></div>
      <div className="feature-hero"><div><h1>Make the meal decision easier.</h1><p>Suggestions use available menu prices, ratings, delivery feedback, and your selected priorities. Every result explains its evidence.</p></div><div className="spark-card"><span className="spark">FL</span><b>Preference-aware ranking</b><small>{data?.model?.mode === 'trained' ? 'Model trained from simulated preferences, not real customer or health outcomes.' : 'Deterministic fallback over synthetic menu records.'}</small></div></div>
      <div className="smart-layout">
        <section className="card preference-card">
          <div className="section-heading"><div><span className="kicker">01</span><h2>Your preferences</h2></div></div>
          <label>Budget per person<input className="field" type="number" min="1" value={budget} onChange={event => setBudget(event.target.value)} aria-label="Budget per person" /></label>
          <label>People<input className="field" type="number" min="1" max="12" value={people} onChange={event => setPeople(event.target.value)} aria-label="Number of people" /></label>
          <label>Cuisine preference<select className="field" value={cuisine} onChange={event => setCuisine(event.target.value)}><option value="">Any cuisine</option>{cuisineOptions.map(value => <option key={value}>{value}</option>)}</select></label>
          <div className="toggle-row"><div><b>Vegetarian only</b><small className="muted">Exclude menu items not labeled vegetarian</small></div><button type="button" className={'toggle ' + (vegetarian ? 'on' : '')} onClick={() => setVegetarian(!vegetarian)} aria-pressed={vegetarian}><span /></button></div>
          <label>Delivery time limit, minutes<input className="field" type="number" min="1" max="240" value={maxEta} onChange={event => setMaxEta(event.target.value)} aria-label="Maximum delivery time" /></label>
          <label>Tonight&apos;s priority<select className="field" value={priority} onChange={event => setPriority(event.target.value as Priority | 'balanced')}>{PRIORITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {user && <details className="health-profile"><summary>Optional health and fitness profile</summary><p className="small muted">Only save information you choose to provide. FoodLens uses this for informational food discovery, not medical advice. You can delete it anytime.</p>
            <label className="toggle-row"><span>Save my health profile with explicit consent</span><input type="checkbox" checked={health.consented} onChange={event => setHealth({ ...health, consented: event.target.checked })} /></label>
            {health.consented && <div className="health-fields"><p className="small muted">When set, calorie is a maximum and protein is a minimum per serving. If FoodLens has no documented nutrition record, that item is excluded from matches.</p>
              <label>Age (18+)<input className="field" type="number" min="18" max="120" value={health.ageYears ?? ''} onChange={event => setHealth({ ...health, ageYears: event.target.value ? Number(event.target.value) : null })} /></label>
              <label>Height (cm)<input className="field" type="number" min="100" max="250" value={health.heightCm ?? ''} onChange={event => setHealth({ ...health, heightCm: event.target.value ? Number(event.target.value) : null })} /></label>
              <label>Weight (kg)<input className="field" type="number" min="25" max="350" value={health.weightKg ?? ''} onChange={event => setHealth({ ...health, weightKg: event.target.value ? Number(event.target.value) : null })} /></label>
              <label>Activity<select className="field" value={health.activityLevel ?? ''} onChange={event => setHealth({ ...health, activityLevel: event.target.value || null })}><option value="">Not specified</option>{['sedentary','light','moderate','active','very_active'].map(value => <option key={value} value={value}>{value.replace('_',' ')}</option>)}</select></label>
              <label>Goal<select className="field" value={health.goal ?? ''} onChange={event => setHealth({ ...health, goal: event.target.value || null })}><option value="">Not specified</option>{['maintenance','balanced','muscle_gain','weight_loss','high_protein'].map(value => <option key={value} value={value}>{value.replace('_',' ')}</option>)}</select></label>
              <label>Calorie target (optional)<input className="field" type="number" min="500" max="10000" value={health.calorieTarget ?? ''} onChange={event => setHealth({ ...health, calorieTarget: event.target.value ? Number(event.target.value) : null })} /></label>
              <label>Protein target, g (optional)<input className="field" type="number" min="0" max="500" value={health.proteinTargetG ?? ''} onChange={event => setHealth({ ...health, proteinTargetG: event.target.value ? Number(event.target.value) : null })} /></label>
              {health.heightCm && health.weightKg && <p className="small muted">BMI screening indicator: {(health.weightKg / ((health.heightCm / 100) ** 2)).toFixed(1)}. BMI is limited and is not a measure of health or a diet prescription.</p>}
            </div>}
            <div className="row"><button className="btn ghost" onClick={() => void saveHealth()}>Save profile</button>{health.consented && <button className="btn ghost" onClick={async () => { await api('/customer/health-profile', { method: 'DELETE' }); setHealth({ consented: false }); setHealthMessage('Health profile deleted.'); }}>Delete saved profile</button>}</div>{healthMessage && <p className="small muted" role="status">{healthMessage}</p>}
          </details>}
          <div className="constraint-note"><b>Allergy information is unavailable</b><p className="small muted">The CSVs do not contain verified ingredients or allergen data. Do not use these suggestions to assess allergy safety.</p></div>
        </section>
        <section>
          <div className="section-heading results-heading"><div><span className="kicker">02</span><h2>Menu matches</h2></div><span className="muted small">{data ? `${data.total} candidates ranked` : ''} · {data?.model?.name ?? 'deterministic fallback'}</span></div>
          {busy && <div className="state">Finding menu matches…</div>}
          {error && <div className="state error" role="alert">{error}</div>}
          {!busy && !error && data?.recommendations.length === 0 && <div className="state">{data.message ?? 'No menu matches found. Try a wider budget or another cuisine.'}</div>}
          <div className="recommendations">{data?.recommendations.map((item, index) => (
            <article className={'recommendation card ' + (index === 0 ? 'recommended' : '')} key={item.id}>
              <div className={`meal-art art-${index % 3}`}><span>{item.vegetarian ? 'VEG' : 'MENU'}</span></div>
              <div className="recommendation-body">
                <div className="row between"><div><span className="muted small">{item.cuisines.join(' · ') || 'Cuisine unavailable'}</span><h3>{item.itemName}</h3><p className="muted small">{item.restaurantName} · {item.area || 'Area unavailable'}</p></div><span className="fit-badge">{item.score.toFixed(0)} match score</span></div>
                <p className="reason">{item.providerName} · <FreshPill f={item.freshness} />{item.etaMin ? ` · ${item.etaMin} min reported` : ' · ETA unavailable'}</p>
                <div className="row wrap"><span className="price">{inr(item.estimatedSubtotal)}</span><span className="muted small">item price × quantity {item.people}, one per person; fees and tax excluded</span><span className="tag">Rating {item.rating == null ? 'unknown' : `${item.rating.toFixed(1)}/5`}</span></div>
                {nutrition[item.itemId] ? <div className="nutrition-card"><b>Nutrition · {nutrition[item.itemId].verificationStatus.replace(/_/g,' ')}</b><p>{nutrition[item.itemId].caloriesKcal ?? '—'} kcal · protein {nutrition[item.itemId].proteinG ?? '—'} g · carbs {nutrition[item.itemId].carbohydratesG ?? '—'} g · fat {nutrition[item.itemId].fatG ?? '—'} g</p><small className="muted">Serving {nutrition[item.itemId].servingSizeG ?? 'unknown'} g · {nutrition[item.itemId].sourceName} · {nutrition[item.itemId].estimationMethod}</small></div> : <p className="muted small nutrition-card">Nutrition unavailable: the synthetic menu rows lack ingredient and portion evidence. No calorie or macro values are inferred from dish names.</p>}
                <ul className="small muted">{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
                <details><summary>Ranking factors</summary>{item.factors.map(factor => <div className="factor" key={factor.factor}><span>{factor.factor} · weight {factor.weight}{!factor.known && ' · unknown, scored neutrally'}</span><div className="bar"><i className={factor.known ? '' : 'faded'} style={{ width: `${factor.value * 100}%` }} /></div></div>)}</details>
                <div className="row action-row"><Link className="btn" onClick={() => { if (user) void api('/customer/interactions', { method: 'POST', body: JSON.stringify({ eventType: 'recommendation_selected', restaurantId: item.restaurantId, cuisine: item.cuisines[0] ?? null }) }).catch(() => undefined); }} to={`/r/${encodeURIComponent(item.restaurantId)}?item=${encodeURIComponent(item.itemId)}&qty=${item.people}`}>Compare this menu item</Link></div>
              </div>
            </article>
          ))}</div>
          {data && <p className="muted small">{data.disclaimer}</p>}
        </section>
      </div>
    </div>
  );
}
