# FoodLens Backend

FoodLens is a cross-provider food comparison project for the Indian delivery market. Express is the frontend-facing API gateway; Python processes the committed synthetic provider, menu, offer, and review CSVs.

> **Important:** This backend uses synthetic demo data only. It does not scrape delivery platforms, verify checkout prices, place orders, or represent real restaurant availability. Admin decisions are local demo actions kept in memory and do not alter canonical assignments.

## Highlights

### Current connected functionality
- Express exposes health, metadata, restaurant/menu search, restaurant detail, basket comparison, recommendation, review-pattern, and data-quality routes and forwards data work to Python.
- Python computes reputation summaries, menu recommendations, basket prices, and explanations from committed CSVs. Recommendation results are built on demand so filters and user priorities affect ranking; no generated intelligence dataset is required.
- Review-pattern signals flag repeated normalized text and same-provider/date review clusters for human inspection. They are not fraud labels.
- Admin review cards come from synthetic benchmark rows marked `manual_review`; choices only hide a sample for the current Python process and never rewrite source datasets or canonical assignments.
- Smart Meal and the local basket use API results. Shared Cart is a single-browser calculation, not a synchronized group cart. Savings history, sustainability impact data, and accounts are clearly unavailable rather than populated with sample numbers.

## Stack and architecture

- **Application API:** Node.js, TypeScript, Express
- **Data and intelligence API:** Python, FastAPI, pandas, reading the committed CSV datasets
- **Canonical restaurant/menu data:** committed synthetic CSV files
- **Customer persistence:** PostgreSQL for accounts, profiles/preferences, sessions, saved restaurants, and consented interaction events
- **Frontend:** React + Vite can call `/api/*`; configure its dev proxy to `http://localhost:4000`

Data flow:

```text
Public demo fixtures -> React only (no writes or customer-event tracking)
Customer browser -> Vercel same-origin /api rewrite -> Express gateway
                                                    |             |
                                                    v             v
                                           PostgreSQL       Python/FastAPI -> canonical CSVs
```

## Requirements

- Node.js 20+ recommended
- npm
- Python 3.10+ and pip

## Run locally

Open three terminals. From `backend/`, install the Python service dependencies and start FastAPI:

```bash
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

In a second terminal, from `backend/`, start Express:

```bash
npm install
npm run dev
```

In a third terminal, from `frontend/`, install and start Vite:

```bash
npm install
npm run dev
```

The React app calls `/api`; Vite proxies that path to Express at `http://127.0.0.1:4000`, and Express forwards data operations to Python at `http://127.0.0.1:8000`. Set `PYTHON_API_URL` if Python runs elsewhere. Copy `.env.example` to `.env` and configure `DATABASE_URL` for customer accounts. Without PostgreSQL, CSV-backed public search and comparison still work, while account operations return a clear 503.

Create a PostgreSQL database, set `DATABASE_URL` (and `DATABASE_SSL=true` if your provider requires TLS), then apply the schema from `backend/`:

```bash
npm run migrate
```

The migration is repeatable and creates customer-only tables; it does not touch the canonical CSV datasets. New users receive the `customer` role. To grant an administrator, change a trusted account's role directly in PostgreSQL; never expose an admin registration option in the browser. Production browser sessions use secure HttpOnly cookies and CSRF checks. Turning interaction consent off deletes that user's stored interaction events. Keep Express `CORS_ORIGIN` restricted to the actual frontend origin(s).

For Vercel, the frontend includes a same-origin `/api/*` rewrite to the Render gateway, which avoids third-party-cookie restrictions. Set Vercel's `VITE_API_BASE_URL` to `/api` (Config, not a `VITE_` prefixed secret; this value is public routing configuration). The Render gateway must have the production Vercel origin in `CORS_ORIGIN`, `DATABASE_URL` set to a PostgreSQL instance, `DATABASE_SSL` as required by that provider, and `PYTHON_API_URL` pointed at the Python service. Run the migration once before enabling account registration. No deployment settings or database have been changed by this implementation.

Administrative write actions are disabled by default. To enable them for a local demo, set `ADMIN_DEMO_MODE=true` in both service environments while keeping Express and Python bound to loopback. Express also refuses these writes in production or when configured to listen on a non-loopback host.

```bash
npm run typecheck
```

Run Python tests from `backend/` after installing the development test requirements:

```bash
python -m pip install -r requirements-dev.txt
python -m pytest
```

## API reference

