import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { inr } from "../api";

const fixture = {
  restaurant: "Sample Curry House",
  location: "Illustrative · Bengaluru",
  items: [
    { id: "bowl", name: "Paneer curry bowl", prices: { A: 220, B: 240 } },
    { id: "rice", name: "Jeera rice", prices: { A: 95, B: 90 } },
    { id: "naan", name: "Garlic naan", prices: { A: 65, B: 70 } },
    { id: "lassi", name: "Mango lassi", prices: { A: 88, B: null } },
  ],
};

export default function Demo() {
  const [quantities, setQuantities] = useState<Record<string, number>>({ bowl: 1, rice: 1, naan: 1, lassi: 2 });
  const totals = useMemo(() => ["A", "B"].map(provider => {
    let subtotal = 0;
    let unknownCount = 0;
    for (const item of fixture.items) {
      const quantity = quantities[item.id] || 0;
      if (!quantity) continue;
      const price = item.prices[provider as "A" | "B"];
      if (price == null) unknownCount += quantity;
      else subtotal += price * quantity;
    }
    return { provider, subtotal, unknownCount };
  }), [quantities]);

  const changeQuantity = (id: string, value: number) => setQuantities(current => ({ ...current, [id]: Math.max(0, Math.min(8, value)) }));
  return <div className="feature-page">
    <div className="eyebrow">PUBLIC DEMO <span className="demo-pill">Illustrative fixtures · isolated</span></div>
    <div className="feature-hero"><div><h1>Try a basket comparison.</h1><p>Adjust sample quantities and see how FoodLens communicates known item prices and missing information. These fixtures are not provider data and are not saved.</p></div><div className="spark-card"><span className="spark">FL</span><b>Nothing is recorded</b><small>This demo does not call customer APIs.</small></div></div>
    <div className="demo-layout">
      <section className="card"><span className="kicker">SAMPLE RESTAURANT</span><h2>{fixture.restaurant}</h2><p className="muted">{fixture.location} · not a real listing</p>
        {fixture.items.map(item => <div className="item" key={item.id}><div><b>{item.name}</b><small className="muted">Illustrative prices only</small></div><div className="stepper"><button aria-label={`Remove one ${item.name}`} onClick={() => changeQuantity(item.id, (quantities[item.id] || 0) - 1)}>−</button><span aria-live="polite">{quantities[item.id] || 0}</span><button aria-label={`Add one ${item.name}`} onClick={() => changeQuantity(item.id, (quantities[item.id] || 0) + 1)}>+</button></div></div>)}
      </section>
      <section><div className="section-heading"><div><span className="kicker">SAMPLE ESTIMATES</span><h2>Compare the selected items</h2></div></div>
        <div className="grid cards">{totals.map(total => <article className="card demo-total" key={total.provider}><span className="demo-provider">Provider {total.provider}</span><h3>{total.unknownCount ? `${inr(total.subtotal)} + unknown` : inr(total.subtotal)}</h3><p className="muted">{total.unknownCount ? `${total.unknownCount} selected item price(s) not supplied.` : "All selected sample item prices are present."}</p><span className="tag">Illustrative total</span></article>)}</div>
        <div className="state">These example amounts are invented interface fixtures. Fees, discounts, taxes, availability, and checkout totals are not modelled here.</div>
        <div className="row wrap"><Link className="btn" to="/login">Create a customer account</Link><Link className="btn ghost" to="/search">Explore the canonical demo dataset</Link></div>
      </section>
    </div>
  </div>;
}
