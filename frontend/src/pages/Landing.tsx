import { Link } from "react-router-dom";

export default function Landing() {
  return <div className="landing">
    <section className="landing-hero">
      <div className="landing-copy">
        <span className="eyebrow">A clearer way to choose</span>
        <h1>Good food decisions start with the whole picture.</h1>
        <p>Explore menus, compare what’s known across providers, and see why a recommendation fits. FoodLens is a research demo built on clearly labelled synthetic data.</p>
        <div className="landing-actions"><Link className="primary-button" to="/demo">Try the interactive demo <span>↗</span></Link><Link className="btn ghost" to="/search">Explore dataset</Link></div>
        <small className="muted">No account needed to explore. Demo choices stay separate from customer accounts.</small>
      </div>
      <div className="compare-preview" aria-label="Illustrative provider comparison preview">
        <div className="preview-top"><span className="demo-pill">Illustrative preview</span><span className="muted small">Same basket · sample totals</span></div>
        <div className="preview-basket"><b>Two-person dinner</b><span>Paneer bowl · Jeera rice</span><span>Garlic naan · 2 × mango lassi</span></div>
        <div className="preview-option preview-best"><span className="preview-mark">A</span><div><b>Provider A</b><small>Known items · fees not supplied</small></div><strong>₹486+</strong></div>
        <div className="preview-option"><span className="preview-mark preview-mark-gold">B</span><div><b>Provider B</b><small>One item price unavailable</small></div><strong>Unknown</strong></div>
        <p className="preview-foot">Unknown charges remain unknown. No checkout price is verified.</p>
      </div>
    </section>

    <section className="landing-section">
      <div><span className="eyebrow">How FoodLens helps</span><h2>Compare with context, not guesswork.</h2><p className="muted">Use the information the dataset actually provides, with missing details made visible.</p></div>
      <div className="landing-steps">
        <article className="card"><span className="step-number">01</span><h3>Find a dish or place</h3><p className="muted">Search canonical restaurant and menu records by name, cuisine, or supported location.</p></article>
        <article className="card"><span className="step-number">02</span><h3>Build a basket</h3><p className="muted">Choose menu items and compare supported provider listings and recorded charges.</p></article>
        <article className="card"><span className="step-number">03</span><h3>Understand the estimate</h3><p className="muted">See ranking factors, evidence freshness, and unknown fees before drawing conclusions.</p></article>
      </div>
    </section>

    <section className="landing-callout"><div><span className="eyebrow">Start with a sample</span><h2>Try a comparison without creating an account.</h2><p>Demo meals use isolated illustrative fixtures. They never update restaurant records or customer activity.</p></div><Link className="primary-button" to="/demo">Open the demo</Link></section>
    <section className="landing-disclaimer"><b>Data note</b><p>The restaurant and provider datasets are synthetic. FoodLens does not fetch live prices, verify availability, access third-party accounts, place orders, or confirm savings.</p></section>
  </div>;
}
