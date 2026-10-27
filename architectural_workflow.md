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

*Note: The actual findings should be documented after running these checks on the dataset.*

### Observations
- Total records: TBD
- Total columns: TBD
- Missing values: TBD
- Duplicate records: TBD
- Target variable: TBD
- Potential data quality issues: TBD
