import pandas as pd

df = pd.read_csv("zomato_dataset.csv")

print("Dataset shape:", df.shape)
print("\nColumns:")
print(df.columns.tolist())

print("\nSample records:")
print(df.head())

print("\nMissing values:")
print(df.isnull().sum())