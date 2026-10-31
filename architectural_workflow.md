# Food Delivery aggregator

These logs are mainitained by me, in order, to understand how architectural workflow connects with each other, how i orchestrated GenAI tools to complete the task


## Step 1: Dataset Inspection

Before building a machine learning model, the dataset must be inspected to understand its structure, quality, and suitability for the intended task.

### Objectives
- Understand the number of rows and columns.
- Identify the features (input variables) and target variable, if available.
- Check the data types of each column.
- Identify missing values and duplicate records.
- Examine basic statistics and the distribution of values.
- Understand what the dataset represents before deciding on preprocessing techniques or an ML algorithm.

### Python Implementation

```python
import pandas as pd

# Load the dataset
df = pd.read_csv("dataset.csv")

# Display the first five rows
print(df.head())

# Check the number of rows and columns
print(df.shape)

# Inspect column names and data types
print(df.info())

# Check missing values in each column
print(df.isnull().sum())

# Count duplicate rows
print(df.duplicated().sum())

# Generate descriptive statistics
print(df.describe(include="all"))
```

### What Each Inspection Tells Us

| Method | Purpose |
|---|---|
| `df.head()` | Understand the structure and appearance of the records. |
| `df.shape` | Find the number of rows and columns. |
| `df.info()` | Inspect column names, data types, and non-null counts. |
| `df.isnull().sum()` | Identify missing values in each column. |
| `df.duplicated().sum()` | Count duplicate rows. |
| `df.describe(include="all")` | Summarize numerical and categorical columns. |

### Outcome

Dataset inspection provides an initial understanding of the available data and helps determine the next steps, such as data cleaning, preprocessing, feature selection, and model selection.

The dataset findings and current service/API boundaries are recorded below and in the [backend guide](backend/README.md). These checks describe the committed synthetic snapshot, not live provider data.

### Observations
- The committed CSVs contain 200 provider listings (17 columns), 100 canonical restaurants (9), 320 menu rows (13), 110 offers (14), 320 reviews (10), and 100 restaurant-match evaluation pairs (8).
- The saved binary entity-match evaluation covers 70 pairs: 33 true positives, 35 true negatives, 2 false negatives, and 0 false positives (97.14% accuracy, 100% precision, 94.29% recall). The 30 `manual_review` pairs are intentionally excluded from binary metrics. These are synthetic labels, not real-market validation.
- Optional missing provider values include 15 canonical IDs (unmatched listings), 14 ratings, 8 rating counts, 13 average menu prices, and 12 delivery estimates. They remain unknown; unmatched listings stay individually addressable.
- Menu rows contain 6 unknown prices and 72 unknown availability labels. Unknown availability is treated as unavailable for recommendation and basket comparison. Unknown price remains null.
- Offer rows contain missing discount values, minimums, and caps. Offers with unknown minimums or discount rules are not applied. Missing platform/delivery fees are not represented as zero; totals are lower bounds.
- Canonical restaurant rows have no missing required identity fields in the committed snapshot. Review rows have dates and sentiment labels, but repeated normalized review text is common in this synthetic set and is surfaced only as a human-review signal.
- The review corpus is labeled data, not an order or demand series. It cannot support a demand forecast or a fraud-classification metric.
