
import pandas as pd
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "backend" / "data"

# 1. Load the dataset
DATASET_PATH = DATA_DIR / "swiggy_file.csv"
df = pd.read_csv(DATASET_PATH)

# 2. Keep a copy of the original data
df_clean = df.copy()

# 3. Standardize column names
df_clean.columns = (
    df_clean.columns
    .str.strip()
    .str.lower()
    .str.replace(" ", "_")
)

# 4. Clean text fields
for column in df_clean.select_dtypes(include=["object", "string"]).columns:
    df_clean[column] = df_clean[column].map(
        lambda value: value.strip() if isinstance(value, str) else value
    )

# 5. Standardize text casing for selected fields
for column in ["city", "area"]:
    if column in df_clean.columns:
        df_clean[column] = df_clean[column].map(
            lambda value: value.lower() if isinstance(value, str) else value
        )

# 6. Remove completely duplicated rows
df_clean = df_clean.drop_duplicates()

# 7. Save the normalized dataset
output_path = DATA_DIR / "swiggy_normalised.csv"
output_path.parent.mkdir(parents=True, exist_ok=True)
df_clean.to_csv(output_path, index=False)

print("Original records:", len(df))
print("Normalized records:", len(df_clean))
print("Output saved to:", output_path)
