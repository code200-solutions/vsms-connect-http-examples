# vsms-connect-http-client — Specification

Standalone Node.js + TypeScript CLI that tests the **VSMS Connect generic HTTP connector** the way a real external POS integrator would. This document is the single source of truth for the implementation.

The client is fully independent: **no imports from the VSMS Connect backend repo's workspaces.** All wire types are transcribed (copied) into this repo. The wire contract below was verified against the backend's HTTP connector source (`connectors/http/` — route, controller, and Zod request schema) on 2026-07-02; the open `taxCode` vocabulary and the `POST /tax-rates` declaration endpoint were verified on 2026-08-07 (TAXCORE-635 / TAXCORE-636).

## 1. Wire contract

### Endpoints

Base URL is configured _up to and including_ `/api/v1` (e.g. `http://localhost:3000/api/v1`).

| Method | Path                                                     | Purpose                                                                                                                                                                                      |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/businesses/:businessId/fiscalise?sync_timeout_ms=<ms>` | Ingest a normalized invoice. Sync-waits for fiscalisation up to `sync_timeout_ms` (default 10000, cap 30000).                                                                                |
| GET    | `/businesses/:businessId/fiscalise/:invoiceId`           | Poll invoice/payment status.                                                                                                                                                                 |
| POST   | `/businesses/:businessId/fiscalise/:invoiceId/trigger`   | Dispatch a previously-accepted PROFORMA to fiscalisation.                                                                                                                                    |
| POST   | `/businesses/:businessId/fiscalise/cancel`               | Submit a cancellation document. Target the payment by `{ "fiscalInvoiceNumber": "<sdc>" }` **or** by your own `{ "invoiceNumber", "transactionType"?, "externalPaymentId"? }` (TAXCORE-639). |
| POST   | `/businesses/:businessId/tax-rates`                      | Declare the caller's tax table so an admin can map each code to a V-SDC label before the first invoice. Body: `{ "taxRates": [{ "code", "name"?, "rate"? }] }`.                              |

### Authentication

- Header: `Authorization: ApiKey <raw-key>` — no JWT.
- The key must have scope **`http`** (created on the app's API Keys screen; plaintext shown once).
- `401` = bad/unknown key. `403` = key exists but has the wrong scope.
- Never log the API key (mask to the first 6 characters in verbose output).

### Idempotency

Server-synthesised from `invoiceNumber` + a body hash — the client must **not** send an `Idempotency-Key` header. A byte-identical re-POST within the cache window replays the cached response. A sale, its refund, and an advance-chain extension all deliberately **share one `invoiceNumber`** (the evolving-invoice model); the body hash keeps their cache keys distinct.

### Request body (POST /fiscalise)

Mirrors the backend's `NormalizedInvoice`-shaped wire schema:

- `invoiceNumber` — string, 1–60 chars. Printed on the receipt; dedup key.
- `invoiceType` — `'NORMAL' | 'COPY' | 'PROFORMA' | 'ADVANCE'`.
- `transactionType` — `'SALE' | 'REFUND'`.
- `training?` — boolean; forces TRAINING server-side. **Incompatible with COPY** (422).
- `cashierId` — **REQUIRED on every request** (trimmed, 1–50 chars). There is **no `externalId` field** on the wire.
- `locationId?` — optional uuid (multi-location). On a fresh SALE it selects which location's default certificate signs the invoice; it must belong to the business (else 422 `LOCATION_NOT_FOUND`) and **wins over the API key's location** (body-wins). Omit to use the API key's location, or the business default. **Forbidden on COPY** (a copy inherits its source's location → 422 `INVALID_COPY_BODY`) and **ignored on REFUND / advance-append** (those follow the source / existing invoice). A refund/copy is always signed by the same location certificate as the original — the client never sets `locationId` on those.
- Non-COPY additionally requires: `invoiceDate` (epoch ms or ISO-8601 string), `currencyCode` (3 chars, `'VUV'`), non-empty `lineItems[]`, non-empty `payments[]`, and `subtotalAmount` / `taxAmount` / `totalAmount`.
- `buyer?` — `{ tin? (≤20), name?, costCentreId? (≤50), email? }` — presence triggers the "with buyer" case; `email` gets a receipt copy emailed.
- Line item: `{ description (1–2048), quantity (≥0.001), unitPrice, taxRatePercent, lineSubtotal, lineTaxAmount, lineTotal, gtin? (8–14 chars), sortOrder?, itemAdditionalFields? }` plus **exactly one of** `taxCode` **or** `taxLabel`:
  - `taxCode` — a semantic code resolved to a V-SDC label via the business's tax mappings. **Open vocabulary**: any non-empty string ≤100 chars (`TAX_CODE_EMPTY` / `TAX_CODE_TOO_LONG` otherwise). There are **no pre-seeded codes** — a fresh business has an empty mapping table, so `VAT15` / `VAT0` are not special and every code (including those two) must be mapped before it can sign. Any code that is not yet mapped is still accepted on the wire but blocks the invoice with `MISSING_TAX_MAPPING` and surfaces in the admin's unmapped-tax-types panel for mapping (declare codes up front via `POST /tax-rates` to avoid the first-invoice block). Not restricted to a fixed set.
  - `taxLabel` — a raw V-SDC label (`'A'|'B'|'C'|'D'|'E'|'F'|'N'|'P'|'T'`), the escape hatch that bypasses mapping. This wire field is a single label (unchanged); the backend's internal line-item representation is a `taxLabels` array, but an HTTP line always resolves to at most one label.
- Payment: `{ amount, paymentType ('CASH'|'CARD'|'CHECK'|'WIRE_TRANSFER'|'VOUCHER'|'MOBILE_MONEY'|'OTHER'), paymentDate (epoch ms or ISO), externalPaymentId?, tenders?: [{ amount, paymentType }] }`.
- Reconciliation guards (all ±0.01, else 422 `LINE_SUM_MISMATCH` / `PAYMENT_SUM_MISMATCH` / `TENDER_SUM_MISMATCH`):
  - Σ`lineSubtotal` ≈ `subtotalAmount`; Σ`lineTaxAmount` ≈ `taxAmount`; Σ`lineTotal` ≈ `totalAmount`; Σ`payments[].amount` ≈ `totalAmount`; per payment Σ`tenders[].amount` ≈ `payment.amount`.
- **COPY**: names the source payment one of two ways (TAXCORE-639), and `lineItems`, `payments`, `buyer`, `invoiceDate`, `currencyCode`, the three totals, `referentDocumentNumber`/`referentDocumentDT`, and `locationId` are all **forbidden** (422 `INVALID_COPY_BODY`):
  - **`source: { referencedFiscalNumber (≤50), referencedFiscalTimestamp (ISO-8601 with offset) }`** — the SDC fiscal number of the document to copy. Explicit, authoritative, per-payment. No SDC number needed unless you want to pin one exactly.
  - **Omit `source`** and reuse the original invoice's `invoiceNumber` — the server resolves the source from that number's family (sale + linked refunds/copies), split by the COPY's own `transactionType`: **`SALE`** resolves the original sale, **`REFUND`** resolves the refund. So both a sale copy and a **refund copy** work with no SDC number. A multi-payment source (advance/split, or several partial refunds) is named by `sourceExternalPaymentId` (your own id); otherwise a single fiscalised match auto-resolves, and an ambiguous or unsigned source is a 422.
  - Supplying **both** `source` and `sourceExternalPaymentId` is rejected (`INVALID_COPY_BODY`).
- **REFUND**: the refund **reuses the original sale's `invoiceNumber`**, and that is how the server resolves the source invoice — you do **not** have to echo the sale's SDC fiscal number (TAXCORE-639). `referentDocumentNumber` (the source payment's SDC fiscal number, ≤50) is now **optional**; supply it only to pin one specific payment by its fiscal number. For a sale with several fiscalised payments (advance/deposit chain, split settlement) use `sourceExternalPaymentId` — the caller's own `externalPaymentId` from the sale — to say which payment is being refunded. With neither field, a sale that has exactly one fiscalised payment refunds that payment automatically; only a genuinely ambiguous source (several fiscalised payments, nothing to choose by) is rejected with `422`, naming the candidates by their `externalPaymentId`. `sourceExternalPaymentId` is distinct from `payments[].externalPaymentId`, which describes the refund's **own** tender rows. `referentDocumentDT` is optional ISO-8601 (server derives it when omitted).
- **PROFORMA → NORMAL conversion**: send a NORMAL SALE with `reference` = the proforma's `invoiceNumber`.
- `invoiceAdditionalFields?` / `paymentAdditionalFields?` — string records forwarded to V-SDC.

### Tax-rate declaration (POST /tax-rates)

The push-connector equivalent of the OAuth connectors' "list all tax rates" pull: VSMS Connect cannot enumerate a caller's tax rates, so the caller declares them and a business admin maps each code to a V-SDC label before the first invoice arrives.

- Auth: the same `Authorization: ApiKey <raw-key>` (scope `http`) the `/fiscalise` routes use. **Not** idempotency-keyed — a re-declaration inside the cache window must not be hidden.
- Body: `{ "taxRates": [{ "code", "name"?, "rate"? }] }`. `code` is a non-empty string ≤100 chars (`TAX_RATE_CODE_EMPTY` / `TAX_RATE_CODE_TOO_LONG`); `name` (≤500) and `rate` are both optional and nullable — send what you know.
- Behaviour per code (**nothing is ever auto-confirmed**; a caller can never change what its invoices are signed as):
  - **not yet mapped** → written as a proposal for admin confirmation; re-submitting refreshes its name/rate.
  - **confirmed, rate drifted** (|Δ| > 0.01 pts) → the mapping is deactivated for re-review, so its invoices block until the admin re-maps to a label matching the new rate.
  - **confirmed, name-only change** → a non-blocking metadata refresh.
  - **confirmed, unchanged** → untouched.
- Payload: `{ proposed: [{ code, name, rate }], driftDetected, nameRefreshed, alreadyMapped }`.

See `examples/21-declare-tax-rates.mjs`.

### Response envelope

Success: `{ status, error: false, message?, data: { object: 'object' | 'list', data: <payload>, hasMore, url, n? } }` — note the payload is nested one level inside a container (`object: 'list'` for array payloads, with `n`). The client's HTTP layer unwraps the container so commands work with the payload directly.
Error: `{ error: true, status, message, code, validationErrors?, retryAfter? }` — 422 carries `validationErrors[]` whose messages start with stable `UPPER_SNAKE:` prefixes.

### POST /fiscalise payload (`data`)

```ts
{
  invoiceId: string | null;
  invoiceNumber: string | null; // echo of the caller-supplied number
  paymentResults: Array<{
    invoicePaymentId: string;
    externalPaymentId: string | null;
    status: string; // 'fiscalised' | 'pending' | 'imported' | 'error' | ...
    fiscalInvoiceNumber: string | null;
    fiscalTimestamp: number | null; // EPOCH MILLISECONDS
    fiscalVerificationUrl: string | null;
    fiscalQrCode: string | null;
    fiscalSignedHash: string | null;
    fiscalJournal: string | null; // textual receipt — print verbatim, preserve newlines
    eligibleForFiscalisation: boolean | null; // null = not yet evaluated
    fiscalisationBlockReasons: string[]; // e.g. ['MISSING_TAX_MAPPING'] when blocked
  }>;
  jobId: string | null;
  statusUrl: string | null;
  triggerUrl: string | null;
}
```

`eligibleForFiscalisation` + `fiscalisationBlockReasons` (TAXCORE-645) make the post-import states machine-distinguishable without prose: `status: 'fiscalised'`/`'pending'`; imported **and** `eligibleForFiscalisation: true` → awaiting an admin's fiscalise action; **blocked** → `eligibleForFiscalisation: false` with the reason(s) (e.g. `['MISSING_TAX_MAPPING']`). `null` means eligibility has not been evaluated yet — distinct from an explicit `false`.

HTTP statuses: **200** fiscalised within the sync-wait window · **202** queued (poll `statusUrl`) · **201** imported but not auto-dispatched — **PROFORMA** returns a working `triggerUrl` (fiscalise it via `POST /fiscalise/:invoiceId/trigger`); **NORMAL/ADVANCE** with the connector's auto-fiscalise toggle **off** (or a blocked invoice) returns `triggerUrl: null` + a `statusUrl` to poll, because dispatch for those is an admin action in the app — there is no HTTP trigger for a non-quote (`/trigger` answers `422 INVOICE_NOT_QUOTE`) · **422** validation rejection · **502** `FISCAL_ERROR` (V-SDC rejected) · **401/403** auth/scope · **429** rate-limited (`retryAfter`).

The cancel payload additionally carries `cancellationPaymentId`; cancel returns 200 (terminal in-window) or 202 (poll), 404 no matching target, 409 cancellation already in flight, 422 ambiguous `invoiceNumber` target (fail-closed — pass `transactionType`/`externalPaymentId` or a `fiscalInvoiceNumber`).

### ⚠ Timestamp conversion rule

`fiscalTimestamp` in responses is **epoch milliseconds**. When echoing it back into `referentDocumentDT` or `source.referencedFiscalTimestamp`, the client must convert it to an **ISO-8601 string with offset** (e.g. `2026-07-01T09:00:00+11:00` or `...Z`). Sending epoch-ms strings there is rejected.

## 2. Client design

Two plain-Node surfaces, no framework:

1. **`examples/`** — the integrator-facing reference. Standalone `.mjs` scripts, native `fetch`, full request body inline, zero dependencies and **no shared imports** — each file is deliberately copy-pasteable in isolation (and trivially translatable to PHP/C#/Python).
2. **`tests/`** — the verification suite. Node's built-in test runner (`node --test` + `node:assert`), carrying the case matrix as named, assertable tests that chain state sequentially within one file.

### Stack

Node ≥ 20.6 (`--env-file`, native `fetch`, `node:test`). Plain JavaScript — no TypeScript, no build. `prettier` is the only dev dependency. **No client-side validation library** — the server's validation is the thing under test, so tests must be able to send deliberately-invalid payloads.

### Configuration

`.env` (gitignored; `.env.example` committed with plainly-labelled placeholders — never password-shaped values), loaded via `node --env-file=.env`:

- `VSMS_CONNECT_BACKEND_URL` — up to and including `/api/v1`.
- `VSMS_CONNECT_BUSINESS_ID` — business UUID.
- `VSMS_CONNECT_API_KEY` — the `http`-scoped key.
- `VSMS_CONNECT_LOCATION_ID` — optional; a Location UUID belonging to the business. When set, the suite's "sale to a specific location" test runs (else it's skipped); `examples/17-sale-to-location.mjs` reads it too.
- `VSMS_CONNECT_HTTP_TIMEOUT_MS` — optional, tests only; client-side fetch timeout (default 60000). Independent of the server's sync-wait window — slow stacks (tunnelled backends, remote DBs) can take far longer to ingest than the sync window suggests, so the client budget must never be derived from `sync_timeout_ms`. Examples hardcode a 60 s `AbortSignal.timeout`.

Missing values fail fast with a one-line hint.

### File layout

```
examples/
  lib.mjs                  # shared: config, the fetch call, polling, receipt printing, vatLine/totalsOf builders
  run.mjs                  # `yarn case <n|name>` dispatcher
  01-normal-sale.mjs …     # one script per canonical V-SDC case, numbered 01–14 (see below)
  14-training-refund.mjs
  15-cancel.mjs            # extra: makes a sale, cancels it by invoiceNumber (counter-document)
  16-sale-mixed.mjs        # extra: multi-line, VAT15 + VAT0, split cash/card tender
  17-sale-to-location.mjs     # extra: sale signed by a specific location's cert (needs VSMS_CONNECT_LOCATION_ID)
  status-poll.mjs          # extra, argv: <invoiceId> — poll until all payment results terminal
  README.md                # quick start + case index
