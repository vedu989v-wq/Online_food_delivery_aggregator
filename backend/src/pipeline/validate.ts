import type { RawListing, Listing, PipelineIssue } from "../types.js";
export function validateListing(raw: RawListing, issues: PipelineIssue[]): Listing | null {
  const issue = (level: "warn" | "error", reason: string) => issues.push({ providerId: raw.providerId, recordId: raw.recordId, level, reason });
  if (!raw.name?.trim()) { issue("error", "Missing restaurant name"); return null; }
  if ((raw.lat !== null && (raw.lat < -90 || raw.lat > 90)) || (raw.lng !== null && (raw.lng < -180 || raw.lng > 180))) {
    issue("error", "Coordinates outside valid range"); return null;
  }
  if (raw.rating !== null && (raw.rating < 0 || raw.rating > 5)) { raw.rating = null; issue("warn", "Invalid rating set to unknown"); }
  if (raw.etaMinutes !== null && (raw.etaMinutes <= 0 || raw.etaMinutes >= 300)) { raw.etaMinutes = null; issue("warn", "Invalid ETA set to unknown"); }
  raw.menu = raw.menu.filter(item => {
    if (item.price === null) return true;
    if (item.price <= 0) { issue("warn", `Dropped non-positive price for ${item.name}`); return false; }
    return true;
  });
  const age = Math.max(0, Date.now() - new Date(raw.fetchedAt).getTime()) / 60000;
  const freshness = age <= 30 ? "fresh" : age <= 180 ? "aging" : "stale";
  return { ...raw, id: `${raw.providerId}:${raw.recordId}`, freshness };
}
