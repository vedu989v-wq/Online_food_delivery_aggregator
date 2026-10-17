
import pandas as pd
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "backend" / "data"

INPUT_PATH = DATA_DIR / "swiggy_normalised.csv"
OUTPUT_DIR = DATA_DIR

df = pd.read_csv(INPUT_PATH)

# Track validation issues instead of silently deleting records.
df["validation_issues"] = ""

def add_issue(mask, message):
    """Append an issue to each matching record."""
    df.loc[mask, "validation_issues"] = (
        df.loc[mask, "validation_issues"]
        .apply(lambda current: f"{current}; {message}".strip("; "))
    )

# Validate ratings, if the column exists.
if "rating" in df.columns:
    df["rating"] = pd.to_numeric(df["rating"], errors="coerce")

    invalid_rating = df["rating"].notna() & (
        (df["rating"] < 0) | (df["rating"] > 5)
    )
    missing_rating = df["rating"].isna()

    add_issue(invalid_rating, "rating_out_of_range")
    add_issue(missing_rating, "rating_missing_or_unreadable")

# Validate price, if the column exists.
if "price" in df.columns:
    # Handles simple values such as "₹300" and "300".
    price_text = df["price"].astype("string").str.replace(
        r"[₹,\s]", "", regex=True
    )
    df["price"] = pd.to_numeric(price_text, errors="coerce")

    invalid_price = df["price"].notna() & (df["price"] < 0)
    missing_price = df["price"].isna()

    add_issue(invalid_price, "negative_price")
    add_issue(missing_price, "price_missing_or_unreadable")

# Separate records that need attention.
valid_df = df[df["validation_issues"] == ""].copy()
review_df = df[df["validation_issues"] != ""].copy()

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

valid_df.to_csv(OUTPUT_DIR / "swiggy_validated.csv", index=False)
review_df.to_csv(OUTPUT_DIR / "swiggy_needs_review.csv", index=False)

print("Total records:", len(df))
print("Records passing these checks:", len(valid_df))
print("Records needing review:", len(review_df))
print("\nIssues found:")
print(
    review_df["validation_issues"]
    .value_counts()
    .to_string()
)
