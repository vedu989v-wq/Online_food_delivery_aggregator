import type { CanonicalRestaurant, Listing, Aspect } from "../types.js";
const positive = ["excellent","great","good","tasty","delicious","fresh","quick","friendly","value"];
const negative = ["late","slow","cold","poor","bad","stale","rude","expensive","wrong"];
const aspectWords: Record<Aspect,string[]> = {
  food:["biryani","food","flavour","taste","tasty","dish","meal"], delivery:["delivery","driver","arrived","late","packaging"],
  value:["value","price","expensive","cost","money","cheap"], service:["service","staff","rude","friendly","support"]
};
function normal(s:string) { return s.toLowerCase().replace(/[^a-z\s]/g," ").replace(/\s+/g," ").trim(); }
export function analyseReview(text:string) {
  const clauses = text.split(/\bbut\b|\bhowever\b|[.!?;,]/i).filter(Boolean);
  const result: Array<{aspect:Aspect; sentiment:number; clause:string}> = [];
  for (const raw of clauses) {
    const clause=normal(raw), words=clause.split(" ");
    const pos=words.filter(w=>positive.includes(w)).length, neg=words.filter(w=>negative.includes(w)).length;
    let sentiment=Math.sign(pos-neg);
    if (words.some(w=>["not","never","no"].includes(w))) sentiment *= -1;
    if (!sentiment) continue;
    for (const aspect of Object.keys(aspectWords) as Aspect[]) if (aspectWords[aspect].some(w=>clause.includes(w))) result.push({aspect,sentiment,clause:raw.trim()});
  }
  return result;
}
export function reputation(restaurant: CanonicalRestaurant, listings: Listing[]) {
  const relevant=listings.filter(l=>restaurant.listingIds.includes(l.id));
  const seen=new Set<string>(); let duplicateReviewsRemoved=0;
  const byAspect: Record<Aspect,{sum:number;count:number}> = { food:{sum:0,count:0},delivery:{sum:0,count:0},value:{sum:0,count:0},service:{sum:0,count:0} };
  const providerDelivery: Record<string,{sum:number;count:number}> = {};
  for (const listing of [...relevant].sort((a,b)=>b.providerTrust-a.providerTrust)) for (const review of listing.reviews) {
    const key=normal(review.text);
    if (seen.has(key)) { duplicateReviewsRemoved++; continue; } seen.add(key);
    const ageDays=Math.max(0,(Date.now()-new Date(review.createdAt).getTime())/86400000);
    const weight=Math.pow(.5,ageDays/90);
    for (const hit of analyseReview(review.text)) {
      byAspect[hit.aspect].sum += hit.sentiment*weight; byAspect[hit.aspect].count++;
      if (hit.aspect==="delivery") { providerDelivery[listing.providerId] ??={sum:0,count:0}; providerDelivery[listing.providerId].sum += hit.sentiment*weight; providerDelivery[listing.providerId].count++; }
    }
  }
  const aspects=Object.fromEntries((Object.keys(byAspect) as Aspect[]).map(a=>[a,{score:(1+(byAspect[a].sum/(byAspect[a].count+1)))/2,mentions:byAspect[a].count,sufficientEvidence:byAspect[a].count>=3}]));
  const sources=relevant.map(l=>({providerId:l.providerId,providerName:l.providerName,rawRating:l.rating,ratingCount:l.ratingCount,
    adjustedRating:l.rating===null?null:(l.rating*l.ratingCount+3.9*30)/(l.ratingCount+30)}));
  const weighted=sources.filter(s=>s.adjustedRating!==null).reduce((acc,s)=>({sum:acc.sum+s.adjustedRating!*Math.log1p(s.ratingCount),weight:acc.weight+Math.log1p(s.ratingCount)}),{sum:0,weight:0});
  return { method:"lexicon-baseline-v0", disclaimer:"Heuristic word-list baseline; not a validated sentiment model or verified fact.", duplicateReviewsRemoved,
    combinedRating:weighted.weight?weighted.sum/weighted.weight:null, sources, aspects,
    providerDelivery:Object.fromEntries(Object.entries(providerDelivery).map(([id,v])=>[id,{score:(1+v.sum/(v.count+1))/2,mentions:v.count,sufficientEvidence:v.count>=3}])) };
}
