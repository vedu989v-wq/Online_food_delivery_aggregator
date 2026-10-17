
from pathlib import Path
import re
import pandas as pd
from rapidfuzz import fuzz, process

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "backend" / "data"

INPUT_FILE = DATA_DIR / "zomato_ingested.csv"
OUTPUT_FILE = DATA_DIR / "zomato_resolved.csv"
REVIEW_FILE = DATA_DIR / "zomato_needs_review.csv"


def normalize(value):
    if pd.isna(value):
        return ""
    value = str(value).lower().strip()
    value = re.sub(r"[^a-z0-9\s]", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def find_column(df, aliases, required=True):
    lookup = {
        re.sub(r"[^a-z0-9]", "", str(col).lower()): col
        for col in df.columns
    }

    for alias in aliases:
        key = re.sub(r"[^a-z0-9]", "", alias.lower())
        if key in lookup:
            return lookup[key]

    if required:
        raise ValueError(
            f"Missing column from {aliases}. Found: {df.columns.tolist()}"
        )
    return None


def make_block_key(name):
    tokens = name.split()

    if not tokens:
        return ""

    if len(tokens[0]) < 3 and len(tokens) > 1:
        return (tokens[0] + tokens[1])[:3]

    return tokens[0][:3]


def main():
    if not INPUT_FILE.exists():
        raise FileNotFoundError(f"Input file not found: {INPUT_FILE}")

    df = pd.read_csv(INPUT_FILE, encoding="utf-8-sig")
    df.columns = df.columns.str.replace(
        "\ufeff", "", regex=False
    ).str.strip()

    name_col = find_column(
        df, ["Restaurant Name", "restaurant_name", "name"]
    )
    location_col = find_column(
        df, ["Location", "city", "normalized_location"]
    )
    area_col = find_column(
        df, ["Area", "locality", "normalized_area"], required=False
    )

    names = df[name_col].apply(normalize)
    locations = df[location_col].apply(normalize)
    areas = (
        df[area_col].apply(normalize)
        if area_col else pd.Series("", index=df.index)
    )

    df["identity_status"] = "unique_candidate"
    df.loc[names == "", "identity_status"] = "missing_name"
    df.loc[
        (names != "") & (locations == ""), "identity_status"
    ] = "missing_location"

    valid = (names != "") & (locations != "")
    blocks = {}

    for idx in df.index[valid]:
        key = (locations.at[idx], make_block_key(names.at[idx]))
        blocks.setdefault(key, []).append(idx)

    comparisons = 0

    for indices in blocks.values():
        if len(indices) < 2:
            continue

        block_names = [names.at[idx] for idx in indices]

        for i, name in enumerate(block_names):
            candidates = process.extract(
                name,
                block_names,
                scorer=fuzz.token_sort_ratio,
                limit=10,
                score_cutoff=80
            )

            for _, name_score, j in candidates:
                if j <= i:
                    continue

                idx1, idx2 = indices[i], indices[j]
                comparisons += 1

                area1, area2 = areas.at[idx1], areas.at[idx2]
                area_score = (
                    fuzz.token_sort_ratio(area1, area2)
                    if area1 and area2 else None
                )

                if name_score >= 95 and (
                    area_score is None or area_score >= 80
                ):
                    status = "possible_duplicate"
                elif name_score >= 80:
                    status = "manual_review"
                else:
                    continue

                for idx in (idx1, idx2):
                    current = df.at[idx, "identity_status"]

                    if current in ("missing_name", "missing_location"):
                        continue

                    if (
                        status == "possible_duplicate"
                        or current == "unique_candidate"
                    ):
                        df.at[idx, "identity_status"] = status

    df.to_csv(OUTPUT_FILE, index=False, encoding="utf-8-sig")

    review_df = df[
        df["identity_status"].isin([
            "possible_duplicate",
            "manual_review",
            "missing_name",
            "missing_location"
        ])
    ]
    review_df.to_csv(REVIEW_FILE, index=False, encoding="utf-8-sig")

    print(f"Zomato records: {len(df)}")
    print(f"Candidate comparisons: {comparisons}")
    print(f"Resolved: {OUTPUT_FILE}")
    print(f"Needs review: {REVIEW_FILE}")
    print(df["identity_status"].value_counts())


if __name__ == "__main__":
    main()
