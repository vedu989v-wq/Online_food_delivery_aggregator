import type { Listing, MatchCandidate } from "../types.js";
import { haversine, jaccard, similarity } from "./text.js";
export function scorePair(a: Listing, b: Listing) {
  const name = Math.max(similarity(a.name, b.name), jaccard(a.name, b.name));
  const distance = a.lat !== null && a.lng !== null && b.lat !== null && b.lng !== null ? haversine(a.lat,a.lng,b.lat,b.lng) : null;
  const geography = distance === null ? null : distance <= 100 ? 1 : distance >= 500 ? 0 : 1 - (distance-100)/400;
  const address = jaccard(a.address, b.address);
  const phone = a.phone && b.phone ? (a.phone.replace(/\D/g,"").slice(-10) === b.phone.replace(/\D/g,"").slice(-10) ? 1 : 0) : null;
  let score = phone === null ? .4*name + .35*(geography ?? .5) + .25*address : .3*name + .25*(geography ?? .5) + .2*address + .25*phone;
  if (distance !== null && distance > 500) score = 0;
  if (phone === 0) score = Math.min(score, .84);
  return { score, signals: { name, geography, address, phone, distanceMetres: distance } };
}
export function buildCandidates(listings: Listing[]): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  for (let i=0; i<listings.length; i++) for (let j=i+1; j<listings.length; j++) {
    const a=listings[i], b=listings[j];
    if (a.providerId === b.providerId) continue;
    const pair=scorePair(a,b);
    if (pair.score >= .60 && pair.score < .85) candidates.push({ id: `${a.id}__${b.id}`, leftListingId:a.id, rightListingId:b.id, ...pair, status:"pending" });
  }
  return candidates;
}
