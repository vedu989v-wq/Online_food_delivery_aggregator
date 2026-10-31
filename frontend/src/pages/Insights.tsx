import { Link } from 'react-router-dom';

export function Sustainability() {
  return (
    <div className="feature-page">
      <div className="eyebrow">SUSTAINABILITY <span className="demo-pill">Data unavailable</span></div>
      <div className="feature-hero"><div><h1>Understand impact when the data supports it.</h1><p>FoodLens does not currently have verified ingredient footprints, packaging data, or delivery distances to calculate an environmental score.</p></div><div className="spark-card"><span className="spark">—</span><b>No impact score yet</b><small>Missing inputs remain unknown.</small></div></div>
      <div className="insight-grid">
        <section className="card"><span className="kicker">AVAILABLE TODAY</span><h2>Menu facts</h2><p className="muted">The synthetic menu records include vegetarian labels for some items. Those labels can filter recommendations, but they are not a carbon footprint or proof of lower environmental impact.</p><Link className="btn" to="/smart-meal">Explore menu matches</Link></section>
        <section className="card"><span className="kicker">DATA NEEDED</span><h2>Evidence for impact</h2><ul className="muted"><li>Ingredient quantities and sourcing</li><li>Packaging type and weight</li><li>Delivery distance and transport mode</li><li>A documented calculation method</li></ul></section>
      </div>
      <section className="card method-card"><span className="kicker">HONEST LABELS</span><h2>No invented footprint estimates</h2><p className="muted">This page will show calculated estimates only when the required inputs and method are available. No choices or emissions are currently persisted for users.</p></section>
    </div>
  );
}

export function Savings() {
  return (
    <div className="feature-page">
      <div className="eyebrow">MY SAVINGS <span className="demo-pill">History unavailable</span></div>
      <div className="feature-hero"><div><h1>Your comparison history will live here.</h1><p>The current MVP does not save comparisons, orders, or verified checkout totals. Customer accounts and preferences can be saved when PostgreSQL is configured.</p></div><div className="spark-card"><span className="spark">—</span><b>No saved total</b><small>Nothing has been counted as money saved.</small></div></div>
      <section className="card history-card"><span className="kicker">NOT RECORDED</span><h2>No comparison history yet</h2><p className="muted">A lower estimate across providers is not confirmed savings. We would need a saved comparison baseline and an actual checkout amount to report savings responsibly.</p><Link className="btn" to="/search">Compare a basket</Link></section>
    </div>
  );
}
