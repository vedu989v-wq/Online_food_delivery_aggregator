import os

import pytest

from services.smartmeal_ai import Intent, NutritionEstimate, deterministic_requirements, parse_json_model
from services.smartmeal_goal_model import feature_row, score_goal
from ml.train_smartmeal_goal import build_dataset


def test_gemini_schema_rejects_extra_fields_and_invalid_ranges():
    with pytest.raises(ValueError):
        parse_json_model('{"dish_name":"Soup","calories_kcal":-1,"unexpected":true}', NutritionEstimate)


def test_null_nutrition_is_preserved_and_never_coerced_to_zero():
    row = parse_json_model('{"dish_name":"Special Thali","calories_kcal":null,"protein_g":null,"assumptions":[],"uncertainties":["Ambiguous components"],"confidence":"low"}', NutritionEstimate)
    assert row.calories_kcal is None
    assert row.protein_g is None


def test_intent_output_has_bounded_structured_contract():
    parsed = parse_json_model('{"intent":"single_meal","budget_per_meal":200,"requires_follow_up":false,"response":"I can look."}', Intent)
    assert parsed.budget_per_meal == 200
    with pytest.raises(ValueError):
        parse_json_model('{"intent":"single_meal","budget_per_meal":-5,"response":"x"}', Intent)


def test_deterministic_requirements_are_missing_safe_and_report_range():
    incomplete = deterministic_requirements({"weight_kg": 60, "height_cm": 175})
    assert incomplete["estimated_energy_kcal_range"] is None
    complete = deterministic_requirements({"weight_kg": 60, "target_weight_kg": 80, "height_cm": 175,
                                            "age_years": 22, "activity_level": "moderate"})
    assert complete["weight_direction"] == "gain"
    assert complete["estimated_energy_kcal_range"][0] < complete["estimated_energy_kcal_range"][1]
    assert complete["protein_g_range"] == [72, 96]


def test_missing_nutrition_never_receives_goal_prediction():
    rows, model = score_goal({}, {}, [{"itemId": "dish", "score": 50}], {})
    assert rows[0]["goalSuitability"]["score"] is None
    assert rows[0]["goalSuitability"]["mode"] == "unavailable"


def test_goal_training_examples_reproducible_and_profile_grouped():
    first = build_dataset(seed=2, users=8, meals_per_user=3)
    second = build_dataset(seed=2, users=8, meals_per_user=3)
    assert first.equals(second)
    assert first.user_group.nunique() == 8
    assert set(first.label.unique()) <= {0, 1}
