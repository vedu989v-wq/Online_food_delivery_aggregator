import { Router } from "express";
import type { Request, Response } from "express";
import type { Priority } from "../types.js";
import { reputation } from "../intelligence/reputation.js";
import { priceBasket } from "../intelligence/pricing.js";
import { rankOptions } from "../intelligence/ranking.js";
import type { FoodLensStore } from "../pipeline/store.js";
const priorities: Priority[]=["best_value","cheapest","fastest","most_reliable","best_rated"];
const error=(res:Response,status:number,code:string,message:string)=>res.status(status).json({error:{code,message}});
export function createApi(store:FoodLensStore) {
 const router=Router();
 router.get("/meta",(_req,res)=>res.json({name:"FoodLens",dataMode:store.mode,synthetic:store.mode==="synthetic",notice:"Demo data only. No real provider data or ordering.",providers:[{id:"foodhub",name:"FoodHub"},{id:"quickbite",name:"QuickBite"},{id:"dinedash",name:"DineDash"}],priorities}));
 router.get("/health",(_req,res)=>res.json({status:"ok",uptimeSeconds:Math.floor(process.uptime())}));
 router.get("/search",(req,res)=>{
   const q=String(req.query.q??"").trim().toLowerCase(), cuisine=String(req.query.cuisine??"").toLowerCase();
   const page=Math.max(1,Number(req.query.page)||1), pageSize=Math.min(50,Math.max(1,Number(req.query.pageSize)||12));
   const minRating=req.query.minRating===undefined?null:Number(req.query.minRating);
   const maxEta=req.query.maxEta===undefined?null:Number(req.query.maxEta);
   let items=store.restaurants.map(r=>{
     const listings=store.listings.filter(l=>r.listingIds.includes(l.id));
     const queryText=[r.name,...r.cuisines,...r.menu.map(m=>m.name)].join(" ").toLowerCase();
     const ratings=listings.filter(l=>l.rating!==null).map(l=>l.rating as number);
     return {...r,listingCount:listings.length,providers:listings.map(l=>({id:l.providerId,name:l.providerName,etaMinutes:l.etaMinutes,freshness:l.freshness})),rating:ratings.length?ratings.reduce((a,b)=>a+b,0)/ratings.length:null,matchedDishPriceRange:null as null|{min:number;max:number},_queryText:queryText};
   }).filter(r=>(!q||q.split(/\s+/).every(token=>r._queryText.includes(token)))&&(!cuisine||r.cuisines.some(c=>c.toLowerCase().includes(cuisine)))&&(minRating===null||r.rating!==null&&r.rating>=minRating)&&(maxEta===null||r.providers.some(p=>p.etaMinutes!==null&&p.etaMinutes<=maxEta)));
   const total=items.length; items=items.slice((page-1)*pageSize,page*pageSize);
   res.json({items:items.map(({_queryText,...r})=>r),page,pageSize,total});
 });
 router.get("/restaurants/:id",(req,res)=>{
   const restaurant=store.restaurants.find(r=>r.id===req.params.id);
   if(!restaurant)return error(res,404,"NOT_FOUND","Restaurant not found");
   const listings=store.listings.filter(l=>restaurant.listingIds.includes(l.id));
   res.json({...restaurant,listings:listings.map(l=>({id:l.id,providerId:l.providerId,providerName:l.providerName,address:l.address,url:l.url,etaMinutes:l.etaMinutes,deliveryFee:l.deliveryFee,platformFee:l.platformFee,rating:l.rating,ratingCount:l.ratingCount,freshness:l.freshness,menu:l.menu,offer:l.offer,fetchedAt:l.fetchedAt})),reputation:reputation(restaurant,listings),observations:listings.flatMap(l=>[{providerId:l.providerId,attribute:"rating",value:l.rating,observedAt:l.fetchedAt},{providerId:l.providerId,attribute:"etaMinutes",value:l.etaMinutes,observedAt:l.fetchedAt},{providerId:l.providerId,attribute:"deliveryFee",value:l.deliveryFee,observedAt:l.fetchedAt}])});
 });
 router.post("/compare",(req,res)=>{
   const {restaurantId,selections,priority,maxEta}=req.body??{};
   if(typeof restaurantId!=="string")return error(res,400,"BAD_REQUEST","restaurantId is required");
   if(!Array.isArray(selections)||!selections.length||selections.some((s:any)=>typeof s.itemId!=="string"||!Number.isInteger(s.quantity)||s.quantity<1||s.quantity>20))return error(res,400,"BAD_REQUEST","selections must contain itemId and integer quantity from 1 to 20");
   if(!priorities.includes(priority))return error(res,400,"BAD_REQUEST",`priority must be one of: ${priorities.join(", ")}`);
   if(maxEta!==undefined&&maxEta!==null&&(!Number.isFinite(maxEta)||maxEta<=0))return error(res,400,"BAD_REQUEST","maxEta must be a positive number");
   const restaurant=store.restaurants.find(r=>r.id===restaurantId);
   if(!restaurant)return error(res,404,"NOT_FOUND","Restaurant not found");
   const listings=store.listings.filter(l=>restaurant.listingIds.includes(l.id));
   const rep=reputation(restaurant,listings);
   const options=listings.map(listing=>{
     const providerSelections = selections.map((selection:any) => {
       const canonicalItem = restaurant.menu.find(item => item.id === selection.itemId);
       const providerOffer = canonicalItem?.offers.find(offer => offer.providerId === listing.providerId);
       return { ...selection, itemId: providerOffer?.sourceItemId ?? selection.itemId };
     });
     const p=priceBasket(listing,providerSelections);
     const delivery=(rep.providerDelivery as any)[listing.providerId];
     const source=rep.sources.find(s=>s.providerId===listing.providerId);
     return {listing,pricing:p,reliability:delivery?.sufficientEvidence?delivery.score:null,rating:source?.adjustedRating??null};
   });
   res.json({...rankOptions(options,priority,maxEta??null),restaurantId,method:{reputation:rep.method,pricing:"estimate-v1",ranking:"weighted-heuristic-v1"}});
 });
 router.get("/admin/review-queue",(_req,res)=>res.json({items:store.candidates.filter(c=>c.status==="pending").map(c=>({...c,left:store.listings.find(l=>l.id===c.leftListingId),right:store.listings.find(l=>l.id===c.rightListingId)}))}));
 router.post("/admin/review-queue/:id/decision",(req,res)=>{
   const verdict=req.body?.verdict;
   if(verdict!=="merge"&&verdict!=="reject")return error(res,400,"BAD_REQUEST","verdict must be merge or reject");
   const ok=store.decide(req.params.id,verdict);
   if(!ok)return error(res,404,"NOT_FOUND","Review candidate not found");
   res.json({ok:true,decision:{candidateId:req.params.id,verdict},remaining:store.candidates.filter(c=>c.status==="pending").length,notice:"Decision is in-memory for this MVP and resets on restart."});
 });
 router.get("/admin/pipeline",(_req,res)=>res.json({counts:{raw:store.listings.length,validated:store.listings.length,canonicalRestaurants:store.restaurants.length,pendingCandidates:store.candidates.filter(c=>c.status==="pending").length,issues:store.issues.length},issues:store.issues}));
 return router;
}
