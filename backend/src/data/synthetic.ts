import type { ProviderAdapter, RawListing, MenuItem, Review } from "../types.js";

const now = new Date().toISOString();
const menu = (prefix: string): MenuItem[] => [
  { id: `${prefix}-biryani`, name: "Chicken Dum Biryani Full", price: 249, vegetarian: false, available: true, portion: "full" },
  { id: `${prefix}-paneer`, name: "Paneer Butter Masala", price: 219, vegetarian: true, available: true, portion: "regular" },
  { id: `${prefix}-half`, name: "Chicken Dum Biryani Half", price: 149, vegetarian: false, available: true, portion: "half" }
];
const reviews: Review[] = [
  { id: "r1", text: "The biryani was excellent but delivery was late.", createdAt: now, rating: 4 },
  { id: "r2", text: "Great flavour and good value for money.", createdAt: now, rating: 5 },
  { id: "r3", text: "Food was tasty, however the packaging was poor.", createdAt: now, rating: 3 }
];
function listing(providerId: string, providerName: string, trust: number, recordId: string, name: string, lat: number, lng: number, prices: number[], fee: number | null, eta: number | null): RawListing {
  const m = menu(`${providerId}-${recordId}`).map((item, i) => ({ ...item, price: prices[i] }));
  return { providerId, providerName, providerTrust: trust, recordId, name, address: "Vesu Main Road, Surat", area: "Vesu", lat, lng, phone: "9876543210",
    cuisines: ["North Indian", "Biryani"], etaMinutes: eta, deliveryFee: fee, platformFee: null, rating: 4.2, ratingCount: providerId === "foodhub" ? 420 : 180,
    menu: m, offer: { percent: 10, cap: 60, minOrder: 299 }, reviews: reviews.map(r => ({ ...r })), fetchedAt: now, url: `https://example.com/demo/${providerId}/${recordId}` };
}
export const adapters: ProviderAdapter[] = [
  { id: "foodhub", name: "FoodHub", trust: 0.95, async fetch() { return [
    listing("foodhub", "FoodHub", 0.95, "101", "Biryani House - Vesu", 21.1402, 72.7701, [249,219,149], 25, 32),
    listing("foodhub", "FoodHub", 0.95, "102", "Biryani House - Adajan", 21.1880, 72.7930, [239,209,139], 20, 38),
    listing("foodhub", "FoodHub", 0.95, "103", "Biryani Hub", 21.1410, 72.7710, [229,199,139], 30, 35)
  ]; } },
  { id: "quickbite", name: "QuickBite", trust: 0.85, async fetch() { return [
    listing("quickbite", "QuickBite", 0.85, "201", "Biryani House", 21.1405, 72.7703, [259,229,159], 15, 28),
    listing("quickbite", "QuickBite", 0.85, "202", "Biryani House", 21.1407, 72.7700, [255,225,155], null, null)
  ]; } },
  { id: "dinedash", name: "DineDash", trust: 0.75, async fetch() { return [
    listing("dinedash", "DineDash", 0.75, "301", "Biryani House", 21.1403, 72.7702, [269,239,169], 20, 41)
  ]; } }
];
