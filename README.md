# vsms-connect-http-client

Zero-dependency **integration examples** and an **E2E test suite** for the VSMS Connect **generic HTTP connector** — the `/api/v1/businesses/:businessId/fiscalise` surface an external POS integrator talks to: `ApiKey` auth, normalized invoice ingestion, status polling, proforma trigger, refunds, copies, and cancellations.

The full wire contract and design live in [docs/SPEC.md](docs/SPEC.md).

## Quick start (integrators)

[`examples/`](examples/) has one runnable script per **V-SDC case**, numbered `01`–`14` for the canonical accreditation matrix, plus a few extras. Every script is self-standing (the refund/copy/proforma-refund ones create their own prerequisite sale inline) and shares a small [`examples/lib.mjs`](examples/lib.mjs) so each file focuses on its request body. Nothing to install (Node ≥ 20.6):

```bash
cp .env.example .env   # fill in the three values below

# The 14 canonical cases
node --env-file=.env examples/01-normal-sale.mjs
node --env-file=.env examples/02-normal-sale-with-buyer.mjs
node --env-file=.env examples/03-normal-refund.mjs
node --env-file=.env examples/04-normal-refund-with-buyer.mjs
node --env-file=.env examples/05-advance-sale.mjs
node --env-file=.env examples/06-advance-sale-with-buyer.mjs
node --env-file=.env examples/07-advance-refund.mjs
node --env-file=.env examples/08-advance-refund-with-buyer.mjs
node --env-file=.env examples/09-copy-sale.mjs
node --env-file=.env examples/10-copy-refund.mjs
node --env-file=.env examples/11-proforma-sale.mjs
node --env-file=.env examples/12-proforma-refund.mjs
node --env-file=.env examples/13-training-sale.mjs
node --env-file=.env examples/14-training-refund.mjs

# Extras
node --env-file=.env examples/16-sale-mixed.mjs              # multi-line, VAT15 + VAT0, split cash/card tender
node --env-file=.env examples/sale-to-location.mjs           # sale signed by a specific location's cert (needs VSMS_CONNECT_LOCATION_ID)
node --env-file=.env examples/15-cancel.mjs <fiscalInvoiceNumber>
node --env-file=.env examples/status-poll.mjs <invoiceId>    # poll a 202 (queued) invoice to terminal
```

Or use the shortcut `yarn case <number|name>` to run one case without typing the path:

```bash
yarn case 07               # → examples/07-advance-refund.mjs
yarn case mixed            # → examples/16-sale-mixed.mjs
yarn case --list           # list every case
```

Read `examples/01-normal-sale.mjs` and `examples/lib.mjs` first — together they are the smallest complete integration and document every wire gotcha (nested response envelope, BIGINT-string timestamps, server-side idempotency) in comments. See [examples/README.md](examples/README.md) for the full index.

## Configuration

| Variable                       | Value                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `VSMS_CONNECT_BACKEND_URL`     | Backend URL **up to and including** `/api/v1`, e.g. `http://localhost:3000/api/v1` |
| `VSMS_CONNECT_BUSINESS_ID`     | Business UUID from the app                                                         |
| `VSMS_CONNECT_API_KEY`         | API key with scope `http` (App → API Keys, plaintext shown once)                   |
| `VSMS_CONNECT_LOCATION_ID`     | Optional — a Location UUID for the business; enables the location example + test   |
| `VSMS_CONNECT_HTTP_TIMEOUT_MS` | Optional, tests only — client fetch timeout (default 60000)                        |

## Prerequisites for live testing

The client never registers businesses — like a real integrator, it is _handed_ credentials. One-time manual setup against a running backend stack (backend + consumer + db + Redis + SQL + V-SDC sandbox):

1. **Register a business** in the app (licence key → account → business → certificate upload).
2. **Create an API key** with scope `http` on the API Keys screen (plaintext shown once).
3. **Seed HTTP tax mappings** so `taxCode: "VAT15"` / `"VAT0"` resolve — or send a raw `taxLabel` to bypass mapping.
4. Copy `.env.example` → `.env` and fill the three values.

## Verification — the E2E suite

```bash
yarn install   # prettier only — the suite itself has zero dependencies
yarn test      # = node --env-file=.env --test "tests/*.test.mjs"
```

Runs the acceptance matrix against the live backend: health/auth probe, sales (plain, GTIN, zero-rated VAT0, split-tender, training), a refund chained off the sale, copies of both the sale and the refund, the proforma lifecycle (201 → trigger → convert), a per-request location sale (when `VSMS_CONNECT_LOCATION_ID` is set), cancellation, negative cases asserting stable validation codes (incl. `LOCATION_NOT_FOUND`), and the idempotency replay (identical re-POST returns the cached response + `Idempotency-Replayed: true`). Exits non-zero on any failure; filter with `node --env-file=.env --test --test-name-pattern refund "tests/*.test.mjs"`.

## Troubleshooting

| Response                                | Meaning                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| network error / timeout                 | Backend unreachable or slow — check `VSMS_CONNECT_BACKEND_URL`; raise the timeout if tunnelled |
| `401`                                   | API key wrong or revoked                                                                       |
| `403 USER_FORBIDDEN`                    | Key exists but has the wrong scope — it must be created with scope `http`                      |
| `404 INVOICE_NOT_FOUND`                 | Unknown invoiceId / fiscal number (on the health probe's zero-UUID GET this is the PASS)       |
| `409`                                   | Cancellation already in flight for that payment                                                |
| `422` + `validationErrors[]`            | Body rejected — messages carry stable `UPPER_SNAKE` codes (e.g. `LINE_SUM_MISMATCH`)           |
| `429`                                   | Rate-limited — honour `retryAfter`                                                             |
| `502 FISCAL_ERROR`                      | V-SDC rejected the document — poll the invoice status for details                              |
| `200` but `fiscalInvoiceNumber` is null | Still queued (or errored) — poll with `examples/status-poll.mjs`                               |

