"""Train reproducible suitability model on simulated scenarios, never real health outcomes."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import GroupShuffleSplit
import joblib

from services.smartmeal_goal_model import ARTIFACT, FEATURES, feature_row


def build_dataset(seed: int = 41, users: int = 320, meals_per_user: int = 30) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for user in range(users):
        current = float(rng.uniform(45, 115))
        target = float(np.clip(current + rng.normal(0, 14), 35, 150))
        goal = "gain" if target > current + 2 else "loss" if target < current - 2 else "maintenance"
        profile = {"weight_kg": current, "target_weight_kg": target, "budget_per_person": float(rng.uniform(100, 600)),
                   "maxDeliveryTime": int(rng.integers(20, 80)), "goal": goal}
        energy_range = {"gain": [2100, 3000], "loss": [1400, 2200], "maintenance": [1700, 2600]}[goal]
        requirements = {"estimated_energy_kcal_range": energy_range, "protein_g_range": [70, 130]}
        for _ in range(meals_per_user):
            nutrition = {"caloriesKcal": float(rng.uniform(150, 1200)), "proteinG": float(rng.uniform(2, 70)),
                         "verificationStatus": str(rng.choice(["verified", "database_derived_estimate", "approximate"], p=[.1, .25, .65]))}
            item = {"unitPrice": float(rng.uniform(60, 700)), "etaMin": float(rng.uniform(15, 100))}
            features = feature_row(profile, requirements, item, nutrition)
            # Explicit synthetic heuristic: balanced energy/protein, affordability and data quality.
            desirability = .38 * features[0] + .32 * features[1] + .12 * features[2] + .08 * features[3] + .10 * features[4]
            label = int(desirability >= (.46 if goal == "gain" else .40 if goal == "loss" else .43))
            rows.append({"user_group": user, **dict(zip(FEATURES, features)), "label": label})
    return pd.DataFrame(rows)


def train(seed: int = 41, output: Path = ARTIFACT) -> dict:
    data = build_dataset(seed=seed)
    splitter = GroupShuffleSplit(n_splits=1, test_size=.2, random_state=seed)
    train_idx, test_idx = next(splitter.split(data[FEATURES], data.label, groups=data.user_group))
    x_train, x_test = data.iloc[train_idx][FEATURES], data.iloc[test_idx][FEATURES]
    y_train, y_test = data.iloc[train_idx].label, data.iloc[test_idx].label
    model = RandomForestClassifier(n_estimators=160, max_depth=8, min_samples_leaf=8, class_weight="balanced", random_state=seed, n_jobs=-1)
    model.fit(x_train, y_train)
    probabilities = model.predict_proba(x_test)[:, 1]
    predictions = (probabilities >= .5).astype(int)
    baseline = (x_test.energy_fit * .38 + x_test.protein_fit * .32 + x_test.price_fit * .12 + x_test.eta_fit * .08 + x_test.nutrition_quality * .10 >= .43).astype(int)
    test_frame = data.iloc[test_idx].copy()
    test_frame["model_score"] = probabilities
    test_frame["baseline_score"] = (x_test.energy_fit * .38 + x_test.protein_fit * .32 + x_test.price_fit * .12 + x_test.eta_fit * .08 + x_test.nutrition_quality * .10).to_numpy()
    def rank_metrics(score_column: str, k: int = 3) -> tuple[float, float]:
        precision_values, ndcg_values = [], []
        for _, group in test_frame.groupby("user_group"):
            ordered = group.sort_values(score_column, ascending=False)
            top = ordered.head(k).label.to_numpy()
            precision_values.append(float(top.sum()) / k)
            dcg = sum((2 ** int(relevance) - 1) / math.log2(index + 2) for index, relevance in enumerate(top))
            ideal = sorted(group.label.to_numpy(), reverse=True)[:k]
            idcg = sum((2 ** int(relevance) - 1) / math.log2(index + 2) for index, relevance in enumerate(ideal))
            ndcg_values.append(dcg / idcg if idcg else 0.0)
        return float(np.mean(precision_values)), float(np.mean(ndcg_values))
    p_at_3, ndcg_at_3 = rank_metrics("model_score")
    baseline_p_at_3, baseline_ndcg_at_3 = rank_metrics("baseline_score")
    metrics = {"rows": len(data), "profiles": int(data.user_group.nunique()), "test_profiles": int(data.iloc[test_idx].user_group.nunique()),
               "accuracy": round(float(accuracy_score(y_test, predictions)), 4), "precision": round(float(precision_score(y_test, predictions, zero_division=0)), 4),
               "recall": round(float(recall_score(y_test, predictions, zero_division=0)), 4), "f1": round(float(f1_score(y_test, predictions, zero_division=0)), 4),
               "roc_auc": round(float(roc_auc_score(y_test, probabilities)), 4),
               "baseline_accuracy": round(float(accuracy_score(y_test, baseline)), 4),
               "precision_at_3": round(p_at_3, 4), "ndcg_at_3": round(ndcg_at_3, 4),
               "baseline_precision_at_3": round(baseline_p_at_3, 4), "baseline_ndcg_at_3": round(baseline_ndcg_at_3, 4),
               "label_source": "synthetic transparent heuristic; not consented user behavior or clinical effectiveness",
               "split": "GroupShuffleSplit by simulated user profile", "seed": seed}
    output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "metadata": {"version": "1.0", "features": FEATURES, "metrics": metrics}}, output)
    metrics_path = output.with_suffix(".metrics.json")
    metrics_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    return metrics


if __name__ == "__main__":
    print(json.dumps(train(), indent=2))