tests/
  helpers.mjs              # config, request/fiscalise/getStatus/trigger/cancel, pollUntilTerminal,
                           # ensureFiscalised, makeInvoice factory with auto-reconciled totals, makeCopy
  e2e.test.mjs             # the acceptance suite (below)
```

The 14 numbered example scripts map one-to-one to the canonical cases: `01` Normal Sale, `02` Normal Sale with buyer, `03` Normal Refund, `04` Normal Refund with buyer, `05` Advance Sale, `06` Advance Sale with buyer, `07` Advance Refund, `08` Advance Refund with buyer, `09` Copy Sale, `10` Copy Refund, `11` Proforma Sale, `12` Proforma Refund, `13` Training Sale, `14` Training Refund. Each is self-standing — the refund/copy/proforma-refund scripts create their own prerequisite sale inline, so any file runs on its own. They share `examples/lib.mjs` (config + the plain-`fetch` call + polling + receipt printing + `vatLine`/`totalsOf` builders) so each file's content is just the request body and flow. The suite (`tests/`) is the assertable mirror of the same matrix.

### E2E suite (`yarn test` = `node --env-file=.env --test "tests/*.test.mjs"`)

Sequential named tests, in three groups after the health + auth probe (a 404 on a zero-UUID GET proves connectivity, key, and scope — 401/403 would stop earlier):

- **Group 1 — the 14 canonical V-SDC cases**, named `01.`–`14.` to match the accreditation matrix: Normal Sale, Normal Sale with buyer, Normal Refund, Normal Refund with buyer, Advance Sale (deposit chain), Advance Sale with buyer, Advance Refund (one deposit), Advance Refund with buyer, Copy Sale, Copy Refund, Proforma Sale (quote → trigger → fiscalised), Proforma Refund, Training Sale, Training Refund. Refunds reuse the source sale's invoice number and reference its fiscal number (`referentDocumentDT` omitted — the server derives it); copies send the minimal `source`-only body; advance sales POST one invoice with three deposit payments and the refund targets the first deposit with a scaled self-contained body.
- **Group 2 — extra wire coverage**: GTIN barcodes, zero-rated VAT0, split tender, proforma → NORMAL conversion via `reference`, cancellation (counter-document), and a per-request `locationId` sale (multi-location) — the last is skipped unless `VSMS_CONNECT_LOCATION_ID` is set.
- **Group 3 — negatives + idempotency**: stable-code assertions (`LINE_SUM_MISMATCH`, missing cashierId, `GTIN_INVALID_LENGTH`, `INVOICE_NOT_FOUND` for a REFUND whose `invoiceNumber` matches no prior sale, `INVALID_COPY_BODY`, and `LOCATION_NOT_FOUND` for a body `locationId` outside the business) and the idempotency replay (byte-identical re-POST → same invoiceId + `Idempotency-Replayed: true` header).

Non-zero exit on any failure; filter with `node --env-file=.env --test --test-name-pattern "Advance" "tests/*.test.mjs"`. Because every fiscalisation is a real round-trip, a full run takes several minutes against a tunnelled backend.

The `makeInvoice(opts)` factory in `tests/helpers.mjs` produces valid bodies with auto-reconciled totals (unitPrice 1000, VAT15 by default) and variants for buyer / buyerEmail / training / gtin (one EAN-13 + one EAN-8) / splitTender / advanceDeposits (N-payment chain) / taxCode VAT0 / taxLabel / invoiceType / transactionType / reference / referentDocumentNumber / locationId / unitPrice / quantity. `makeCopy(...)` builds the minimal COPY body.

### Case coverage

The automated suite covers all 14 canonical cases. The backend repo's smoke collection `docs/http-connector-refactor/test-requests.http` (groups 1–11) remains the manual cross-reference and additionally exercises the full three-deposit advance unwind (three separate refunds) and the wrong-scope 403 path.

## 3. Prerequisites for live testing

The client never registers businesses — like a real integrator it is _handed_ credentials. One-time manual setup against a running backend stack (backend + consumer + db + Redis + SQL + V-SDC sandbox):

1. Register a business in the app (licence key → account → business → certificate upload).
2. Create an API key with scope `http` on the API Keys screen.
3. Map the tax codes your invoices will use to V-SDC labels. **Nothing is pre-seeded** — a fresh business has an empty mapping table, so even `VAT15` / `VAT0` must be mapped before an invoice carrying them can sign (a brand-new HTTP business cannot fiscalise until an admin maps at least one code). Either declare your table up front via `POST /businesses/:id/tax-rates` (see `examples/21-declare-tax-rates.mjs`) or just send an invoice with a code (it surfaces automatically as a proposal, blocking that first invoice with `MISSING_TAX_MAPPING` until mapped), then have an admin confirm each mapping on the HTTP integration screen. A raw `taxLabel` bypasses mapping entirely.
4. Copy `.env.example` → `.env` and fill the three values.

## 4. Verification checklist

1. `node --env-file=.env examples/01-normal-sale.mjs` (or `yarn case 1`) → 200 with the fiscal number, verification URL, and receipt journal; corrupted key → 401 rendered cleanly; wrong-scope key → 403 `USER_FORBIDDEN`.
2. `yarn case 03-normal-refund` → 200; the script makes its own sale inline, then refunds it (reusing the sale's invoice number). The numbered refund/copy/proforma scripts are all self-standing — no argv needed.
3. `yarn case 09` (copy sale), `yarn case 15` (cancel — makes + cancels its own sale), `yarn case 11` (proforma → trigger → fiscalised) → each completes with its own fiscal number.
4. `node --env-file=.env examples/17-sale-to-location.mjs` (needs `VSMS_CONNECT_LOCATION_ID`) → 200 signed by that location's cert.
5. `yarn test` → full suite green (sales incl. GTIN/VAT0/split-tender/training, refund, copies, proforma lifecycle, cancel, location, negatives incl. `LOCATION_NOT_FOUND`, idempotency replay with the `Idempotency-Replayed: true` header); non-zero exit when any step fails.
6. `yarn format` leaves no diff.
