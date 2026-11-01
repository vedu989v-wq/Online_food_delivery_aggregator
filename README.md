# FoodLens

FoodLens is a React + Vite food comparison MVP backed by an Express + TypeScript API gateway and a Python + FastAPI data and intelligence service. It reads the committed CSV datasets and can persist customer accounts and preferences in PostgreSQL.

> **Demo data:** restaurant, menu, provider, rating, availability, fee, and review records are synthetic. Friend Basket Split always creates one QR per participant: Razorpay test QRs when test credentials are configured, or local scannable demo labels marked **NOT A PAYMENT** when they are not. No live payment is accepted and no restaurant order is placed. Estimates are not live provider prices or checkout totals.

## Run locally

Requirements: Node.js 20+, npm, and Python 3.10+ with pip. To use customer accounts, configure PostgreSQL as described in [backend/README.md](backend/README.md).

Start each process in a separate terminal:

```powershell
# Terminal 1: Python API
cd backend
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000

# Terminal 2: Express gateway
cd backend
npm install
npm run dev

# Terminal 3: React frontend
cd frontend
npm install
npm run dev
```

Vite proxies `/api/*` to Express on port 4000; Express forwards the CSV-backed routes to FastAPI on port 8000. Copy `backend/.env.example` to `backend/.env` to configure local settings. PostgreSQL is optional for the public search and comparison demo; account operations need `DATABASE_URL` and the migration described in the backend guide. In production, the error banner links to the Python health endpoint so a user can wake a sleeping Render free service, then retry.

Account-based Basket Split requires PostgreSQL migrations and `FOODLENS_PII_KEY` to encrypt the shared address. Friend Basket Split can create a local non-payable demo QR without payment credentials; genuine Razorpay test QRs require server-side test keys (`PAYMENT_ENV=test`, `rzp_test_...`). See the [backend guide](backend/README.md#shared-basket-split-and-payment-boundary) for setup and live-checkout limitations.

## Checks

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

## Project guides

- [Backend setup, API contracts, configuration, data limits, and tests](backend/README.md)
- [Dataset and architecture workflow notes](architectural_workflow.md)
- [FoodLens architecture and workflow (PDF)](FoodLens%20Architecture%20and%20Workflow%20Documentation.pdf)

