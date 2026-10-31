export type Priority = 'cheapest' | 'fastest' | 'reliable' | 'rated' | 'value';
export interface Fresh { ageMin: number | null; status: 'fresh' | 'aging' | 'stale' }
export interface Meta { dataMode: string; notice: string; providers: { id: string; name: string }[]; cuisines?: string[]; cities?: string[]; areas?: string[]; adminDemoEnabled?: boolean }
export interface SearchResult {
  id: string;
  name: string;
  area: string;
  cuisines: string[];
  rating: { combined: number | null; evidence: string };
  matchedItems: { name: string; minPrice: number | null; maxPrice: number | null; providers: number }[];
  providers: { id: string; name: string; etaMin: number | null; freshness: Fresh }[];
}
export interface Offer { providerId: string; providerName: string; providerItemName: string; price: number | null; available: boolean }
export interface Item { id: string; name: string; veg: boolean; portion: string; offers: Offer[] }
export interface Agg { score: number | null; mentions: number; enough: boolean }
export interface Reputation {
  evidence: string;
  reviewsAnalyzed: number;
  duplicatesRemoved: number;
  method: string;
  disclaimer: string;
  rating: { combined: number | null; perSource: { providerId: string; raw: number; count: number; adjusted: number }[] };
  foodQuality: { value: number; basis: string } | null;
  aspects: Record<'food' | 'delivery' | 'value' | 'service', Agg>;
  providerDelivery: Record<string, Agg>;
  highlights: {
    positive: { aspect: string; snippet: string; providerId: string }[];
    negative: { aspect: string; snippet: string; providerId: string }[];
  };
}
export interface Listing {
  providerId: string;
  providerName: string;
  recordId: string;
  providerListingName: string;
  etaMin: number | null;
  deliveryFee: number | null;
  platformFee: number | null;
  rating: number | null;
  ratingCount: number | null;
  url: string;
  fetchedAt: string;
  freshness: Fresh;
}
export interface Conflict { attribute: string; severity: string; detail: string; policy: string }
export interface Observation { attribute: string; value: string | number | null; providerId: string; observedAt: string; confidence: number }
export interface Detail {
  id: string;
  name: string;
  area: string;
  phone: string | null;
  cuisines: string[];
  listings: Listing[];
  items: Item[];
  reputation: Reputation;
  conflicts: Conflict[];
  observations: Observation[];
}
export interface Pricing {
  subtotal: number;
  foodTax: number;
  deliveryFee: number | null;
  platformFee: number | null;
  feeTax: number;
  discount: number;
  discountNote: string | null;
  total: number;
  isLowerBound: boolean;
  unknowns: string[];
  assumptions: string[];
  verified: boolean;
}
export interface Option {
  rank: number;
  providerId: string;
  providerName: string;
  url: string;
  etaMin: number | null;
  freshness: Fresh;
  pricing: Pricing;
  score: number;
  badges: string[];
  reasons: string[];
  factors: { factor: string; weight: number; value: number; contribution: number; known: boolean }[];
}
export interface Compare {
  options: Option[];
  excluded: { providerId: string; providerName: string; reason: string }[];
  weights?: Record<string, number>;
  disclaimer: string;
}
export interface Recommendation {
  id: string;
  restaurantId: string;
  restaurantName: string;
  area: string;
  cuisines: string[];
  itemId: string;
  itemName: string;
  vegetarian: boolean;
  unitPrice: number;
  estimatedSubtotal: number;
  people: number;
  providerId: string;
  providerName: string;
  etaMin: number | null;
  freshness: Fresh;
  rating: number | null;
  ratingCount: number;
  score: number;
  reasons: string[];
  factors: { factor: string; weight: number; value: number; known: boolean }[];
}
export interface RecommendationResponse {
  total: number;
  recommendations: Recommendation[];
  priority: Priority;
  weights: Record<string, number>;
  message?: string;
  disclaimer: string;
  model?: { mode: 'trained' | 'fallback'; name: string; version?: string };
}
export interface ReviewSignalsResponse {
  totalReviews: number;
  signalCount: number;
  signals: { type: string; reviewCount: number; providers?: string[]; provider?: string; date?: string; excerpt?: string; reason: string; reviewIds: string[] }[];
  disclaimer: string;
}
