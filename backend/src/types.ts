export type Priority = "best_value" | "cheapest" | "fastest" | "most_reliable" | "best_rated";
export type Aspect = "food" | "delivery" | "value" | "service";

export interface Review {
  id: string; text: string; createdAt: string; rating?: number;
}
export interface MenuItem {
  id: string; name: string; price: number | null; vegetarian: boolean; available: boolean; portion?: "half" | "full" | "regular";
}
export interface RawListing {
  providerId: string; providerName: string; providerTrust: number; recordId: string;
  name: string; address: string; area: string; lat: number | null; lng: number | null;
  phone?: string | null; cuisines: string[]; etaMinutes: number | null;
  deliveryFee: number | null; platformFee: number | null; rating: number | null;
  ratingCount: number; menu: MenuItem[]; offer?: { percent: number; cap: number; minOrder: number } | null;
  reviews: Review[]; fetchedAt: string; url: string;
}
export interface Listing extends RawListing { id: string; freshness: "fresh" | "aging" | "stale"; }
export interface MatchCandidate {
  id: string; leftListingId: string; rightListingId: string; score: number;
  signals: { name: number; geography: number | null; address: number; phone: number | null; distanceMetres: number | null };
  status: "pending" | "merged" | "rejected";
}
export interface CanonicalRestaurant {
  id: string; name: string; area: string; lat: number | null; lng: number | null;
  phone: string | null; cuisines: string[]; listingIds: string[]; menu: Array<MenuItem & { offers: Array<{ providerId: string; providerName: string; price: number | null; available: boolean; sourceItemName: string; sourceItemId: string }> }>;
  conflicts: Array<{ attribute: string; severity: "info" | "warn"; description: string; policy: string }>;
}
export interface PipelineIssue { providerId: string; recordId: string; level: "warn" | "error"; reason: string; }
export interface ProviderAdapter { id: string; name: string; trust: number; fetch(): Promise<RawListing[]>; }
