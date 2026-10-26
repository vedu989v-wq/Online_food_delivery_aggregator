import express from "express";
import cors from "cors";
import { FoodLensStore } from "./pipeline/store.js";
import { createApi } from "./routes/api.js";

const app=express();
const port=Number(process.env.PORT)||4000;
app.use(cors({origin:process.env.CORS_ORIGIN?.split(",")??"http://localhost:5173"}));
app.use(express.json({limit:"1mb"}));
app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");next();});
const store=new FoodLensStore();
app.get("/",(_req,res)=>res.json({name:"FoodLens API",docs:"See README.md",health:"/api/health"}));
app.use("/api",createApi(store));
app.use((_req,res)=>res.status(404).json({error:{code:"NOT_FOUND",message:"Route not found"}}));
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  console.error("Unhandled API error",err);res.status(500).json({error:{code:"INTERNAL_ERROR",message:"Unexpected server error"}});
});
await store.init();
app.listen(port,()=>console.log(`FoodLens API listening on http://localhost:${port}`));
