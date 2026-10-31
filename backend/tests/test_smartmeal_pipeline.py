from unittest.mock import patch

import pandas as pd
import pytest

from ml.import_usda_recipes import build_record
from ml.train_smartmeal import build_dataset


def test_explicit_recipe_quantities_scale_usda_values_and_preserve_missing_nutrients():
    food = {"foodNutrients": [
        {"nutrient": {"id": 1008}, "amount": 200},
        {"nutrient": {"id": 1003}, "amount": 10},
    ]}
    recipe = {"dish_key": "test-dish", "dish_name": "Test dish", "serving_size_g": 80,
              "ingredients": [{"fdc_id": 123, "grams": 50}]}
    with patch("ml.import_usda_recipes.fetch_food", return_value=food):
        record = build_record(recipe, "test-only")
    assert record["calories_kcal"] == 100
    assert record["protein_g"] == 5
    assert record["fiber_g"] is None
    assert record["source_reference"] == "FDC 123"
    assert record["verification_status"] == "database_derived_estimate"
    assert record["confidence_level"] == "low"


def test_recipe_pipeline_requires_documented_ingredients_and_serving_size():
    with pytest.raises(ValueError):
        build_record({"dish_key": "unknown", "dish_name": "Unknown", "serving_size_g": 0, "ingredients": []}, "test-only")


def test_synthetic_model_training_data_is_reproducible_and_grouped():
    first = build_dataset()
    second = build_dataset()
    pd.testing.assert_frame_equal(first, second)
    assert len(first) == 8000
    assert first["user_group"].nunique() == 500
    assert set(first["label"].unique()) <= {0, 1}
