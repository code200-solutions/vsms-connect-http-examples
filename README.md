# vsms-connect-http-examples

Runnable **integration examples** and an **E2E test suite** for the VSMS Connect **generic HTTP connector** — the API an external POS or ERP calls to fiscalise invoices in Vanuatu. Zero dependencies, plain `fetch`, Node ≥ 20.6.

The full wire contract is in [docs/SPEC.md](docs/SPEC.md); a printable reference is [docs/http-connector-api.pdf](docs/http-connector-api.pdf).

---

## Getting started

Six steps, in order. Nothing signs until all six are done — steps 3 and 4 in particular are not optional: a brand-new business has **no** tax codes and **no** store codes, so an invoice sent before they are mapped is stored and blocked rather than fiscalised.

### 1. Register the business

In the app: licence key → account → business → **upload a certificate**. The certificate is what signs; a business without one blocks every invoice with `LOCATION_CERTIFICATE_MISSING`.

You do not do this step — a real integrator is _handed_ credentials by the merchant. It is listed because nothing below works until it has happened.

### 2. Create an API key for the HTTP connector

App → **API Keys** → new key with scope **`http`**. The plaintext is shown **once** — copy it then.

That key is the whole authentication story: `Authorization: ApiKey <key>`, no JWT, no OAuth. A key with the wrong scope answers `403 USER_FORBIDDEN`; an unknown or revoked one answers `401`.

### 3. Declare your tax codes and store codes

VSMS Connect cannot pull anything out of your system — it is a push connector, so _you_ send your vocabulary and an admin maps it. Two declarations, same shape, same rules:

```bash
yarn case 21   # examples/21-declare-tax-rates.mjs  → POST /businesses/:businessId/tax-rates
yarn case 17   # examples/17-multi-location.mjs     → POST /businesses/:businessId/stores
```

```http
POST /api/v1/businesses/:businessId/tax-rates
Authorization: ApiKey <key>

{ "taxRates": [{ "code": "VAT15", "name": "VAT", "rate": 15 },
               { "code": "VAT0",  "name": "Zero-rated", "rate": 0 }] }
```

```http
POST /api/v1/businesses/:businessId/stores
Authorization: ApiKey <key>

{ "stores": [{ "storeCode": "STORE-PV-01", "name": "Port Vila" }] }
```

`VAT15` and `VAT0` are **not special** — there are no pre-seeded codes and no "Initialize" shortcut. They are simply the codes these examples use. Send whatever codes your system already has; any non-empty string up to 100 characters is accepted.

Everything you declare lands as a **proposal**. Nothing is ever auto-confirmed, and re-declaring never overwrites what an admin decided — a caller can never change what its own invoices are signed as.

### 4. Have an admin map them

In the app, on the **Generic HTTP** integration screen:

- **Tax mappings tab** — map each declared code to a V-SDC tax label.
- **Stores tab** — map each declared store code to one of the business's locations. That location's certificate is what signs sales from that store.

Read back what the store codes now resolve to with `GET /businesses/:businessId/stores` (`yarn case 17` does this too) — each returns `mapped`, `proposed` or `rejected`.

Until a code is mapped, an invoice carrying it comes back **accepted and blocked** — a `201` with `fiscalisationBlockReasons: ["MISSING_TAX_MAPPING"]` or `["LOCATION_NOT_MAPPED"]` — never rejected, and never quietly signed under the wrong certificate. Once the admin maps it, their **Re-sync blocked invoices** button releases the stored invoices in place. You do not re-send them.

### 5. Point the examples at the business

```bash
cp .env.example .env
```

