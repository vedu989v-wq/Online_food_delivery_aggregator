
from pathlib import Path
import re
import pandas as pd
from rapidfuzz import fuzz, process

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "backend" / "data"

SWIGGY_FILE = DATA_DIR / "swiggy_resolved.csv"
ZOMATO_FILE = DATA_DIR / "zomato_resolved.csv"

OUTPUT_FILE = DATA_DIR / "cross_provider_matches.csv"
REVIEW_FILE = DATA_DIR / "cross_provider_needs_review.csv"
UNMATCHED_FILE = DATA_DIR / "cross_provider_unmatched.csv"

MATCH_THRESHOLD = 92
REVIEW_THRESHOLD = 78
MAX_CANDIDATES = 10


def normalize(value):
    if pd.isna(value):
        return ""
    value = str(value).lower().strip()
    value = re.sub(r"[^a-z0-9\s]", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def find_column(df, aliases):
    lookup = {
        re.sub(r"[^a-z0-9]", "", str(col).lower()): col
        for col in df.columns
    }

    for alias in aliases:
        key = re.sub(r"[^a-z0-9]", "", alias.lower())
        if key in lookup:
            return lookup[key]

    raise ValueError(
        f"Missing one of {aliases}. Found: {df.columns.tolist()}"
    )


def optional_column(df, aliases):
    lookup = {
        re.sub(r"[^a-z0-9]", "", str(col).lower()): col
        for col in df.columns
    }

    for alias in aliases:
        key = re.sub(r"[^a-z0-9]", "", alias.lower())
        if key in lookup:
            return lookup[key]

    return None


def load_data(path, provider):
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    df = pd.read_csv(path, encoding="utf-8-sig")
    df.columns = df.columns.str.replace(
        "\ufeff", "", regex=False
    ).str.strip()

    name_col = find_column(
        df, ["Restaurant Name", "restaurant_name", "name"]
    )
    location_col = find_column(
        df, ["Location", "city", "normalized_location"]
    )
    area_col = optional_column(
        df, ["Area", "locality", "normalized_area"]
    )

    df = df.reset_index(drop=True)
    df["_provider"] = provider
    df["_match_name"] = df[name_col].map(normalize)
    df["_match_location"] = df[location_col].map(normalize)
    df["_match_area"] = (
        df[area_col].map(normalize)
        if area_col
        else ""
    )

    return df, name_col, location_col, area_col


def main():
    swiggy, sw_name_col, sw_location_col, sw_area_col = load_data(
        SWIGGY_FILE, "swiggy"
    )
    zomato, zo_name_col, zo_location_col, zo_area_col = load_data(
        ZOMATO_FILE, "zomato"
    )

    # Cache values once; avoid repeated DataFrame.at lookups.
    sw_names = swiggy["_match_name"].tolist()
    sw_locations = swiggy["_match_location"].tolist()
    sw_areas = swiggy["_match_area"].tolist()

    zo_names = zomato["_match_name"].tolist()
    zo_locations = zomato["_match_location"].tolist()
    zo_areas = zomato["_match_area"].tolist()

    zo_original_names = zomato[zo_name_col].tolist()
    zo_original_locations = zomato[zo_location_col].tolist()
    zo_original_areas = (
        zomato[zo_area_col].tolist()
        if zo_area_col else [""] * len(zomato)
    )

    sw_original_names = swiggy[sw_name_col].tolist()
    sw_original_locations = swiggy[sw_location_col].tolist()
    sw_original_areas = (
        swiggy[sw_area_col].tolist()
        if sw_area_col else [""] * len(swiggy)
    )

    # Index Zomato records by normalized location.
    zomato_by_location = {}

    for idx, location in enumerate(zo_locations):
        if zo_names[idx] and location:
            zomato_by_location.setdefault(location, []).append(idx)

    matches = []
    reviews = []
    swiggy_with_candidates = set()
    comparisons = 0

    total = len(swiggy)

    for sw_idx in range(total):
        name = sw_names[sw_idx]
        location = sw_locations[sw_idx]

        if not name or not location:
            continue

        candidate_indices = zomato_by_location.get(location, [])

        if not candidate_indices:
            continue

        # Cached list avoids expensive Pandas lookups in the loop.
        candidate_names = [zo_names[i] for i in candidate_indices]

        candidates = process.extract(
            name,
            candidate_names,
            scorer=fuzz.WRatio,
            limit=MAX_CANDIDATES,
            score_cutoff=REVIEW_THRESHOLD
        )

        for _, name_score, candidate_position in candidates:
            zo_idx = candidate_indices[candidate_position]
            comparisons += 1

            area1 = sw_areas[sw_idx]
            area2 = zo_areas[zo_idx]

            area_score = (
                fuzz.WRatio(area1, area2)
                if area1 and area2 else None
            )

            if name_score >= MATCH_THRESHOLD and (
                area_score is None or area_score >= 85
            ):
                status = "possible_match"
            else:
                status = "manual_review"

            result = {
                "swiggy_row": sw_idx,
                "zomato_row": zo_idx,
                "swiggy_name": sw_original_names[sw_idx],
                "zomato_name": zo_original_names[zo_idx],
                "swiggy_location": sw_original_locations[sw_idx],
                "zomato_location": zo_original_locations[zo_idx],
                "swiggy_area": sw_original_areas[sw_idx],
                "zomato_area": zo_original_areas[zo_idx],
                "name_similarity": round(name_score, 2),
                "area_similarity": (
                    round(area_score, 2)
                    if area_score is not None else None
                ),
                "match_status": status
            }

            if status == "possible_match":
                matches.append(result)
            else:
                reviews.append(result)

            swiggy_with_candidates.add(sw_idx)

        if (sw_idx + 1) % 10000 == 0:
            print(f"Processed {sw_idx + 1:,} / {total:,} Swiggy records")

    columns = [
        "swiggy_row", "zomato_row",
        "swiggy_name", "zomato_name",
        "swiggy_location", "zomato_location",
        "swiggy_area", "zomato_area",
        "name_similarity", "area_similarity", "match_status"
    ]

    pd.DataFrame(matches, columns=columns).to_csv(
        OUTPUT_FILE, index=False, encoding="utf-8-sig"
    )
    pd.DataFrame(reviews, columns=columns).to_csv(
        REVIEW_FILE, index=False, encoding="utf-8-sig"
    )

    unmatched = swiggy.loc[
        [
            i not in swiggy_with_candidates
            for i in range(len(swiggy))
        ]
    ].drop(
        columns=[
            "_provider", "_match_name",
            "_match_location", "_match_area"
        ],
        errors="ignore"
    )

    unmatched.to_csv(
        UNMATCHED_FILE, index=False, encoding="utf-8-sig"
    )

    print("\n--- CROSS-PROVIDER RESOLUTION COMPLETE ---")
    print(f"Swiggy records: {len(swiggy):,}")
    print(f"Zomato records: {len(zomato):,}")
    print(f"Candidate comparisons: {comparisons:,}")
    print(f"Possible matches: {len(matches):,}")
    print(f"Manual review candidates: {len(reviews):,}")
    print(f"Swiggy records without candidates: {len(unmatched):,}")
    print(f"\nMatches: {OUTPUT_FILE}")
    print(f"Review: {REVIEW_FILE}")
    print(f"Unmatched: {UNMATCHED_FILE}")


if __name__ == "__main__":
    main()
