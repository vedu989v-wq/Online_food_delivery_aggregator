# Food Delivery aggregator

These logs are mainitained by me, in order, to understand how architectural workflow connects with each other, how i orchestrated GenAI tools to complete the task

## Data Pipeline Progress

### Step 1 — Dataset Inspection
**Status: Completed**

- Loaded and inspected the Swiggy and Zomato restaurant datasets using Pandas.
- Examined dataset dimensions, column names, and sample records.
- Identified differences in the schemas and fields available from each provider.

### Step 2 — Data Cleaning and Normalization
**Status: Initial implementation prepared**

- Standardized column names and removed unnecessary whitespace.
- Normalized selected text fields for consistent processing.
- Removed exact duplicate rows in the derived dataset.
- Preserved the original datasets separately.

### Step 3 — Data Validation
**Status: Initial implementation prepared**

- Implemented checks for missing or unreadable ratings and prices.
- Flagged ratings outside the expected 0–5 range and negative prices.
- Separated records passing the implemented checks from records requiring review.
- Preserved records with validation issues instead of silently deleting them.

### Step 4 — Ingestion and Record Identity
**Status: Prototype implemented**

- Generated deterministic identity keys using provider and restaurant-identifying fields.
- Explored duplicate detection within imported records.
- Separated records with missing identifying information for review.
- Identified the need for stable provider record IDs and database constraints to support reliable idempotent ingestion across repeated runs.

### Step 5 — Restaurant Entity Resolution
**Status: In progress**

- Implemented an initial approach using Python and RapidFuzz for restaurant-name similarity.
- Developed separate provider-specific scripts for Swiggy and Zomato.
- Used normalized restaurant names and locations to identify potential duplicates.
- Introduced candidate classifications for possible duplicates and manual review.
- Identified performance limitations in pairwise comparisons within large location groups.

**Current limitations:**
- Matching results have not yet been fully validated.
- Similarity scores do not prove that records represent the same restaurant or branch.
- Candidate generation needs optimization before processing large datasets.
- Provider observations must remain separate until their identities and relationships are established.

### Next Steps

- Optimize candidate generation and comparison performance.
- Validate matching results against manually checked examples.
- Improve branch-level identification and duplicate handling.
- Implement price normalization while preserving serving basis.
- Design canonical restaurant records and provider-specific observations.
- Add PostgreSQL persistence, stable source identifiers, and cross-run idempotency.
