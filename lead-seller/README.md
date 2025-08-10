# Lead Seller (Pay-per-Lead)

A minimal full-stack app to sell leads at $60 each using Stripe metered billing. Buyers subscribe once, you record usage when a lead is delivered, and Stripe invoices them monthly.

## Features
- Landing page and buyer signup
- Stripe Checkout for subscription start
- Metered billing ($60/lead) via Stripe Usage Records
- Simple buyer dashboard with monthly lead count and API key
- Lead intake API to record leads and bill usage
- SQLite storage (file-based) via better-sqlite3

## Prerequisites
- Node.js 18+
- A Stripe account

## Setup
1. Clone or open this folder
2. Install dependencies:
   ```bash
   cd /workspace/lead-seller
   npm install
   ```
3. Copy `.env.example` to `.env` and fill values:
   - `APP_URL` (e.g. `http://localhost:3000`)
   - `STRIPE_SECRET_KEY` (from Stripe dashboard)
   - `STRIPE_METERED_PRICE_ID` (see next step)
   - Optionally `STRIPE_WEBHOOK_SECRET`
4. Create a metered Price in Stripe for $60/unit:
   - Create a Product, Pricing model: Metered billing, Price: $60, Billing period: Monthly
   - Copy the Price ID (e.g. `price_...`) into `STRIPE_METERED_PRICE_ID`
5. Run the app:
   ```bash
   npm start
   ```
6. Visit `http://localhost:3000`

## How it works
- Buyers go to `/buyers/signup` and complete a Stripe Checkout session for a subscription to your metered price
- After success, we create a buyer record and show an API key
- Every time you deliver a lead (via `/api/leads`), we record a usage unit on the buyer's subscription item
- Stripe aggregates usage during the billing period and invoices the buyer at month end ($60 per unit)

## Endpoints
- `GET /` – Landing
- `GET /buyers/signup` – Signup form
- `POST /buyers/signup` – Creates Stripe Checkout session
- `GET /buyers/thanks?session_id=...` – Post-checkout handler, shows API key
- `GET /buyers/dashboard?key=API_KEY` – Buyer dashboard
- `POST /api/leads` – Lead intake endpoint
  - Headers: `x-api-key: API_KEY`
  - Body JSON: `{ name?, email?, phone?, meta? }`

Example:
```bash
curl -X POST $APP_URL/api/leads \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "name": "Jane Prospect",
    "email": "jane@example.com",
    "phone": "+1-555-555-5555",
    "meta": { "source": "Landing page", "vertical": "Roofing" }
  }'
```

## Notes
- Only metered usage for accepted leads should be recorded. Build any rejection logic before calling Stripe usage.
- Webhooks are optional for this MVP; Stripe handles invoicing automatically for metered billing.
- If you need to credit or remove leads, you can create negative adjustments via the Stripe Dashboard or API.