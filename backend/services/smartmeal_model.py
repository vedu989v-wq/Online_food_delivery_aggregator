"""Optional model loading and prediction; callers retain the deterministic fallback."""
from pathlib import Path

try:
    import joblib
except ImportError:  # The service remains usable with the documented fallback.
    joblib = None

MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "smartmeal.joblib"
_bundle = None


def predict_fit(rows: list[dict]) -> list[float] | None:
    global _bundle
    if joblib is None or not MODEL_PATH.exists():
        return None
    try:
        if _bundle is None:
            _bundle = joblib.load(MODEL_PATH)
        import pandas as pd
        matrix = pd.DataFrame(rows, columns=_bundle["features"])
        probabilities = _bundle["model"].predict_proba(matrix)[:, 1]
        return [float(value) for value in probabilities]
    except Exception:
        return None


def model_metadata() -> dict | None:
    if joblib is None or not MODEL_PATH.exists():
        return None
    try:
        bundle = joblib.load(MODEL_PATH)
        return {"mode": "trained", "name": bundle["model_name"].replace("_", " "), "version": bundle["version"],
                "labelSource": "synthetic simulated preferences; not real customer or nutrition outcomes"}
    except Exception:
        return None
