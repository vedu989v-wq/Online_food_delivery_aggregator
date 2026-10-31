# FoodLens Backend

FoodLens is a cross-provider food comparison project for the Indian delivery market. Express is the frontend-facing API gateway; Python processes the committed synthetic provider, menu, offer, and review CSVs.

> **Important:** This backend uses synthetic demo data only. It does not scrape delivery platforms, verify checkout prices, place orders, or represent real restaurant availability. Admin decisions are local demo actions kept in memory and do not alter canonical assignments.

## Highlights

### Current connected functionality
- Express exposes health, metadata, restaurant/menu search, restaurant detail, basket comparison, recommendation, review-pattern, and data-quality routes and forwards data work to Python.
- Python computes reputation summaries, menu recommendations, basket prices, and explanations from committed CSVs. Recommendation results are built on demand so filters and user priorities affect ranking; no generated intelligence dataset is required.
- Review-pattern signals flag repeated normalized text and same-provider/date review clusters for human inspection. They are not fraud labels.
- Admin review cards come from synthetic benchmark rows marked `manual_review`; choices only hide a sample for the current Python process and never rewrite source datasets or canonical assignments.
- SmartMeal uses CSV menu candidates, a trained model on clearly synthetic preference labels when available, and documented deterministic fallback; nutrition remains unavailable unless provenance-bearing dish records are imported. Shared Cart is persisted and synchronized through authenticated PostgreSQL APIs. Comparison history and sustainability impact data remain unavailable.

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

For Vercel, the frontend includes a same-origin `/api/*` rewrite to the Render gateway, which avoids third-party-cookie restrictions. Set Vercel's `VITE_API_BASE_URL` to `/api` (Config, not a `VITE_` prefixed secret; this value is public routing configuration). The Render gateway must have the production Vercel origin in `CORS_ORIGIN`, `DATABASE_URL` set to a PostgreSQL instance, `DATABASE_SSL` as required by that provider, and `PYTHON_API_URL` pointed at the Python service. Run the migration once before enabling account registration. When the free Python service sleeps, the frontend error banner links directly to its public `/api/health` endpoint to wake it before retrying. Set `VITE_PYTHON_WAKE_URL` only if that health URL changes; it is public configuration, not a secret. Keep provider credentials and database URLs in hosting-provider secret configuration; do not commit them here.

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
- Shared carts, invitations, participant membership, item ownership, and event history require PostgreSQL and the new migration. Group delivery addresses require `FOODLENS_PII_KEY` encryption.
- Customer accounts and preferences require a configured PostgreSQL database. Comparison history and orders are not implemented. The Savings page does not claim amounts saved.
- Environmental impact inputs (ingredient footprint, packaging, distance, transport mode) are absent, so no sustainability score or emissions estimate is produced.
- Provider links and exact delivery/platform fees are absent from the CSV data; comparison totals are marked as lower bounds when fees are unknown.
- Menu rows with unknown availability are not treated as available. Offers with unknown minimums or incomplete discount rules are not applied.
- Review sentiment uses the dataset's supplied labels, which are synthetic and unverified. It is not a trained model and cannot handle nuance beyond those labels.
- Ranking and GST/discount assumptions have not been validated against real checkout data.
- No payments, orders, or real provider integrations. The trained model uses synthetic simulated preference labels and must not be described as learning from customers or nutrition data. Consented cuisine counts supplement explicit preferences; the deterministic fallback remains available.
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
# SmartMeal and Basket Split implementation status

The corrected implementation adds optional, consented SmartMeal health-profile storage (`/api/customer/health-profile`), nutrition provenance lookup (`/api/smartmeal/nutrition`), a reproducible supervised preference-fit training pipeline, and authenticated persisted shared baskets (`/api/shared-carts`).

## Database setup

Run `npm run migrate` with `DATABASE_URL` configured. Migration `002_smartmeal_basket_split.sql` adds health profiles, nutrition records, shared carts, one-use invitations, member-owned items, event history, allocations, and payment audit tables. Migration `003_basket_split_lifecycle.sql` adds locked price snapshots, checkout lifecycle states, and payment QR metadata. Health profiles are stored only after explicit consent and are deleted by `DELETE /api/customer/health-profile`.

Set `FOODLENS_PII_KEY` to a random 32-byte key encoded as 64 hex characters before enabling shared delivery-address entry. Addresses are encrypted with AES-256-GCM; member confirmation fingerprints use HMAC-SHA256. Do not log this key or put it in a `VITE_` variable. Rotate it only with a migration plan for existing ciphertext.

## SmartMeal nutrition and model

