
import pandas as pd
from pathlib import Path
from rapidfuzz import fuzz
import re
import unicodedata

# File paths
DATA_DIR = Path("backend/data")
INPUT_PATH = DATA_DIR / "zomato_ingested.csv"
OUTPUT_PATH = DATA_DIR / "zomato_resolved.csv"
REVIEW_PATH = DATA_DIR / "zomato_needs_review.csv"


def normalize_text(value):
    """Normalize text for comparison without changing original values."""
    if pd.isna(value):
        return ""

    value = unicodedata.normalize("NFKC", str(value))
    value = value.casefold()
    value = re.sub(r"[^a-z0-9\s]", " ", value)

    return " ".join(value.split())


# Load Zomato dataset
df = pd.read_csv(INPUT_PATH)

required_columns = [
    "restaurant_name",
    "location",
    "cuisine"
]

missing = [col for col in required_columns if col not in df.columns]

if missing:
    raise ValueError(f"Missing columns in Zomato dataset: {missing}")

df = df.copy()
df["provider_id"] = "zomato"
df["source_row_id"] = range(len(df))

# Normalize fields for comparison
df["normalized_name"] = df["restaurant_name"].apply(normalize_text)
df["normalized_location"] = df["location"].apply(normalize_text)
df["normalized_cuisine"] = df["cuisine"].apply(normalize_text)

# Records without a restaurant name need review
missing_name = df["normalized_name"].eq("")

df["identity_status"] = "unique_candidate"

# Compare records within the same location
for _, group in df.groupby("normalized_location"):
    indices = group.index.tolist()

    for i in range(len(indices)):
        for j in range(i + 1, len(indices)):
            a = df.loc[indices[i]]
            b = df.loc[indices[j]]

            name_score = fuzz.token_sort_ratio(
                a["normalized_name"],
                b["normalized_name"]
            )

            if not a["normalized_name"] or not b["normalized_name"]:
                continue

            # Same location and very similar name
            if name_score >= 90:
                df.loc[indices[i], "identity_status"] = (
                    "possible_duplicate"
                )
                df.loc[indices[j], "identity_status"] = (
                    "possible_duplicate"
                )

            # Similar name, but not enough evidence to decide
            elif name_score >= 80:
                if df.loc[indices[i], "identity_status"] != (
                    "possible_duplicate"
                ):
                    df.loc[indices[i], "identity_status"] = (
                        "manual_review"
                    )

                if df.loc[indices[j], "identity_status"] != (
                    "possible_duplicate"
                ):
                    df.loc[indices[j], "identity_status"] = (
                        "manual_review"
                    )

df.loc[missing_name, "identity_status"] = "missing_name"

# Save separate output files
DATA_DIR.mkdir(parents=True, exist_ok=True)

df.to_csv(OUTPUT_PATH, index=False)

review_df = df[
    df["identity_status"].isin(
        ["possible_duplicate", "manual_review", "missing_name"]
    )
].copy()

review_df.to_csv(REVIEW_PATH, index=False)

print("Provider: Zomato")
print("Total records:", len(df))
print("\nIdentity status:")
print(df["identity_status"].value_counts().to_string())
print("\nResolved output:", OUTPUT_PATH)
print("Review output:", REVIEW_PATH)
