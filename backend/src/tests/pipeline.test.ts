import test from "node:test";
import assert from "node:assert/strict";
import { normalize, similarity } from "../pipeline/text.js";
import { analyseReview } from "../intelligence/reputation.js";
import { priceBasket } from "../intelligence/pricing.js";
import type { Listing } from "../types.js";

test("normalisation handles spelling and punctuation variants",()=>{assert.equal(normalize("Biriyani House, M.G. Rd"),"biryani house m g road");assert.ok(similarity("Biryani House","Biryani House")===1);});
test("review analysis separates food praise from delivery criticism",()=>{const hits=analyseReview("The biryani was excellent, but delivery was late.");assert.ok(hits.some(h=>h.aspect==="food"&&h.sentiment===1));assert.ok(hits.some(h=>h.aspect==="delivery"&&h.sentiment===-1));});
test("pricing preserves unknown fees and labels lower bound",()=>{const listing:Listing={id:"p:1",providerId:"p",providerName:"P",providerTrust:.8,recordId:"1",name:"R",address:"A",area:"A",lat:null,lng:null,phone:null,cuisines:[],etaMinutes:null,deliveryFee:null,platformFee:null,rating:null,ratingCount:0,menu:[{id:"i",name:"Dish",price:100,vegetarian:true,available:true}],reviews:[],fetchedAt:new Date().toISOString(),url:"https://example.com",freshness:"fresh"};const result=priceBasket(listing,[{itemId:"i",quantity:1}]);assert.equal(result.isLowerBound,true);assert.equal(result.verified,false);assert.deepEqual(result.unknownFees,["delivery fee","platform fee"]);});
