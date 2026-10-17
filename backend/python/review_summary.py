
from pathlib import Path
import pandas as pd

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "backend" / "data"

for provider in ["swiggy", "zomato"]:
    file_path = DATA_DIR / f"{provider}_resolved.csv"

    df = pd.read_csv(file_path, encoding="utf-8-sig")

    print(f"\n--- {provider.upper()} ---")
    print("Total records:", len(df))
    print("\nIdentity status:")
    print(df["identity_status"].value_counts(dropna=False))

    review = df[
        df["identity_status"].isin([
            "possible_duplicate",
            "manual_review",
            "missing_name",
            "missing_location"
        ])
    ]

    print("\nRecords requiring review:", len(review))
