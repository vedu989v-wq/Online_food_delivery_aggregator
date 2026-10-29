import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, inr } from "../api";
import { useAuth, type CustomerProfile } from "../AuthContext";
import type { Detail, Meta, RecommendationResponse } from "../types";

const EMPTY_PROFILE: CustomerProfile = { city: null, area: null, preferredCuisines: [], vegetarianOnly: false, budgetPerPerson: null, priority: "value", interactionConsent: false };

export default function Dashboard() {
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState<CustomerProfile>(user?.profile ?? EMPTY_PROFILE);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationResponse | null>(null);
  const [saved, setSaved] = useState<Array<{ id: string; name: string; area: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [locationMessage, setLocationMessage] = useState("");

  useEffect(() => { if (user) setProfile(user.profile); }, [user]);

  const loadDashboard = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [metaResult, recommendationResult, savedResult] = await Promise.all([
        api<Meta>("/meta"),
        api<RecommendationResponse>("/customer/recommendations"),
        api<{ restaurants: Array<{ id: string }> }>("/customer/saved-restaurants"),
      ]);
      setMeta(metaResult);
      setRecommendations(recommendationResult);
      const details = await Promise.all(savedResult.restaurants.map(async entry => {
        try {
          const detail = await api<Detail>(`/restaurants/${encodeURIComponent(entry.id)}`);
          return { id: entry.id, name: detail.name, area: detail.area };
        } catch { return { id: entry.id, name: entry.id, area: "Record unavailable" }; }
      }));
      setSaved(details);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load your dashboard."); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void loadDashboard(); }, [loadDashboard, user?.id, user?.profile.city, user?.profile.area, user?.profile.priority, user?.profile.budgetPerPerson, user?.profile.vegetarianOnly, user?.profile.preferredCuisines.join("|")]);

  const cuisineOptions = meta?.cuisines ?? [];
  const sortedCuisines = useMemo(() => [...cuisineOptions].sort((a, b) => a.localeCompare(b)), [cuisineOptions]);
  const setField = <K extends keyof CustomerProfile>(key: K, value: CustomerProfile[K]) => setProfile(current => ({ ...current, [key]: value }));

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const normalized = { ...profile, city: profile.city || null, area: profile.area || null,
        budgetPerPerson: profile.budgetPerPerson == null || Number(profile.budgetPerPerson) <= 0 ? null : Number(profile.budgetPerPerson) };
      await api("/customer/profile", { method: "PATCH", body: JSON.stringify(normalized) });
      await refresh();
      setNotice("Your preferences are saved to your account.");
      await loadDashboard();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save your preferences."); }
    finally { setSaving(false); }
  }

  function requestLocation() {
    setLocationMessage("");
    if (!navigator.geolocation) { setLocationMessage("This browser does not provide geolocation. Choose a city manually."); return; }
    navigator.geolocation.getCurrentPosition(
      () => setLocationMessage("Permission granted. FoodLens uses city and area labels rather than coordinates, so choose a supported city below. Your coordinates were not saved."),
      error => setLocationMessage(error.code === error.PERMISSION_DENIED ? "Location permission was declined. You can still choose a city and area manually." : "Location could not be read. Choose a city and area manually."),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 },
    );
  }

  return <div className="feature-page">
    <div className="eyebrow">CUSTOMER SPACE <span className="demo-pill">Signed in as {user?.displayName}</span></div>
    <div className="feature-hero"><div><h1>Your food choices, with more context.</h1><p>Recommendations use your saved preferences and the current canonical synthetic dataset. Reasons are shown alongside each result.</p></div><div className="spark-card"><span className="spark">FL</span><b>{profile.city || "Choose your city"}</b><small>{profile.area || "Location is not set"}</small></div></div>

    <div className="dashboard-layout">
      <section className="card">
        <div className="section-heading"><div><span className="kicker">YOUR ACCOUNT</span><h2>Preferences</h2></div></div>
        <form className="profile-form" onSubmit={savePreferences}>
          <label>City<select className="field" value={profile.city ?? ""} onChange={event => { setField("city", event.target.value || null); setField("area", null); }}><option value="">Any supported city</option>{(meta?.cities ?? []).map(city => <option key={city} value={city}>{city}</option>)}</select></label>
          <label>Area <span className="muted small">Optional; limited to the dataset’s area labels</span><select className="field" value={profile.area ?? ""} onChange={event => setField("area", event.target.value || null)}><option value="">Any area</option>{(meta?.areas ?? []).map(area => <option key={area} value={area}>{area}</option>)}</select></label>
          <button type="button" className="btn ghost full" onClick={requestLocation}>Use location permission</button>
          {locationMessage && <p className="muted small" role="status">{locationMessage}</p>}
          <label>Budget per person (₹)<input className="field" type="number" min="1" max="1000000" value={profile.budgetPerPerson ?? ""} onChange={event => setField("budgetPerPerson", event.target.value ? Number(event.target.value) : null)} placeholder="No budget preference" /></label>
          <label>Comparison priority<select className="field" value={profile.priority} onChange={event => setField("priority", event.target.value as CustomerProfile["priority"])}><option value="value">Balanced value</option><option value="cheapest">Lowest listed cost</option><option value="fastest">Reported delivery time</option><option value="reliable">Review evidence</option><option value="rated">Provider rating</option></select></label>
          <fieldset className="cuisine-fieldset"><legend>Preferred cuisines</legend><div className="cuisine-options">{sortedCuisines.map(cuisine => <label key={cuisine}><input type="checkbox" checked={profile.preferredCuisines.includes(cuisine)} onChange={event => setField("preferredCuisines", event.target.checked ? [...profile.preferredCuisines, cuisine] : profile.preferredCuisines.filter(value => value !== cuisine))} />{cuisine}</label>)}</div></fieldset>
          <label className="check-row"><input type="checkbox" checked={profile.vegetarianOnly} onChange={event => setField("vegetarianOnly", event.target.checked)} /> Show vegetarian-labelled menu items only</label>
          <fieldset className="consent-box"><legend>Optional personalization</legend><label className="check-row"><input type="checkbox" checked={profile.interactionConsent} onChange={event => setField("interactionConsent", event.target.checked)} /> Allow FoodLens to use my restaurant saves and selected cuisine filters to personalize recommendations.</label><p className="muted small">This is optional, can be switched off here, and only applies to signed-in customer activity. Public demo actions are never collected.</p></fieldset>
          <button className="btn full" disabled={saving}>{saving ? "Saving…" : "Save preferences"}</button>
        </form>
      </section>

      <section className="stack">
        {error && <div className="state error" role="alert">{error} <button className="btn ghost" onClick={() => void loadDashboard()}>Retry</button></div>}
        {notice && <div className="state good" role="status">{notice}</div>}
        <div className="section-heading"><div><span className="kicker">CANONICAL DATASET</span><h2>Recommended for you</h2></div><Link to="/search">Search all restaurants</Link></div>
        {busy && <div className="state">Updating your recommendations…</div>}
        {!busy && recommendations?.recommendations.length === 0 && <div className="state">No menu items match these preferences in the current dataset. Try a broader city, area, cuisine, or budget.</div>}
        <div className="recommendations">{recommendations?.recommendations.slice(0, 6).map((item, index) => <article className="recommendation card" key={item.id}>
          <div className={`meal-art art-${index % 3}`}><span>{item.vegetarian ? "VEG-LABELLED" : "SAMPLE"}</span></div>
          <div className="recommendation-body"><span className="muted small">{item.cuisines.join(" · ") || "Cuisine unavailable"}</span><h3>{item.itemName}</h3><p className="muted">{item.restaurantName} · {item.area}</p>
            <p className="row wrap"><strong>{inr(item.estimatedSubtotal)}</strong><span className="muted small">listed item subtotal; fees and taxes excluded</span></p>
            <ul className="small muted">{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
            <Link className="btn" to={`/r/${encodeURIComponent(item.restaurantId)}?item=${encodeURIComponent(item.itemId)}`} onClick={() => { if (user?.profile.interactionConsent) void api("/customer/interactions", { method: "POST", body: JSON.stringify({ eventType: "recommendation_selected", restaurantId: item.restaurantId, cuisine: item.cuisines[0] }) }).catch(() => undefined); }}>Compare this item</Link>
          </div>
        </article>)}</div>
        {recommendations && <p className="muted small">{recommendations.disclaimer}</p>}
        <section className="card"><div className="section-heading"><div><span className="kicker">SAVED</span><h2>Your restaurants</h2></div></div>
          {saved.length === 0 ? <p className="muted">No saved restaurants yet. Save one from its comparison page.</p> : <div className="saved-list">{saved.map(restaurant => <Link className="saved-row" to={`/r/${encodeURIComponent(restaurant.id)}`} key={restaurant.id}><span><b>{restaurant.name}</b><small className="muted">{restaurant.area}</small></span><span aria-hidden="true">↗</span></Link>)}</div>}
        </section>
      </section>
    </div>
  </div>;
}
