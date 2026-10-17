
import pandas as pd

swiggy = pd.read_csv("backend/data/swiggy_file.csv")
zomato = pd.read_csv("backend/data/zomato_dataset.csv")

print("SWIGGY COLUMNS:")
print(swiggy.columns.tolist())

print("\nZOMATO COLUMNS:")
print(zomato.columns.tolist())

print("\nSWIGGY SAMPLE:")
print(swiggy.head(2).to_string(index=False))

print("\nZOMATO SAMPLE:")
print(zomato.head(2).to_string(index=False))
