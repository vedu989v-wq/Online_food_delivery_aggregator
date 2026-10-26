# FoodLens Backend

FoodLens is a cross-provider food comparison backend for the Indian delivery market. It creates a canonical restaurant view from provider listings, preserves provider-specific prices and delivery facts, analyses reputation, estimates basket totals, and explains provider rankings.

> **Important:** This starter backend uses synthetic demo data only. It does not scrape delivery platforms, verify checkout prices, place orders, or represent real restaurant availability. Admin routes are not authenticated and are for local development only.

## Highlights

### Core product features
- Provider adapter boundary (`src/data`) so authorised feeds can be added without rewriting the pipeline.
- Data validation and data-quality issue log.
- Name/address/phone/geography-based entity resolution with conservative thresholds.
- Canonical restaurant profiles, cross-provider menu matching, conflict notes, and provider-specific offers.
- Freshness labels and unknown values preserved as `null` rather than silently treated as zero.
- Review de-duplication and aspect sentiment baseline for food, delivery, value, and service.
- Basket price estimate including simplified GST/offer assumptions; unknown fees mark totals as a lower bound.
- User-priority ranking: best value, cheapest, fastest, most reliable, best rated.
- Ranking explanations, factor weights, exclusions, freshness penalties, and badges.
- Human review queue for uncertain matches.
- PostgreSQL target schema for persistent observations and auditable decisions.

### Standout features to foreground in a demo
1. **Truth, not just a score:** show which provider supplied each value, when it was observed, and where sources disagree.
2. **Explainable comparison:** every ranking exposes its factor scores and weights instead of presenting a black-box “best”.
3. **Unknown-fee honesty:** totals with missing fees are labelled “at least” / lower-bound estimates.
4. **Conservative entity resolution:** uncertain restaurant identities are queued for a human rather than automatically merged.
5. **Restaurant quality vs delivery quality:** food sentiment is not conflated with provider-specific delivery sentiment.
6. **Price history-ready data model:** append-only observations support future price trends and “price changed” alerts.
7. **Responsible review intelligence:** heuristic output is labelled, deduplicated reviews are counted, and fake-review detection is deliberately not claimed without evaluation.

## Stack and architecture

- **API:** Node.js, TypeScript, Express
- **Current data store:** in-memory synthetic MVP store
- **Persistence target:** PostgreSQL (`db/schema.sql`)
- **Python extension:** reserved for offline ML evaluation, anomaly features, demand forecasting, and later validated models
- **Frontend:** React + Vite can call `/api/*`; configure its dev proxy to `http://localhost:4000`

Data flow:

```text
Provider adapters
      |
      v
Validate -> Normalise -> Entity resolution -> Menu matching -> Reconcile
      |                                                       |
      v                                                       v
Issues + uncertain-match queue                         Canonical store
                                                              |
                                  +---------------------------+------------------+
                                  v                           v                  v
                              Reputation                   Pricing            Ranking
                                  +---------------------------+------------------+
                                                              |
                                                              v
                                                       Express REST API
```

## Requirements

- Node.js 20+ recommended
- npm
- Python is **not required** to run this API starter

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

On Windows PowerShell, if `cp` is unavailable:
```powershell
Copy-Item .env.example .env
```

API starts at `http://localhost:4000`.

```bash
npm run typecheck
npm test
```

## API reference

All endpoints are prefixed with `/api`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Health status |
| GET | `/meta` | Data mode, synthetic warning, provider list, supported priorities |
| GET | `/search?q=biryani&page=1&pageSize=12` | Search restaurants; supports `cuisine`, `minRating`, `maxEta`, `page`, `pageSize` |
| GET | `/restaurants/:id` | Canonical restaurant, source listings, menu, conflicts, observations, reputation |
| POST | `/compare` | Price a basket and rank providers for a selected priority |
| GET | `/admin/review-queue` | Uncertain cross-provider matches |
| POST | `/admin/review-queue/:id/decision` | Record `merge` or `reject` decision |
| GET | `/admin/pipeline` | Pipeline counts and validation issues |

### Example: compare basket

First get a restaurant ID from `/api/search`, then send its menu item IDs:

```json
{
  "restaurantId": "restaurant-1",
  "selections": [
    { "itemId": "foodhub-101-biryani", "quantity": 1 },
    { "itemId": "foodhub-101-paneer", "quantity": 1 }
  ],
  "priority": "best_value",
  "maxEta": 45
}
```

`priority` must be one of `best_value`, `cheapest`, `fastest`, `most_reliable`, `best_rated`. Basket quantities must be integers from 1 to 20. Item IDs are provider-specific in this starter; choose IDs from the canonical restaurant menu response.

### Response honesty
- `verified` is always `false`.
- Unknown delivery/platform fees are included in `unknownFees` and mark the total as a lower bound.
- GST values are assumptions, not tax advice or a provider checkout quote.
- Ranking weights are hypotheses and must be evaluated with users before production use.
- Sentiment uses `lexicon-baseline-v0`, a simple word-list heuristic, not a validated ML model.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed frontend origins |
| `DATA_MODE` | `synthetic` | Data mode banner |
| `PYTHON_BIN` | `python` | Reserved for later Python worker integration |

## Folder structure

```text
backend/
├── db/schema.sql
├── python/README.md
├── src/
│   ├── data/synthetic.ts
│   ├── intelligence/{pricing,reputation,ranking}.ts
│   ├── pipeline/{text,validate,resolve,store}.ts
│   ├── routes/api.ts
│   ├── tests/pipeline.test.ts
│   ├── server.ts
│   └── types.ts
├── .env.example
├── package.json
└── tsconfig.json
```

## Standout features to build next

1. **Price movement alerts:** compare timestamped observations and flag meaningful price changes.
2. **Confidence-aware review intelligence:** add a labelled review set and report evaluation metrics before using an ML model.
3. **Suspicious-review signals:** surface duplicate text, unusual timing, rating bursts, and repeated phrases as *signals for review*, never automatic fraud verdicts.
4. **Demand forecasting:** start with time-of-day/day-of-week baselines; compare against a held-out time period.
5. **Personalised ranking:** accept explicit user preferences and keep the ranking explanation visible.
6. **PostgreSQL persistence:** replace in-memory state and save every ingestion/reconciliation decision.
7. **Admin protection:** add authentication, role checks, audit logging, rate limiting, and request validation before deployment.
8. **Provider integrations:** use authorised partner APIs, feeds, restaurant partnerships, or ONDC-compatible integrations; do not depend on unrestricted scraping.

## Current limitations

- Synthetic provider data only.
- In-memory state resets after restart; review decisions are not durable.
- Admin endpoints are open and must not be exposed publicly.
- Review sentiment is English word-list based and can miss sarcasm, context, and non-English reviews.
- Ranking and GST/discount assumptions have not been validated against real checkout data.
- No accounts, payments, orders, or real provider integrations.
- Entity-resolution review decisions are only an MVP in-memory workflow; persist decisions before real use.

## License

Add the licence appropriate for your project before publishing.
