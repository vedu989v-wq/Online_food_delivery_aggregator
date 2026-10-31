"""Create documented dish-level estimates from USDA FDC foods and explicit recipe weights.

Input JSON schema: [{"dish_key":"...","dish_name":"...","serving_size_g":350,
"ingredients":[{"fdc_id":123,"grams":80}, ...]}]. Ingredient weights must be
per serving; the script never infers ingredients or portion sizes from dish names.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.request import urlopen

NUTRIENTS = {1008: "calories_kcal", 1003: "protein_g", 1005: "carbohydrates_g", 1004: "fat_g", 1079: "fiber_g", 1093: "sodium_mg"}
BASE_URL = "https://api.nal.usda.gov/fdc/v1/food/{}?api_key={}"


def fetch_food(fdc_id: int, api_key: str) -> dict:
    with urlopen(BASE_URL.format(fdc_id, api_key), timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def build_record(recipe: dict, api_key: str) -> dict:
    ingredients = recipe.get("ingredients")
    serving = float(recipe.get("serving_size_g", 0))
    if not isinstance(ingredients, list) or not ingredients or serving <= 0:
        raise ValueError("Every recipe needs documented ingredient FDC IDs, gram quantities, and a serving size")
    totals = {field: 0.0 for field in NUTRIENTS.values()}
    known = {field: True for field in NUTRIENTS.values()}
    citations = []
    for ingredient in ingredients:
        grams = float(ingredient.get("grams", 0))
        fdc_id = int(ingredient.get("fdc_id", 0))
        if grams <= 0 or fdc_id <= 0:
            raise ValueError("Ingredient FDC IDs and gram quantities must be positive")
        food = fetch_food(fdc_id, api_key)
        citations.append(f"FDC {fdc_id}")
        values = {}
        for item in food.get("foodNutrients", []):
            nutrient = item.get("nutrient") or {}
            nutrient_id = nutrient.get("id", item.get("nutrientId"))
            amount = item.get("amount", item.get("value"))
            if nutrient_id is not None:
                values[int(nutrient_id)] = amount
        for nutrient_id, field in NUTRIENTS.items():
            amount = values.get(nutrient_id)
            if amount is None:
                known[field] = False
            else:
                totals[field] += float(amount) * grams / 100.0
    return {"dish_key": str(recipe["dish_key"]).strip().lower(), "dish_name": str(recipe["dish_name"]).strip(),
            "serving_size_g": serving, **{field: round(totals[field], 2) if known[field] else None for field in totals},
            "source_name": "USDA FoodData Central", "source_reference": "; ".join(citations),
            "estimation_method": "FDC nutrient values per 100 g scaled by supplied per-serving ingredient gram weights; no cooking retention or restaurant recipe verification",
            "confidence_level": "low", "verification_status": "database_derived_estimate"}


def main() -> None:
    api_key = os.environ.get("USDA_FDC_API_KEY")
    if not api_key:
        raise SystemExit("Set USDA_FDC_API_KEY in the server-side shell; do not commit it.")
    source = Path(sys.argv[1] if len(sys.argv) > 1 else "data/usda_recipes.json")
    target = Path(sys.argv[2] if len(sys.argv) > 2 else "data/nutrition_records.json")
    recipes = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(recipes, list):
        raise SystemExit("Input must be a JSON array of explicit recipe mappings.")
    records = [build_record(recipe, api_key) for recipe in recipes]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(records)} documented estimates to {target}; USDA data are public domain/CC0. Review each mapping before import.")


if __name__ == "__main__":
    main()
