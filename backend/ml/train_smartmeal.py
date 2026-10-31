"""Train an explicitly synthetic-label SmartMeal preference-fit model.

Generated targets are simulated preference outcomes, not user ratings or health outcomes.
The group split prevents candidate rows for the same simulated user crossing train/test.
"""
from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, confusion_matrix, f1_score,
                             precision_score, recall_score, roc_auc_score)
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models"
FEATURES = ["unit_price", "budget", "budget_ratio", "vegetarian_match", "eta", "eta_limit", "rating", "priority_cost", "priority_speed", "priority_rating"]
SEED = 20261031


def build_dataset() -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    users = 500
    per_user = 16
    budget = rng.uniform(100, 1200, users)
    eta_limit = rng.uniform(20, 100, users)
    dietary = rng.integers(0, 2, users)
    priority = rng.integers(0, 3, users)  # cost, speed, rating
    records = []
    for user in range(users):
        prices = rng.uniform(50, 1500, per_user)
        eta = rng.uniform(15, 120, per_user)
        veg = rng.integers(0, 2, per_user)
        rating = np.clip(rng.normal(3.8, 0.75, per_user), 1, 5)
        ratio = prices / budget[user]
        veg_match = (veg == dietary[user]).astype(float)
        priority_cost = float(priority[user] == 0)
        priority_speed = float(priority[user] == 1)
        priority_rating = float(priority[user] == 2)
        speed_fit = np.clip(1 - (eta - 15) / np.maximum(eta_limit[user] - 15, 1), 0, 1)
        rating_fit = (rating - 1) / 4
        cost_fit = np.clip(1 - ratio, -1, 1)
        utility = (1.2 * cost_fit * (0.7 + priority_cost)
                   + 0.9 * speed_fit * (0.7 + priority_speed)
                   + 0.8 * rating_fit * (0.7 + priority_rating)
                   + 1.7 * veg_match - 0.4)
        probability = 1 / (1 + np.exp(-utility))
        labels = rng.binomial(1, probability)
        for i in range(per_user):
            records.append({"user_group": user, "unit_price": prices[i], "budget": budget[user], "budget_ratio": ratio[i],
                            "vegetarian_match": veg_match[i], "eta": eta[i], "eta_limit": eta_limit[user], "rating": rating[i],
                            "priority_cost": priority_cost, "priority_speed": priority_speed, "priority_rating": priority_rating,
                            "label": labels[i]})
    return pd.DataFrame(records)


def main() -> None:
    data = build_dataset()
    splitter = GroupShuffleSplit(n_splits=1, test_size=0.25, random_state=SEED)
    train_idx, test_idx = next(splitter.split(data[FEATURES], data["label"], groups=data["user_group"]))
    x_train, x_test = data.iloc[train_idx][FEATURES], data.iloc[test_idx][FEATURES]
    y_train, y_test = data.iloc[train_idx]["label"], data.iloc[test_idx]["label"]
    candidates = {
        "logistic_regression_baseline": make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(max_iter=1000, random_state=SEED)),
        "random_forest": make_pipeline(SimpleImputer(strategy="median"), RandomForestClassifier(n_estimators=240, min_samples_leaf=4, class_weight="balanced", random_state=SEED, n_jobs=-1)),
    }
    reports = {}
    for name, model in candidates.items():
        model.fit(x_train, y_train)
        predicted = model.predict(x_test)
        probability = model.predict_proba(x_test)[:, 1]
        ranked = data.iloc[test_idx][["user_group", "label"]].copy()
        ranked["probability"] = probability
        p_at_3 = []
        ndcg_at_5 = []
        for _, group in ranked.groupby("user_group"):
            relevance = group["label"].to_numpy(dtype=float)
            scores = group["probability"].to_numpy(dtype=float)
            order = np.argsort(-scores)[:3]
            p_at_3.append(float(relevance[order].sum() / 3))
            order5 = np.argsort(-scores)[:5]
            ideal5 = np.sort(relevance)[::-1][:5]
            discounts = 1 / np.log2(np.arange(2, len(order5) + 2))
            dcg = float((relevance[order5] * discounts).sum())
            idcg = float((ideal5[:len(discounts)] * discounts).sum())
            ndcg_at_5.append(dcg / idcg if idcg else 0.0)
        reports[name] = {"precision": precision_score(y_test, predicted, zero_division=0),
                         "recall": recall_score(y_test, predicted, zero_division=0),
                         "f1": f1_score(y_test, predicted, zero_division=0),
                         "roc_auc": roc_auc_score(y_test, probability),
                         "accuracy": accuracy_score(y_test, predicted),
                         "confusion_matrix": confusion_matrix(y_test, predicted, labels=[0, 1]).tolist(),
                         "precision_at_3": float(np.mean(p_at_3)), "ndcg_at_5": float(np.mean(ndcg_at_5))}
    selected = max(reports, key=lambda name: (reports[name]["f1"], reports[name]["roc_auc"], name == "logistic_regression_baseline"))
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": candidates[selected], "features": FEATURES, "version": "smartmeal-synthetic-v1", "model_name": selected}, MODEL_DIR / "smartmeal.joblib")
    report = {"version": "smartmeal-synthetic-v1", "selected_model": selected, "baseline": "logistic_regression_baseline",
              "dataset": {"rows": len(data), "simulated_users": int(data.user_group.nunique()), "source": "reproducibly generated synthetic candidate scenarios",
                          "labels": "Bernoulli samples from documented synthetic preference utility; not real customer, consumption, or health outcomes"},
              "split": "75/25 grouped by simulated user; seed 20261031", "evaluation": reports,
              "limitations": ["Synthetic labels only; no genuine user feedback.", "No nutrition data is modeled.", "Metrics measure reproduction of simulated preferences, not recommendation quality in production."]}
    (MODEL_DIR / "smartmeal-evaluation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
