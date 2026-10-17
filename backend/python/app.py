
import sys
from pathlib import Path

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT_DIR / "backend" / "data"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

swiggy = pd.read_csv(DATA_DIR / "swiggy_file.csv")
zomato = pd.read_csv(DATA_DIR / "zomato_dataset.csv")

print("SWIGGY COLUMNS:")
print(swiggy.columns.tolist())

print("\nZOMATO COLUMNS:")
print(zomato.columns.tolist())

print("\nSWIGGY SAMPLE:")
print(swiggy.head(2).to_string(index=False))

print("\nZOMATO SAMPLE:")
print(zomato.head(2).to_string(index=False))
