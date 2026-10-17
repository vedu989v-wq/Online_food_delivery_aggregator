
import hashlib
import pandas as pd
from pathlib import Path

INPUT_PATH = Path("backend/data/zomato_validated.csv")
OUTPUT_DIR = Path("backend/data")

# Change this to match your dataset's source.
PROVIDER_ID = "zomato"

df = pd.read_csv(INPUT_PATH)

# Find common column names without assuming one exact dataset schema.
def find_column(candidates):
    for column in candidates:
        if column in df.columns:
            return column
    return None

name_col = find_column([
    "restaurant_name", "name", "restaurant"
])
address_col = find_column([
    "address", "restaurant_address"
])
city_col = find_column(["city"])
area_col = find_column(["area", "locality"])

if name_col is None:
    raise ValueError(
        "Restaurant name column not found. "
        f"Available columns: {df.columns.tolist()}"
    )

# Use stable identifying fields, not the row number.
identity_columns = [
    col for col in [name_col, address_col, city_col, area_col]
    if col is not None
]

def make_record_key(row):
    parts = [
        PROVIDER_ID,
        *[
            str(row[col]).strip().casefold()
            if pd.notna(row[col]) else ""
            for col in identity_columns
        ]
    ]

    # Do not create an identity from an empty restaurant name.
    if not parts[1].strip():
        return None

    identity = "|".join(parts)
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()

df["provider_id"] = PROVIDER_ID
df["source_record_key"] = df.apply(make_record_key, axis=1)

# Records without an identity need manual review.
missing_identity = df[df["source_record_key"].isna()].copy()
identified = df[df["source_record_key"].notna()].copy()

# Keep one copy per provider record.
# In production, conflicting updates need explicit handling.
duplicates = identified[
    identified.duplicated(
        subset=["provider_id", "source_record_key"],
        keep="first"
    )
].copy()

ingested = identified.drop_duplicates(
    subset=["provider_id", "source_record_key"],
    keep="first"
).copy()

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ingested.to_csv(OUTPUT_DIR / "zomato_ingested.csv", index=False)
duplicates.to_csv(OUTPUT_DIR / "zomato_duplicate_records.csv", index=False)
missing_identity.to_csv(
    OUTPUT_DIR / "zomato_missing_identity.csv", index=False
)

print("Input records:", len(df))
print("Unique provider records:", len(ingested))
print("Duplicate records:", len(duplicates))
print("Missing identity:", len(missing_identity))
print("Saved files to:", OUTPUT_DIR)
