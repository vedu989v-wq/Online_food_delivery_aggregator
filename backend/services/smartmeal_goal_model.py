"""Goal suitability ranking. Model labels are synthetic heuristics, not health outcomes."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ARTIFACT = Path(__file__).resolve().parents[1] / "models" / "smartmeal_goal_v1.joblib"
FEATURES = ["energy_fit", "protein_fit", "price_fit", "eta_fit", "nutrition_quality", "goal_direction", "weight_gap_ratio"]


def feature_row(profile: dict, requirements: dict, candidate: dict, nutrition: dict) -> list[float]:
    energy = nutrition.get("caloriesKcal")
    protein = nutrition.get("proteinG")
    kcal_range = requirements.get("estimated_energy_kcal_range")
    protein_range = requirements.get("protein_g_range")
    meal_kcal = (sum(kcal_range) / 2 / 3) if kcal_range else None
    meal_protein = (sum(protein_range) / 2 / 3) if protein_range else None
    energy_fit = max(0.0, 1 - abs(float(energy) - meal_kcal) / max(meal_kcal, 1)) if energy is not None and meal_kcal else 0.0
    protein_fit = min(1.0, float(protein) / max(meal_protein, 1)) if protein is not None and meal_protein else 0.0
    budget = float(profile.get("budget_per_person") or profile.get("budgetPerPerson") or 0)
    price = float(candidate.get("unitPrice") or 0)
    price_fit = min(1.0, budget / max(price, 1)) if budget else 0.5
    max_eta = profile.get("maxDeliveryTime")
    eta = candidate.get("etaMin")
    eta_fit = (max(0.0, 1 - float(eta) / float(max_eta)) if max_eta and eta is not None else 0.5)
    status = str(nutrition.get("verificationStatus", "unavailable"))
    quality = 1.0 if status == "verified" else 0.65 if status == "database_derived_estimate" else 0.25 if status == "approximate" else 0.0
    current = float(profile.get("weight_kg") or profile.get("current_weight_kg") or 0)
    target = float(profile.get("target_weight_kg") or profile.get("targetWeightKg") or current)
    goal = str(profile.get("goal", "")).casefold()
    direction = 1.0 if target > current or goal in {"weight_gain", "muscle_gain"} else -1.0 if target < current or goal == "weight_loss" else 0.0
    gap = min(1.0, abs(target - current) / max(current, 1))
    return [energy_fit, protein_fit, price_fit, eta_fit, quality, direction, gap]


def model_status() -> dict:
    if not ARTIFACT.exists():
        return {"mode": "fallback", "name": "transparent suitability baseline", "reason": "Goal model artifact is not trained/deployed."}
    try:
        import joblib
        meta = joblib.load(ARTIFACT).get("metadata", {})
        return {"mode": "trained", "name": "synthetic-label goal suitability model", "version": meta.get("version", "1.0"),
                "training_data": "synthetic scenarios; not customer outcomes"}
    except Exception:
        return {"mode": "fallback", "name": "transparent suitability baseline", "reason": "Goal model artifact could not be loaded."}


def score_goal(profile: dict, requirements: dict, candidates: list[dict], nutrition_by_item: dict) -> tuple[list[dict], dict]:
    status = model_status()
    model = None
    if status["mode"] == "trained":
        try:
            import joblib
            model = joblib.load(ARTIFACT)["model"]
        except Exception:
            model = None
            status = {"mode": "fallback", "name": "transparent suitability baseline", "reason": "Goal model artifact could not be loaded."}
    scored = []
    has_goal_context = bool(requirements.get("estimated_energy_kcal_range") or requirements.get("protein_g_range")
                            or profile.get("goal") or profile.get("target_weight_kg") or profile.get("targetWeightKg"))
    for item in candidates:
        nutrition = nutrition_by_item.get(item.get("itemId"), {})
        features = feature_row(profile, requirements, item, nutrition)
        if not has_goal_context:
            item["goalSuitability"] = {"score": None, "mode": "unavailable", "reason": "Add a goal or profile details to calculate goal suitability."}
        elif nutrition.get("caloriesKcal") is None and nutrition.get("proteinG") is None:
            item["goalSuitability"] = {"score": None, "mode": "unavailable", "reason": "No dish-specific nutrition record to evaluate against your goal."}
        elif model is not None:
            confidence = float(model.predict_proba(np.asarray([features]))[0][1])
            item["goalSuitability"] = {"score": round(confidence * 100, 1), "mode": "trained", "reason": "Model ranked the sourced per-serving nutrition, budget fit, delivery fit, and goal direction. Training labels are synthetic."}
            item["score"] = round(item.get("score", 0) * 0.55 + confidence * 100 * 0.45, 2)
        else:
            base = 100 * (0.38 * features[0] + 0.32 * features[1] + 0.12 * features[2] + 0.08 * features[3] + 0.10 * features[4])
            item["goalSuitability"] = {"score": round(base, 1), "mode": "fallback", "reason": "Transparent rule-based suitability score; nutrition confidence lowers the score."}
            item["score"] = round(item.get("score", 0) * 0.55 + base * 0.45, 2)
        scored.append(item)
    scored.sort(key=lambda item: (item.get("goalSuitability", {}).get("score") is None,
                                 -(item.get("goalSuitability", {}).get("score") or 0), -item.get("score", 0)))
    return scored, status
