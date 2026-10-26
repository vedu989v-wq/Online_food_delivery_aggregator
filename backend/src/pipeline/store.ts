import { adapters } from "../data/synthetic.js";
import type { CanonicalRestaurant, Listing, MatchCandidate, PipelineIssue, RawListing } from "../types.js";
import { validateListing } from "./validate.js";
import { buildCandidates, scorePair } from "./resolve.js";
import { similarity, haversine } from "./text.js";

export class FoodLensStore {
  listings: Listing[] = [];
  restaurants: CanonicalRestaurant[] = [];
  candidates: MatchCandidate[] = [];
  issues: PipelineIssue[] = [];
  mode = process.env.DATA_MODE ?? "synthetic";
  async init() {
    const settled = await Promise.allSettled(adapters.map(a => a.fetch()));
    const raw: RawListing[] = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") raw.push(...result.value);
      else this.issues.push({ providerId: adapters[i].id, recordId: "*", level:"error", reason:"Adapter failed: provider unavailable" });
    });
    this.listings = raw.map(r => validateListing(r, this.issues)).filter((x): x is Listing => x !== null);
    this.rebuild();
  }
  rebuild() {
    this.candidates = buildCandidates(this.listings);
    const groups: Listing[][] = [];
    const ordered = [...this.listings].sort((a,b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id));
    for (const listing of ordered) {
      let best: { group: Listing[]; score: number } | null = null;
      for (const group of groups) {
        if (group.some(x => x.providerId === listing.providerId)) continue;
        const scores = group.map(x => scorePair(x, listing).score);
        const score = Math.max(...scores);
        if (score >= .85 && (!best || score > best.score)) best = { group, score };
      }
      if (best) best.group.push(listing); else groups.push([listing]);
    }
    this.restaurants = groups.map((g, index) => {
      const nameSource = [...g].sort((a,b)=>b.providerTrust-a.providerTrust)[0];
      const latVals = g.map(x=>x.lat).filter((x):x is number=>x!==null).sort((a,b)=>a-b);
      const lngVals = g.map(x=>x.lng).filter((x):x is number=>x!==null).sort((a,b)=>a-b);
      const allItems = g.flatMap(l=>l.menu.map(m=>({ ...m, offers:[{ providerId:l.providerId, providerName:l.providerName, price:m.price, available:m.available, sourceItemName:m.name, sourceItemId:m.id }] })));
      const menu: CanonicalRestaurant["menu"] = [];
      for (const item of allItems) {
        const existing = menu.find(m => m.vegetarian === item.vegetarian && m.portion === item.portion && similarity(m.name,item.name) >= .72);
        if (existing) existing.offers.push(...item.offers); else menu.push({ ...item, offers:[...item.offers] });
      }
      const conflicts: CanonicalRestaurant["conflicts"] = [];
      if (new Set(g.map(x=>x.phone).filter(Boolean)).size > 1) conflicts.push({ attribute:"phone", severity:"warn", description:"Provider phone numbers disagree", policy:"Highest-trust majority vote" });
      const prices = g.flatMap(x=>x.menu.map(m=>m.price).filter((p):p is number=>p!==null));
      if (prices.length && (Math.max(...prices)-Math.min(...prices))/Math.max(1,Math.min(...prices)) > .1) conflicts.push({ attribute:"price", severity:"info", description:"Provider prices differ by more than 10%", policy:"Keep provider-specific prices" });
      return { id:`restaurant-${index+1}`, name:nameSource.name.replace(/\s*-\s*[^-]+$/, ""), area:nameSource.area,
        lat:latVals.length ? latVals[Math.floor(latVals.length/2)] : null, lng:lngVals.length ? lngVals[Math.floor(lngVals.length/2)] : null,
        phone:nameSource.phone ?? null, cuisines:[...new Set(g.flatMap(x=>x.cuisines))], listingIds:g.map(x=>x.id), menu, conflicts };
    });
  }
  decide(candidateId: string, verdict: "merge" | "reject") {
    const candidate = this.candidates.find(c=>c.id===candidateId);
    if (!candidate) return false;
    candidate.status = verdict === "merge" ? "merged" : "rejected";
    // Decision is auditable in memory for the MVP. A PostgreSQL-backed event table is the next persistence step.
    this.rebuild();
    this.candidates = this.candidates.filter(c=>c.status==="pending");
    return true;
  }
}
