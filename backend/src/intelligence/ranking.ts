import type { Listing, Priority } from "../types.js";
const WEIGHTS: Record<Priority,{cost:number;eta:number;reliability:number;rating:number}> = {
  best_value:{cost:.4,eta:.2,reliability:.25,rating:.15}, cheapest:{cost:.7,eta:.1,reliability:.1,rating:.1},
  fastest:{cost:.1,eta:.7,reliability:.1,rating:.1}, most_reliable:{cost:.1,eta:.15,reliability:.65,rating:.1},
  best_rated:{cost:.1,eta:.1,reliability:.2,rating:.6}
};
const normLower=(v:number,min:number,max:number)=>max===min?.5:1-(v-min)/(max-min);
export function rankOptions(options:Array<{listing:Listing;pricing:any;reliability:number|null;rating:number|null}>,priority:Priority,maxEta?:number|null) {
  const excluded:any[]=[], eligible=options.filter(o=>{
    if (!o.pricing.available) { excluded.push({providerId:o.listing.providerId,reason:`Cannot supply: ${o.pricing.missingItems.join(", ")}`}); return false; }
    if (maxEta && o.listing.etaMinutes!==null && o.listing.etaMinutes>maxEta) { excluded.push({providerId:o.listing.providerId,reason:`ETA ${o.listing.etaMinutes} min exceeds ${maxEta} min limit`}); return false; }
    return true;
  });
  const costs=eligible.map(o=>o.pricing.total as number), etas=eligible.map(o=>o.listing.etaMinutes).filter((n):n is number=>n!==null);
  const weights=WEIGHTS[priority];
  const ranked=eligible.map(o=>{
    const factors={cost:o.pricing.total===null?.5:normLower(o.pricing.total,Math.min(...costs),Math.max(...costs)),
      eta:o.listing.etaMinutes===null?.5:etas.length?normLower(o.listing.etaMinutes,Math.min(...etas),Math.max(...etas)):.5,
      reliability:o.reliability??.5,rating:o.rating===null?.5:(o.rating-1)/4};
    const freshnessPenalty=o.listing.freshness==="fresh"?0:o.listing.freshness==="aging"?.02:.06;
    const score=Object.entries(weights).reduce((sum,[key,w])=>sum+factors[key as keyof typeof factors]*w,0)-freshnessPenalty;
    return {providerId:o.listing.providerId,providerName:o.listing.providerName,score,factors,weights,freshness:o.listing.freshness,
      etaMinutes:o.listing.etaMinutes,pricing:o.pricing,reasons:Object.entries(factors).map(([k,v])=>`${k}: ${v.toFixed(2)} × ${(weights[k as keyof typeof weights]*100).toFixed(0)}%`),badges:[] as string[]};
  }).sort((a,b)=>b.score-a.score);
  if(ranked.length) {
    const cheapest=[...ranked].sort((a,b)=>(a.pricing.total??Infinity)-(b.pricing.total??Infinity))[0]; cheapest.badges.push("Cheapest");
    const fastest=ranked.filter(x=>x.etaMinutes!==null).sort((a,b)=>(a.etaMinutes??Infinity)-(b.etaMinutes??Infinity))[0]; if(fastest) fastest.badges.push("Fastest");
    ranked[0].badges.push("Best for selected priority");
  }
  return {priority,weights,ranked,excluded,disclaimer:"Scores are explainable heuristics with unvalidated weights, not a guarantee of the best choice."};
}
