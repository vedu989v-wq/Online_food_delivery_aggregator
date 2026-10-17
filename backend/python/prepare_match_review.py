
from pathlib import Path
import pandas as pd

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "backend" / "data"

MATCHES_FILE = DATA_DIR / "cross_provider_matches.csv"
REVIEW_FILE = DATA_DIR / "cross_provider_needs_review.csv"
OUTPUT_FILE = DATA_DIR / "cross_provider_review_template.csv"


def main():
    frames = []

    for path in [MATCHES_FILE, REVIEW_FILE]:
        if path.exists():
            df = pd.read_csv(path, encoding="utf-8-sig")

            if not df.empty:
                frames.append(df)

    if not frames:
        raise FileNotFoundError(
            "No cross-provider match candidates found. "
            "Run cross_provider_resolver.py first."
        )

    candidates = pd.concat(frames, ignore_index=True)

    # Avoid reviewing the same pair more than once.
    candidates = candidates.drop_duplicates(
        subset=["swiggy_row", "zomato_row"]
    )

    # Leave the decision blank so no fuzzy match is
    # accidentally treated as a confirmed identity.
    candidates["review_decision"] = ""
    candidates["review_notes"] = ""

    candidates.to_csv(
        OUTPUT_FILE, index=False, encoding="utf-8-sig"
    )

    print("Candidate pairs:", len(candidates))
    print("Review sheet:", OUTPUT_FILE)
    print("\nFill review_decision with one of:")
    print("same_restaurant")
    print("different_restaurant")
    print("uncertain")


if __name__ == "__main__":
    main()
