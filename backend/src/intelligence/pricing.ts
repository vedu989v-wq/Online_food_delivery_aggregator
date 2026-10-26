import type { Listing, MenuItem } from "../types.js";
export interface Selection { itemId: string; quantity: number; }
export function priceBasket(listing: Listing, selections: Selection[]) {
  const missing: string[] = [], lines: Array<{itemId:string;name:string;quantity:number;unitPrice:number;lineTotal:number}> = [];
  for (const selection of selections) {
    const item=listing.menu.find(m=>m.id===selection.itemId);
    if (!item || !item.available || item.price===null) { missing.push(item?.name ?? selection.itemId); continue; }
    lines.push({itemId:item.id,name:item.name,quantity:selection.quantity,unitPrice:item.price,lineTotal:item.price*selection.quantity});
  }
  if (missing.length) return { providerId:listing.providerId,available:false,missingItems:missing,lines,subtotal:null,total:null,unknownFees:[],isLowerBound:false,verified:false };
  const subtotal=lines.reduce((s,l)=>s+l.lineTotal,0);
  const foodGst=subtotal*.05, unknownFees:string[]=[];
  const delivery=listing.deliveryFee, platform=listing.platformFee;
  if (delivery===null) unknownFees.push("delivery fee"); if (platform===null) unknownFees.push("platform fee");
  const knownDelivery=delivery??0, knownPlatform=platform??0;
  const eligibleOffer=listing.offer && subtotal>=listing.offer.minOrder ? Math.min(listing.offer.cap,subtotal*listing.offer.percent/100) : 0;
  const gstOnFees=(knownDelivery+knownPlatform)*.18;
  const total=subtotal+foodGst+knownDelivery+knownPlatform+gstOnFees-eligibleOffer;
  return {providerId:listing.providerId,available:true,lines,subtotal,foodGst,deliveryFee:delivery,platformFee:platform,gstOnFees,discount:eligibleOffer,
    amountToOfferMinimum:listing.offer?Math.max(0,listing.offer.minOrder-subtotal):0,total,unknownFees,isLowerBound:unknownFees.length>0,verified:false,
    disclaimer:"Estimate only. Assumes 5% GST on food and 18% GST on fees; discounts are simplified. Not a checkout quote."};
}
