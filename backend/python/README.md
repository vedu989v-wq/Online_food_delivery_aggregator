# Python intelligence extension

The API currently runs the documented explainable lexicon baseline in TypeScript so the MVP works without a second server. Keep Python for the next stage: offline review-data evaluation, anomaly features, demand forecasting, and model experiments. Do not label reviews as fake or users as fraudulent without validated evidence.

Suggested isolated environment:
```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
pip install pandas scikit-learn
```
Start with a labelled evaluation CSV before training or replacing the baseline. Record model version, precision/recall, data provenance, and known language limitations.
