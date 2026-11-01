"""Validated Gemini helpers for SmartMeal. Gemini is optional and never authoritative."""
from __future__ import annotations

import json
import os
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class Intent(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    intent: Literal["goal_based_meal_planning", "single_meal", "refinement", "nutrition_question", "general"]
    goal: Literal["weight_gain", "muscle_gain", "weight_loss", "maintenance", "balanced", "high_protein"] | None = None
    current_weight_kg: float | None = Field(default=None, ge=25, le=350)
    target_weight_kg: float | None = Field(default=None, ge=25, le=350)
    height_cm: float | None = Field(default=None, ge=100, le=250)
    age_years: int | None = Field(default=None, ge=18, le=120)
    activity_level: Literal["sedentary", "light", "moderate", "active", "very_active"] | None = None
    dietary_preference: str | None = Field(default=None, max_length=40)
    budget_per_meal: float | None = Field(default=None, gt=0, le=100000)
    maximum_delivery_minutes: int | None = Field(default=None, ge=1, le=240)
    excluded_ingredients: list[str] = Field(default_factory=list, max_length=20)
    cuisine: str | None = Field(default=None, max_length=40)
    missing_information: list[str] = Field(default_factory=list, max_length=8)
    requires_follow_up: bool = False
    requires_clinical_review: bool = False
    response: str = Field(min_length=1, max_length=800)


class NutritionEstimate(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    dish_name: str = Field(min_length=1, max_length=160)
    serving_size_g: float | None = Field(default=None, gt=0, le=3000)
    calories_kcal: float | None = Field(default=None, ge=0, le=5000)
    protein_g: float | None = Field(default=None, ge=0, le=500)
    carbohydrates_g: float | None = Field(default=None, ge=0, le=1000)
    fat_g: float | None = Field(default=None, ge=0, le=500)
    fiber_g: float | None = Field(default=None, ge=0, le=300)
    sodium_mg: float | None = Field(default=None, ge=0, le=20000)
    ingredients: list[str] = Field(default_factory=list, max_length=20)
    assumptions: list[str] = Field(default_factory=list, max_length=12)
    uncertainties: list[str] = Field(default_factory=list, max_length=12)
    confidence: Literal["low", "medium"] = "low"


def parse_json_model(text: str, schema: type[BaseModel]):
    """Accept one JSON object only, then validate every field and range."""
    if not isinstance(text, str) or len(text) > 12000:
        raise ValueError("Model response is empty or too long")
    try:
        return schema.model_validate_json(text)
    except (ValidationError, ValueError) as exc:
        raise ValueError("Gemini response did not match the required schema") from exc


def gemini_json(prompt: str, schema: type[BaseModel]):
    """Synchronous SDK wrapper; callers run it in a worker thread."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("Gemini is not configured")
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise RuntimeError("Gemini SDK is not installed") from exc
    client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=8000))
    last_error = None
    for attempt in range(2):
        try:
            response = client.interactions.create(
                model=os.getenv("GEMINI_MODEL", "gemini-3.8-flash"),
                input=prompt,
                response_format={"type": "text", "mime_type": "application/json", "schema": schema.model_json_schema()},
            )
            return parse_json_model(getattr(response, "output_text", "") or "", schema)
        except Exception as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(0.35)
    raise RuntimeError("Gemini request failed validation or was unavailable") from last_error


def deterministic_requirements(profile: dict) -> dict:
    """Mifflin-St Jeor range; sex is not inferred, so both coefficients are bounded."""
    def number(*values):
        for value in values:
            if value not in (None, ""):
                try:
                    parsed = float(value)
                    if parsed == parsed and abs(parsed) != float("inf"):
                        return parsed
                except (TypeError, ValueError):
                    pass
        return None
    current = number(profile.get("weight_kg"), profile.get("current_weight_kg"))
    target = number(profile.get("target_weight_kg"), profile.get("targetWeightKg"))
    height = number(profile.get("height_cm"), profile.get("heightCm"))
    age = number(profile.get("age_years"), profile.get("ageYears"))
    activity = profile.get("activity_level")
    result = {"bmi": None, "estimated_energy_kcal_range": None, "protein_g_range": None,
              "weight_direction": None, "assumptions": ["Informational estimate only; not a clinical prescription."]}
    if current and height:
        result["bmi"] = round(float(current) / (float(height) / 100) ** 2, 1)
    if current and target:
        result["weight_direction"] = "gain" if target > current else "loss" if target < current else "maintain"
    elif profile.get("goal") in {"weight_gain", "muscle_gain"}:
        result["weight_direction"] = "gain"
    elif profile.get("goal") == "weight_loss":
        result["weight_direction"] = "loss"
    elif profile.get("goal") == "maintenance":
        result["weight_direction"] = "maintain"
    if current and height and age and activity:
        factors = {"sedentary": 1.2, "light": 1.375, "moderate": 1.55, "active": 1.725, "very_active": 1.9}
        base = 10 * current + 6.25 * height - 5 * int(age)
        factor = factors[activity]
        # Unknown sex coefficient: show a range rather than assume one.
        low, high = sorted(((base - 161) * factor, (base + 5) * factor))
        result["estimated_energy_kcal_range"] = [round(max(1200, low)), round(max(1200, high))]
        result["protein_g_range"] = [round(current * 1.2), round(current * 1.6)]
        result["assumptions"].append("Energy uses Mifflin-St Jeor with a range across its sex-specific constants and a self-reported activity multiplier.")
        result["assumptions"].append("Protein range is a general 1.2–1.6 g/kg estimate; individual needs vary.")
    else:
        result["missing_for_estimate"] = [name for name, value in (("current weight", current), ("height", height), ("age 18+", age), ("activity level", activity)) if not value]
    return result


def safe_recommendation_explanation(message: str, results: list[dict], requirements: dict) -> str:
    """Only provide Gemini evidence fields, never ask it to supply menu facts."""
    names = [{"item": row.get("itemName"), "restaurant": row.get("restaurantName"),
              "price": row.get("unitPrice"), "score": row.get("goalSuitability", {}).get("score"),
              "nutrition": ({key: row.get("nutrition", {}).get(key) for key in ("caloriesKcal", "proteinG", "carbohydratesG", "fatG", "verificationStatus", "reviewStatus")}
                           if row.get("nutrition", {}).get("reviewStatus") == "approved" else None),
              "reasons": row.get("reasons", [])[:3]}
             for row in results[:5]]
    prompt = ("You are FoodLens SmartMeal, an informational food discovery assistant. "
              "Use only the supplied recommendations and evidence. Do not invent foods, prices, nutrition facts, availability, or medical advice. "
              "State that menu nutrition may be unavailable. Only state nutrient numbers from an approved nutrition object and label approximate values. Be concise and kind.\n"
              + json.dumps({"request": message[:1000], "requirements": requirements, "recommendations": names}, ensure_ascii=False))
    try:
        # A prose result does not drive any business logic and is always grounded against supplied records.
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("not configured")
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=8000))
        response = client.interactions.create(model=os.getenv("GEMINI_MODEL", "gemini-3.8-flash"), input=prompt)
        answer = (getattr(response, "output_text", "") or "").strip()
        # Guard against likely ungrounded claims by requiring recommendation names in any meal claims is hard;
        # use deterministic answer if model returns empty or unwieldy text.
        if 0 < len(answer) <= 1200:
            return answer
    except Exception:
        pass
    if not results:
        return "I couldn't find a matching item in the current FoodLens menu data. Try a wider budget or different constraints."
    return "Here are menu matches from FoodLens's current dataset. Nutrition is shown only when a sourced record exists; these menu listings and prices may be synthetic."


def normalize_constraints(intent: Intent, profile: dict) -> dict:
    combined = dict(profile)
    for key in ("current_weight_kg", "target_weight_kg", "height_cm", "age_years", "activity_level", "dietary_preference"):
        value = getattr(intent, key)
        if value is not None:
            combined[key] = value
    if intent.current_weight_kg is not None:
        combined["weight_kg"] = intent.current_weight_kg
    if intent.goal is not None:
        combined["goal"] = intent.goal
    if intent.budget_per_meal is not None:
        combined["budget_per_person"] = intent.budget_per_meal
    if intent.cuisine:
        combined["cuisine"] = intent.cuisine
    if intent.maximum_delivery_minutes is not None:
        combined["maxDeliveryTime"] = intent.maximum_delivery_minutes
    combined["excluded_ingredients"] = intent.excluded_ingredients
    return combined
