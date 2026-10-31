import { Router } from "express";
import { query } from "./db.js";

export const smartmealRouter = Router();

smartmealRouter.get("/nutrition", async (req, res) => {
  const raw = typeof req.query.itemIds === "string" ? req.query.itemIds : "";
  const itemIds = [...new Set(raw.split(",").map(value => value.trim()).filter(value => /^[\w -]{1,200}$/.test(value)))].slice(0, 50);
  if (!itemIds.length) return res.status(400).json({ error: { code: "ITEM_IDS_REQUIRED", message: "Provide up to 50 menu item IDs." } });
  try {
    const rows = await query(`SELECT dish_key AS "itemId",dish_name AS "dishName",serving_size_g AS "servingSizeG",calories_kcal AS "caloriesKcal",protein_g AS "proteinG",carbohydrates_g AS "carbohydratesG",fat_g AS "fatG",fiber_g AS "fiberG",sodium_mg AS "sodiumMg",source_name AS "sourceName",source_reference AS "sourceReference",estimation_method AS "estimationMethod",confidence_level AS "confidenceLevel",verification_status AS "verificationStatus",last_updated AS "lastUpdated" FROM nutrition_records WHERE dish_key=ANY($1::text[])`, [itemIds]);
    const found = new Set(rows.rows.map(row => row.itemId));
    const records = rows.rows.map(row => ({ ...row, status: row.verificationStatus }));
    const unavailable = itemIds.filter(id => !found.has(id)).map(itemId => ({ itemId, status: "unavailable", reason: "No dish-specific nutrition record with documented ingredients and serving size is available." }));
    return res.json({ records, unavailable, disclaimer: "Nutrition is displayed only when a documented dish-specific record exists. Menu names alone cannot establish ingredients, portion size, oil, or nutrient amounts." });
  } catch { return res.status(503).json({ error: { code: "NUTRITION_UNAVAILABLE", message: "Nutrition records are temporarily unavailable." } }); }
});