All endpoints are prefixed with `/api`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Express and Python data-service health |
| GET | `/api/meta` | Data mode, synthetic-data notice, provider/cuisine lists, and demo-write status |
| GET | `/api/search?q=biryani` | Search canonical restaurants and menu items; supports `cuisine`, `provider`, `city`, `area`, `minRating`, `maxEta`, `page`, and `pageSize` (maximum 50 per page) |
| GET | `/api/restaurants/:id` | Complete canonical restaurant detail, listings, menu offers, sentiment summary, conflicts, and observations |
| POST | `/api/compare` | Accepts `restaurantId`, `selections: [{itemId, qty}]`, `priority`, and optional `maxEta`; returns ranked `options` and `excluded` providers |
| GET | `/api/intelligence/recommendations` | Ranks available menu rows for `budgetPerPerson`, `people` (1–12), `vegetarian`, `cuisine`, `priority`, and `limit`; returns evidence factors and reasons. It assumes quantity equals the requested people count (one menu item per person); subtotals exclude fees and tax. |
| GET | `/api/intelligence/review-signals` | Lists repeated normalized review text and same-provider/date volume clusters for human inspection; never classifies fraud. |
| GET | `/api/admin/review-queue` | Synthetic `manual_review` benchmark examples; explicitly marked demo-only |
| GET | `/api/admin/pipeline` | Dataset counts and CSV validation issues |
| POST | `/api/admin/review-queue/:id/decision` | Local demo-only `merge` or `keep_separate` action, disabled by default and not persisted |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowed frontend origins for Express and Python |
| `HOST` | `127.0.0.1` | Express bind host; non-loopback hosts disable demo admin writes |
| `PYTHON_API_URL` | `http://127.0.0.1:8000` | Base URL for the FastAPI data service |
| `DATABASE_URL` | unset | PostgreSQL connection URL for customer accounts and data |
| `DATABASE_SSL` | `false` | Enables TLS for PostgreSQL connections when required by provider |
| `ADMIN_DEMO_MODE` | `false` | Enables process-local demo decisions outside production only |

Set `HOST=127.0.0.1` and `ADMIN_DEMO_MODE=true` in both Python and Express environments only when you intentionally want to exercise local demo decisions. Express disables them in production and when bound to a non-loopback host; Python also requires a loopback client. There are no database credentials or provider API keys required by the CSV-backed MVP.

## Intelligence and evaluation

- Reputation shrinks source ratings toward a 3.9 prior and combines sources with `log(1 + rating_count)` weights. Evidence level is low/medium/high based on rating volume and the number of distinct review texts. Aspect sentiment uses supplied synthetic labels, smoothed toward neutral; at least 3 labels are required before it is treated as sufficient evidence.
- Recommendation and basket ranking use explicit weights for value, cheapest, fastest, reliability, and rating. Missing factors score neutrally and are marked unknown; stale data receives a documented penalty. Results include reasons and factor values.
- Current review-pattern signals can be biased by repeated generated templates in the synthetic data. There are no ground-truth fraud labels, so precision/recall is not reported and signals must not be treated as fraud findings.
- `evaluation_results.csv` contains 70 labeled binary entity-match pairs: 33 true positives, 35 true negatives, 2 false negatives, and 0 false positives (97.14% accuracy, 100% precision, 94.29% recall). Thirty `manual_review` examples are excluded from that binary score. This small synthetic pair set does not validate real-world entity resolution quality.
- Demand forecasting is not implemented: the repository has review dates but no timestamped orders, order counts, or demand target. Review activity is not a valid substitute for order demand.
- Recommendations are computed at request time from the CSVs. No `intelligence_ranked_view.csv` is required or generated.

## Current limitations

- Synthetic provider data only.
- Review decisions are in-memory demo state, reset after restart, and do not change the canonical datasets.
- Shared-cart contents and participant names exist only in the current browser page; there are no invite sessions or cross-device synchronization.
- Customer accounts and preferences require a configured PostgreSQL database. Comparison history and orders are not implemented. The Savings page does not claim amounts saved.
- Environmental impact inputs (ingredient footprint, packaging, distance, transport mode) are absent, so no sustainability score or emissions estimate is produced.
- Provider links and exact delivery/platform fees are absent from the CSV data; comparison totals are marked as lower bounds when fees are unknown.
- Menu rows with unknown availability are not treated as available. Offers with unknown minimums or incomplete discount rules are not applied.
- Review sentiment uses the dataset's supplied labels, which are synthetic and unverified. It is not a trained model and cannot handle nuance beyond those labels.
- Ranking and GST/discount assumptions have not been validated against real checkout data.
- No payments, orders, or real provider integrations. Consent-based personalization is a small explainable cuisine-count adjustment, not a trained ML model; it falls back to explicit saved preferences when insufficient events exist.
- Admin demo writes require explicit local-only flags and are not durable. Add authenticated, audited persistence before production use.

## Tests and builds

From `backend/`:

```bash
npm run typecheck
npm test
python -m pip install -r requirements-dev.txt
python -m pytest
```

From `frontend/`:

```bash
npm run build
```

The Python tests exercise API contracts against the committed CSV schemas, search pagination, basket quantities/fees/offers, recommendation filtering, review-pattern signals, admin safeguards, entity-match evaluation counts, menu matching, and missing-data behavior. A live gateway smoke test should be run with both services running when network policy permits.

## License

Add the licence appropriate for your project before publishing.