Fill in the three values from steps 1–2 (see [Configuration](#configuration)). There is deliberately **no** location variable: every sale here carries `storeCode: "STORE-PV-01"` as a literal in the request body, because that is what a real integrator sends.

### 6. Send your first invoice

```bash
yarn case 1        # examples/01-normal-sale.mjs
```

A `200` with a fiscal number, verification URL and printable receipt means all six steps are done. A `201` means the invoice was stored but not signed — read `fiscalisationBlockReasons` and go back to step 4.

Then work through the rest: **[examples/README.md](examples/README.md)** is the full index — the 14 canonical V-SDC cases (sale, refund, advance, copy, proforma, training), plus refund parity, multi-tax lines, idempotency, cancellation and retrieval.

---

## Two VAT accounting bases

A merchant accounts for VAT one of two ways, and it changes what several of these calls do.

|                                  | **Cash basis** — [`examples/`](examples/)                      | **Invoice basis** — [`examples/invoice-basis/`](examples/invoice-basis/)  |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Tax is declared                  | when the money arrives                                         | when the invoice is **issued**                                            |
| Fresh SALE                       | one fiscal document per `payments[]` entry, your `paymentType` | **one** document for the whole `totalAmount`, `paymentType: OTHER`        |
| `payments` on a SALE             | required                                                       | **optional** — omit it for an unpaid credit sale                          |
| `invoiceType: ADVANCE`           | a deposit chain, one document per deposit                      | **rewritten to NORMAL** — no chain                                        |
| Re-POST the same `invoiceNumber` | appends a settlement payment; totals **locked**                | totals are the payload — the **difference** is declared as a new document |
| Refund source                    | named by `sourceExternalPaymentId` when ambiguous              | the single at-issue document; `sourceExternalPaymentId` **cannot** work   |

Cash basis is the default and is what the six steps above describe. The basis is fixed when the business is **registered**, is not editable afterwards, and is **not a field on any request** — and no endpoint reports it, so if you are integrating against a merchant, ask them.

Everything else — auth, validation, mapping, block reasons, idempotency, COPY, PROFORMA, TRAINING — is identical on both. [`examples/invoice-basis/README.md`](examples/invoice-basis/README.md) covers only the differences, and needs a second business (steps 1–4 again, on invoice basis) plus `VSMS_CONNECT_IB_*`.

## Configuration

| Variable                       | Value                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VSMS_CONNECT_BACKEND_URL`     | Backend URL **up to and including** `/api/v1`, e.g. `http://localhost:3000/api/v1`                                                                  |
| `VSMS_CONNECT_BUSINESS_ID`     | Business UUID from the app                                                                                                                          |
| `VSMS_CONNECT_API_KEY`         | API key with scope `http` (App → API Keys, plaintext shown once)                                                                                    |
| `VSMS_CONNECT_IB_BUSINESS_ID`  | Optional — a **second** business registered on **invoice** basis; used only by `examples/invoice-basis/`. Falls back to `VSMS_CONNECT_BUSINESS_ID`. |
| `VSMS_CONNECT_IB_API_KEY`      | Optional — that business's own scope-`http` key. Falls back to `VSMS_CONNECT_API_KEY`.                                                              |
| `VSMS_CONNECT_HTTP_TIMEOUT_MS` | Optional, tests only — client fetch timeout (default 60000)                                                                                         |

## Running the examples

```bash
yarn case 1              # → examples/01-normal-sale.mjs
yarn case 07             # → examples/07-advance-refund.mjs
yarn case mixed          # → examples/16-sale-mixed.mjs  (name substring)
yarn case ib-04          # → examples/invoice-basis/ib-04-edit.mjs
yarn case --list         # every case
```

A bare number always means the cash-basis set; the invoice-basis scripts are selected by name (`ib-01` … `ib-04`). Any script can also be run directly — `node --env-file=.env examples/01-normal-sale.mjs` — from the repo root, since `--env-file` resolves from the working directory.

Read [`examples/01-normal-sale.mjs`](examples/01-normal-sale.mjs) and [`examples/lib.mjs`](examples/lib.mjs) first: together they are the smallest complete integration, and they document every wire gotcha (the nested response envelope, BIGINT-string timestamps, server-side idempotency) in comments.

## Verification — the E2E suite

```bash
yarn install   # prettier only — the suite itself has zero dependencies
yarn test      # = node --env-file=.env --test "tests/*.test.mjs"
```

Runs the acceptance matrix against the live backend: health/auth probe, sales (plain, GTIN, zero-rated, split-tender, training), a refund chained off the sale, copies of both, the proforma lifecycle, an unmapped store code blocking rather than signing elsewhere, cancellation, negative cases asserting stable validation codes, and the idempotency replay. Exits non-zero on any failure; filter with `node --env-file=.env --test --test-name-pattern refund "tests/*.test.mjs"`.

## Troubleshooting

| Response                                                                                                 | Meaning                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| network error / timeout                                                                                  | Backend unreachable or slow — check `VSMS_CONNECT_BACKEND_URL`; raise the timeout if tunnelled                                                                                                                     |
| `401`                                                                                                    | API key wrong or revoked (step 2)                                                                                                                                                                                  |
| `403 USER_FORBIDDEN`                                                                                     | Key exists but has the wrong scope — it must be created with scope `http` (step 2)                                                                                                                                 |
| `404 INVOICE_NOT_FOUND`                                                                                  | Unknown invoiceId / fiscal number (on the health probe's zero-UUID GET this is the PASS)                                                                                                                           |
| `409`                                                                                                    | `INVOICE_DUPLICATE` — a SALE reused an existing `invoiceNumber` (a new sale can't); or a cancellation is already in flight for that payment                                                                        |
| `422` + `validationErrors[]`                                                                             | Body rejected — messages carry stable `UPPER_SNAKE` codes (e.g. `LINE_SUM_MISMATCH`)                                                                                                                               |
| `429`                                                                                                    | Rate-limited — honour `retryAfter`                                                                                                                                                                                 |
| `502 FISCAL_ERROR`                                                                                       | V-SDC rejected the document — poll the invoice status for details                                                                                                                                                  |
| `201` + `fiscalisationBlockReasons: ["MISSING_TAX_MAPPING"]`                                             | **Step 3/4 not done for that code.** Declare it (`yarn case 21`) and have an admin map it, then re-sync. The invoice is stored, not lost — do not re-send it. `yarn case 22` demonstrates this state deliberately. |
| `201` + `fiscalisationBlockReasons: ["LOCATION_NOT_MAPPED"]`                                             | **Step 3/4 not done for that store code.** Declare it (`yarn case 17`) and map it on the Stores tab, then re-sync.                                                                                                 |
| `201` + `fiscalisationBlockReasons: ["LOCATION_CERTIFICATE_MISSING"]`                                    | The store is mapped, but its location holds no active certificate — step 1.                                                                                                                                        |
| `201` + `status: imported`, `eligibleForFiscalisation: true`                                             | Accepted but not auto-dispatched — auto-fiscalise is off for this connector (or it's a PROFORMA). Turn auto-fiscalise on, or fiscalise from the app.                                                               |
| `200` but `fiscalInvoiceNumber` is null                                                                  | Still queued (or errored) — poll with `examples/status-poll.mjs`                                                                                                                                                   |
| `422` + `payments: payments must be a non-empty array`, on a SALE you deliberately sent without payments | The business is on **cash basis**. A payment-free sale is valid only on invoice basis.                                                                                                                             |
| `422 INVOICE_FIELD_MISMATCH` on a re-POST                                                                | Cash basis: an invoice's totals are locked once created, so a re-POST may only add a payment. On **invoice** basis a changed total is legal and declares an adjustment — `yarn case ib-04`.                        |
| `201` + an `invoiceId` you have not seen before, carrying one `paymentResults[]` entry                   | Invoice basis: your re-POST changed the total, so this is the **new** document declaring the difference (a chained sale, or a partial refund). Keep that id — there is no lookup by `invoiceNumber`.               |
| `201` + `paymentResults: []` on a re-POST                                                                | Invoice basis: nothing changed, so nothing was declared. Expected when you re-push on settlement.                                                                                                                  |