The restaurant/menu CSVs remain canonical synthetic application data and are not modified. Nutrition values are not inferred from item names. The endpoint returns `unavailable` unless `nutrition_records` contains a dish-specific row with source, serving size, method, and verification status. Add records only from licensed, documented data and retain the source reference; a menu label by itself is not a nutrition record. USDA FoodData Central data are Public Domain/CC0; review its [API guide](https://fdc.nal.usda.gov/api-guide/) and dataset record before creating an ingredient-to-recipe estimate. Ingredient quantities and serving sizes must be documented; otherwise leave nutrition unavailable.

For a reviewed recipe mapping, create a JSON array with `dish_key`, `dish_name`, `serving_size_g`, and explicit `ingredients: [{"fdc_id": ..., "grams": ...}]` entries. Set `USDA_FDC_API_KEY` in a private shell, run `python ml/import_usda_recipes.py <recipes.json> <nutrition_records.json>`, inspect the generated provenance, then run `npm run import:nutrition -- <nutrition_records.json>` with `DATABASE_URL` set. There are no prefilled recipe mappings because the current synthetic menu lacks verified ingredient quantities.

Train the supervised synthetic preference model with `python ml/train_smartmeal.py`. It compares a logistic-regression baseline with a random forest, groups the holdout by simulated user, and writes `models/smartmeal.joblib` plus `models/smartmeal-evaluation.json`. Labels are generated from a documented simulated preference utility; metrics do not measure real customer satisfaction, health outcomes, or nutrition accuracy. The API uses that model only when the artifact loads successfully and labels the model source. Otherwise it returns the deterministic ranking fallback. Model inference never overrides hard vegetarian, budget, location, or delivery-time filters.

## Shared Basket Split and payment boundary

Shared basket reads/writes require an authenticated account and CSRF protection. Unlocked carts expire after 48 hours. Invitations contain a random one-use token; only its hash is stored, and it expires after 24 hours. The maximum participant count is configurable with `SHARED_CART_MAX_MEMBERS` (2–20, default 8). Organizers can revoke pending invitations and remove members before lock; non-organizers can leave before lock. Members can add, edit, and remove their own items. The event endpoint is a polling cursor suitable for synchronization; the frontend polls every three seconds.

Important basket routes: `GET/POST /api/shared-carts`, `GET /api/shared-carts/:id`, `POST /:id/invitations`, `DELETE /:id/invitations`, `POST /api/shared-carts/join`, `POST /:id/leave`, organizer-only `DELETE /:id/members/:userId`, `POST/DELETE/PATCH /:id/items`, `PUT /:id/address`, `POST /:id/address-confirmation`, `GET /:id/events?after=<cursor>`, organizer-only `POST /:id/lock`, `POST /:id/reopen`, and organizer-only `POST /:id/cancel`. SmartMeal health routes are `GET/PUT/DELETE /api/customer/health-profile`; optional numeric nutrition constraints use the authenticated `GET /api/customer/recommendations`, and provenance lookup is `GET /api/smartmeal/nutrition?itemIds=...`. The payment request endpoint is `POST /api/shared-carts/:id/payment-request`; the Razorpay webhook receiver is `/api/payments/webhooks/razorpay`.

Locking requires an organizer, at least one item, a known-fee provider, and every participant's explicit confirmation of the same organizer-selected address. The backend rechecks menu availability and asks the Python comparison API for the basket breakdown. Unknown charges are rejected; the resulting synthetic comparison estimate includes the project's 5% food-tax assumption, source delivery/platform fees, fee tax, and provider discount when available. It is converted to integer paise and split by item value: delivery/platform fees are shared evenly, tax and discounts are allocated proportionally, and deterministic largest-remainder rounding reconciles exactly. Cart version checks prevent a concurrent edit from being locked at a stale amount. The UI records the provider and version snapshot and shows each participant's share.

The shared prices, fees, and taxes are still synthetic comparison data, not a real checkout quote. For that reason, QR generation is enabled only when `PAYMENT_ENV=test` and `RAZORPAY_KEY_ID` starts with `rzp_test_`; live Razorpay credentials are rejected. Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PAYMENT_ENV=test`, `DATABASE_URL`, and `FOODLENS_PII_KEY` to exercise individual test QRs. Webhook signatures use raw request bytes; duplicate provider event IDs are ignored, and payment status is confirmed only by fetching the matching captured INR payment for the QR and expected amount. All participant payments must be verified before the basket becomes `ready_for_checkout`. QR codes are fixed-amount, single-use and automatically expire; test QRs are explicitly closed before an unpaid basket is reopened, using Razorpay's documented [close QR API](https://razorpay.com/docs/api/qr-codes/close/). A participant may save the image and use their UPI app's scan-from-gallery feature where supported, or scan it from a second device.

FoodLens does not integrate with a restaurant provider's live ordering API and does not place or complete an order. Do not switch to production payment credentials until an authorized provider integration returns a live, exact quote and the product has a legally appropriate merchant/settlement arrangement. If fee, tax, discount or exact-paise totals do not reconcile, locking fails closed. Organizer cancellation and changes are blocked after lock; there is no reopen/refund flow yet. QR test-mode integration requires a Razorpay account with test keys and a configured webhook; those credentials are not in this repository.
