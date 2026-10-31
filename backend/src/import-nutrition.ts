import { readFile } from "node:fs/promises";
import { closePool, query } from "./db.js";

interface RecordRow {
  dish_key: string; dish_name: string; serving_size_g: number;
  calories_kcal: number | null; protein_g: number | null; carbohydrates_g: number | null;
  fat_g: number | null; fiber_g: number | null; sodium_mg: number | null;
  source_name: string; source_reference: string; estimation_method: string;
  confidence_level: "high" | "medium" | "low";
  verification_status: "verified" | "database_derived_estimate" | "approximate";
}

const path = process.argv[2];
if (!path) throw new Error("Usage: npm run import:nutrition -- <nutrition_records.json>");
const records = JSON.parse(await readFile(path, "utf8")) as unknown;
if (!Array.isArray(records) || records.length > 10000) throw new Error("Expected a JSON array with at most 10,000 records");

try {
  for (const raw of records) {
    const row = raw as RecordRow;
    if (!row || typeof row.dish_key !== "string" || !/^[\w -]{1,200}$/.test(row.dish_key)
      || typeof row.dish_name !== "string" || !row.dish_name.trim()
      || !Number.isFinite(Number(row.serving_size_g)) || Number(row.serving_size_g) <= 0
      || !row.source_name || !row.source_reference || !row.estimation_method
      || !["high", "medium", "low"].includes(row.confidence_level)
      || !["verified", "database_derived_estimate", "approximate"].includes(row.verification_status)) {
      throw new Error("Invalid nutrition record or missing provenance");
    }
    const values = [row.calories_kcal, row.protein_g, row.carbohydrates_g, row.fat_g, row.fiber_g, row.sodium_mg];
    if (values.some(value => value != null && (!Number.isFinite(Number(value)) || Number(value) < 0))) throw new Error(`Invalid nutrient values for ${row.dish_key}`);
    await query(`INSERT INTO nutrition_records(dish_key,dish_name,serving_size_g,calories_kcal,protein_g,carbohydrates_g,fat_g,fiber_g,sodium_mg,source_name,source_reference,estimation_method,confidence_level,verification_status,last_updated)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
      ON CONFLICT(dish_key) DO UPDATE SET dish_name=excluded.dish_name,serving_size_g=excluded.serving_size_g,calories_kcal=excluded.calories_kcal,protein_g=excluded.protein_g,carbohydrates_g=excluded.carbohydrates_g,fat_g=excluded.fat_g,fiber_g=excluded.fiber_g,sodium_mg=excluded.sodium_mg,source_name=excluded.source_name,source_reference=excluded.source_reference,estimation_method=excluded.estimation_method,confidence_level=excluded.confidence_level,verification_status=excluded.verification_status,last_updated=now()`,
    [row.dish_key.trim().toLowerCase(), row.dish_name.trim(), row.serving_size_g, ...values, row.source_name, row.source_reference, row.estimation_method, row.confidence_level, row.verification_status]);
  }
  console.log(`Imported ${records.length} provenance-bearing nutrition records.`);
} finally { await closePool(); }
