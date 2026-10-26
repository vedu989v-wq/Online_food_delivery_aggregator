
from pathlib import Path
import pandas as pd

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "backend" / "data"

files = [
    ("POSSIBLE MATCHES", DATA_DIR / "cross_provider_matches.csv"),
    ("MANUAL REVIEW", DATA_DIR / "cross_provider_needs_review.csv"),
]

for label, path in files:
    print(f"\n{'=' * 20} {label} {'=' * 20}")

    if not path.exists():
        print(f"File not found: {path}")
        continue

    df = pd.read_csv(path, encoding="utf-8-sig")

    if df.empty:
        print("No records.")
        continue

    columns = [
        col for col in [
            "swiggy_name",
            "zomato_name",
            "swiggy_location",
            "zomato_location",
            "swiggy_area",
            "zomato_area",
            "name_similarity",
            "area_similarity",
            "match_status",
        ]
        if col in df.columns
    ]

    print(df[columns].head(15).to_string(index=False))
