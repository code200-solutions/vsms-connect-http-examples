# vsms-connect-http-client — Specification

Standalone Node.js + TypeScript CLI that tests the **VSMS Connect generic HTTP connector** the way a real external POS integrator would. This document is the single source of truth for the implementation.

The client is fully independent: **no imports from the VSMS Connect backend repo's workspaces.** All wire types are transcribed (copied) into this repo. The wire contract below was verified against the backend's HTTP connector source (`connectors/http/` — route, controller, and Zod request schema) on 2026-07-02; the open `taxCode` vocabulary and the `POST /tax-rates` declaration endpoint were verified on 2026-08-07 (TAXCORE-635 / TAXCORE-636); the `POST` / `GET /stores` store-code surface and the `storeCode` body field on 2026-08-18 (TAXCORE-708 / TAXCORE-718 — the surface moved off `/locations`, which the admin Locations CRUD already owns).

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
| POST   | `/businesses/:businessId/stores`                         | Declare the caller's own store codes so an admin can map each one to a business location (TAXCORE-708 / 718). Body: `{ "stores": [{ "storeCode", "name"?, "street"?, "city"? }] }`.          |
| GET    | `/businesses/:businessId/stores`                         | Read back what those store codes currently resolve to.                                                                                                                                       |

### Authentication

- Header: `Authorization: ApiKey <raw-key>` — no JWT.
- The key must have scope **`http`** (created on the app's API Keys screen; plaintext shown once).
- `401` = bad/unknown key. `403` = key exists but has the wrong scope.
- Never log the API key (mask to the first 6 characters in verbose output).

### Idempotency

Server-synthesised from `invoiceNumber` + a body hash — the client must **not** send an `Idempotency-Key` header. A byte-identical re-POST within the cache window replays the cached response. A sale and its refund deliberately **share one `invoiceNumber`** — a REFUND reuses its sale's number to link to it; the body hash keeps their cache keys distinct. A fresh SALE, by contrast, must use an unused number: re-POSTing a SALE under a number that already identifies an invoice returns **`409 INVOICE_DUPLICATE`** (only a byte-identical retry replays instead of erroring).

### Request body (POST /fiscalise)

Mirrors the backend's `NormalizedInvoice`-shaped wire schema:

- `invoiceNumber` — string, 1–60 chars. Printed on the receipt; dedup key.
- `invoiceType` — `'NORMAL' | 'COPY' | 'PROFORMA' | 'ADVANCE'`.
- `transactionType` — `'SALE' | 'REFUND'`.
- `training?` — boolean; forces TRAINING server-side. **Incompatible with COPY** (422).
- `cashierId` — **REQUIRED on every request** (trimmed, 1–50 chars). There is **no `externalId` field** on the wire.
- `storeCode?` / `locationId?` — the two spellings of the per-request location selector, **exactly one of the two** (sending both → 422 `LOCATION_SELECTOR_EXCLUSIVE`). Sending **neither** is the zero-config path a single-location business uses, and resolves as it always has (API key's location → business default). Both are **forbidden on COPY** (a copy inherits its source's location → 422 `INVALID_COPY_BODY`) and **ignored on REFUND** (a refund follows its source invoice), so the client never sets either on those.
  - `storeCode` — **the caller's own store code** (trimmed, 1–100 chars; `STORE_CODE_TOO_LONG` otherwise), resolved through the codes declared at `POST /stores`. This is the field an integrator should use: it means never holding a VSMS Connect GUID. Only a code an admin has **mapped to a business location** routes, and routing **fails closed** — an unmapped or unknown code blocks the invoice with `HTTP_STORE_NOT_MAPPED` rather than signing it at the API key's location, and a mapped location holding no certificate blocks with `HTTP_STORE_LOCATION_NO_CERTIFICATE`. An **unknown** code is still raised as a proposal, never a rejection (see below). The mapping is the admin's, made on the app's Stores tab — your code is source metadata, and the certificate belongs to one of THEIR locations.
  - `locationId` — the internal Location uuid, kept as the escape hatch for callers that already store it. On a fresh SALE it picks which location's default certificate signs the invoice; it must belong to the business (else 422 `LOCATION_NOT_FOUND`) and **wins over the API key's location** (body-wins).
- Non-COPY additionally requires: `invoiceDate` (epoch ms or ISO-8601 string), `currencyCode` (3 chars, `'VUV'`), non-empty `lineItems[]`, non-empty `payments[]`, and `subtotalAmount` / `taxAmount` / `totalAmount`.
- `buyer?` — `{ tin? (≤20), name?, costCentreId? (≤50), email? }` — presence triggers the "with buyer" case; `email` gets a receipt copy emailed.
- Line item: `{ description (1–2048), quantity (≥0.001), unitPrice, taxRatePercent, lineSubtotal, lineTaxAmount, lineTotal, gtin? (8–14 chars), sortOrder?, itemAdditionalFields? }` plus **exactly one of** `taxCode` **or** `taxLabel` (sending both → 422 `TAX_CODE_AND_LABEL_EXCLUSIVE`). **Either field takes one value OR an array**, for an item bearing several taxes:
  - `taxCode` — a semantic code resolved to a V-SDC label via the business's tax mappings. **Open vocabulary**: any non-empty string ≤100 chars (`TAX_CODE_EMPTY` / `TAX_CODE_TOO_LONG` otherwise). There are **no pre-seeded codes** — a fresh business has an empty mapping table, so `VAT15` / `VAT0` are not special and every code (including those two) must be mapped before it can sign. Any code that is not yet mapped is still accepted on the wire but blocks the invoice with `MISSING_TAX_MAPPING` and surfaces in the admin's unmapped-tax-types panel for mapping (declare codes up front via `POST /tax-rates` to avoid the first-invoice block). Not restricted to a fixed set.
  - `taxLabel` — a raw V-SDC label, the escape hatch that bypasses mapping. **Validated on shape, not vocabulary** (1–10 uppercase letters/digits, else `TAX_LABEL_INVALID`): the label set is published by the authority as a versioned tax group and can gain entries on a date nobody here controls, so an enum of today's labels would reject a newly-issued one and break every integration on the day of a tax revision. An unrecognised-but-well-formed label is accepted here and adjudicated by V-SDC at signing.
  - **The array form** — `taxCode: ["VAT15", "ECAL"]` (or `taxLabel: ["A", "D"]`) for an item bearing more than one tax. A label identifies one rate inside one tax category and an item may carry at most one label per category, so VAT + a levy is two labels on ONE line, not two lines. Deliberately the SAME field rather than a `taxCodes` plural: `"VAT15"` and `["VAT15"]` are equivalent, so pre-existing callers are unaffected and there is no wrong key to reach for. Non-empty (`TAX_CODES_EMPTY`), no duplicates (`TAX_CODES_DUPLICATE`), and **no maximum** — the authority decides how many categories exist, so any cap of ours could only ever reject a legitimate future payload.
  - **Partial resolution is a block, never a partial sign.** If any one code in the array has no mapping, the line resolves to NO labels and the invoice blocks with `MISSING_TAX_MAPPING`; every unmapped code is reported, not just the first. Signing with the mapped subset would produce a receipt that looks successful and under-reports tax.
  - **V-SDC computes every tax amount** from the labels + item total. It has to: a tax-on-total category charges its rate on the item total _including_ the other taxes on that line, and an amount-per-quantity category is a fixed sum per unit with the rest computed on the remainder — so an amount is only correct when all of a line's labels are resolved together. The `taxRatePercent` and per-line tax amounts you send are reconciliation/display only and never override the SDC.
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

### Location declaration (POST /stores, GET /stores)

The same shape as the tax-rate declaration, solving the same problem for stores (TAXCORE-708): a push connector cannot enumerate a caller's branches, so the caller declares its own store codes and an admin maps each one to a business location. Before this existed, `/fiscalise` accepted a location only as VSMS Connect's **own** `locationId` GUID — handed over out of band, stored by the integrator against every one of its stores.

- Auth: the same `Authorization: ApiKey <raw-key>` (scope `http`). **Not** idempotency-keyed.
- **POST** body: `{ "stores": [{ "storeCode", "name"?, "street"?, "city"? }] }`. `storeCode` is a non-empty string ≤100 chars (`STORE_CODE_EMPTY` / `STORE_CODE_TOO_LONG`); `name` (≤255), `street` (≤255) and `city` (≤255) are optional and nullable, and exist so the reviewing admin can recognise the store. Omit `name` and the code itself is stored as the label.
- POST payload: `{ declared, proposed: string[], alreadyKnown: string[] }` — `proposed` lists the codes newly created as proposals, `alreadyKnown` the ones we already held.
- **GET** payload: `{ stores: [{ storeCode, name, status, locationId }] }`, `status` ∈ `'mapped' | 'proposed' | 'rejected'`. Only **HTTP-sourced** rows are listed — a location an admin created by hand has no store code of yours, so it is not addressable through this surface and listing it would only invite sending GUIDs again. `locationId` is included deliberately: a caller that already stores it keeps working, and a caller that doesn't never has to learn it.
- Behaviour (**nothing is ever auto-mapped**; a caller can never decide which certificate signs its invoices):
  - **unknown code** → written as a **proposal** for an admin to map on the app's Stores tab.
  - **re-declared code** → a no-op. The declaration NEVER overwrites an existing row, so an admin's edits always win. There is deliberately **no drift handling** (unlike a tax rate): a renamed store is cosmetic, whereas a drifted tax rate would change what an invoice is signed as.
  - **mapped code** → invoices carrying it in `storeCode` sign at the certificate of the business location the admin mapped it to.
  - **rejected code** → resolves to nothing, and is **not re-proposed** on later invoices — the admin's rejection sticks.
- **An unknown `storeCode` on a fiscalise call is a proposal, never a rejection — and the invoice is blocked, not signed elsewhere.** Two separate guarantees, easy to conflate:

  - _Not rejected._ For a push connector an incoming invoice is the only discovery event there is, so a 4xx would make the code undiscoverable _and_ lose a real sale over a configuration gap. The invoice is accepted, stored, and the code appears in the admin's review queue.
  - _Not signed._ Routing **fails closed**: a `storeCode` with no admin mapping blocks the invoice with `HTTP_STORE_NOT_MAPPED` rather than quietly signing it at the API key's location. Signing a sale under a certificate it does not belong to, while reporting success, is the failure this prevents.

  So `storeCode` behaves exactly like `taxCode`: accepted on the wire, surfaced for review, blocking until resolved. Handle both the same way — read `fiscalisationBlockReasons`, never assume a fiscal number.

See `examples/17-multi-location.mjs`.

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

The reasons you can expect to see from this connector, and who clears each:

| Reason                               | Meaning                                                    | Cleared by                                               |
| ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| `MISSING_TAX_MAPPING`                | a line's `taxCode` has no confirmed V-SDC label yet        | admin maps the code, then re-syncs                       |
| `HTTP_STORE_NOT_MAPPED`              | the `storeCode` is not mapped to a location                | admin maps the store, then re-syncs                      |
| `HTTP_STORE_LOCATION_NO_CERTIFICATE` | the store is mapped but that location holds no certificate | admin uploads a certificate for it, then re-syncs        |
| `REFERENT_NOT_FISCALISED`            | a refund whose source sale has not signed yet              | resolves itself once the source signs — no action needed |

**The array can carry several at once** — a first invoice from a fresh integration commonly returns `['MISSING_TAX_MAPPING', 'HTTP_STORE_NOT_MAPPED']`, because both are true and both need fixing. Branch on membership (`reasons.includes(...)`), never on `reasons[0]`.

None of these lose the invoice: it is stored under the `invoiceId` you were given, and the admin's re-sync signs it in place. You do **not** re-send it — re-sending the same `invoiceNumber` is an append or a duplicate, not a retry.

HTTP statuses: **200** fiscalised within the sync-wait window · **202** queued (poll `statusUrl`) · **201** imported but not auto-dispatched — **PROFORMA** returns a working `triggerUrl` (fiscalise it via `POST /fiscalise/:invoiceId/trigger`); **NORMAL/ADVANCE** with the connector's auto-fiscalise toggle **off** (or a blocked invoice) returns `triggerUrl: null` + a `statusUrl` to poll, because dispatch for those is an admin action in the app — there is no HTTP trigger for a non-quote (`/trigger` answers `422 INVOICE_NOT_QUOTE`) · **409** `INVOICE_DUPLICATE` (a SALE reusing an existing `invoiceNumber`; only a REFUND may reuse a number) · **422** validation rejection · **502** `FISCAL_ERROR` (V-SDC rejected) · **401/403** auth/scope · **429** rate-limited (`retryAfter`).

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
- **No location environment variable.** Every fresh sale — in `examples/` and in `tests/helpers.mjs` — carries `storeCode: "STORE-PV-01"` as a **literal in the fixture**. Deliberately not an env var: these files exist to show the request body, and a selector injected from the environment would be invisible to a reader while being the thing that decides which certificate signs. It has to be declared and mapped once (see the prerequisites) or those sales block with `HTTP_STORE_NOT_MAPPED`.

  The `locationId` GUID remains accepted on the wire for callers that already store one, but nothing here demonstrates it: an integrator should never need to hold a VSMS Connect id.

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
  17-multi-location.mjs    # extra: declare store codes → read back → sale by storeCode → undeclared code → both-selectors 422
  27-multi-tax-line.mjs    # extra: ONE line item bearing several taxes (taxCodes[] / taxLabels[])
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
- **Group 2 — extra wire coverage**: GTIN barcodes, zero-rated VAT0, split tender, proforma → NORMAL conversion via `reference`, cancellation (counter-document), and an unmapped store code blocking rather than signing elsewhere (TAXCORE-718). None of them needs an environment variable.
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
5. **Declare your store codes.** `POST /businesses/:id/stores` (see `examples/17-multi-location.mjs`), then have an admin map each one to a business location on the app's Generic HTTP screen (Stores tab). Until a code is mapped, invoices carrying it are **accepted and blocked** (`HTTP_STORE_NOT_MAPPED`) rather than signed somewhere else; the admin's "Re-sync blocked invoices" releases them in place once the store is mapped and that location holds a certificate. This is **not multi-location-only**: the rule is that any code you send must be mapped, so a single-shop business sending an undeclared code gets the same block a chain would. The only setup-free path is sending no selector at all on a business with exactly one certified location — and that stops working the moment a second location is certified (`HTTP_STORE_CODE_REQUIRED`).

## 4. Verification checklist

1. `node --env-file=.env examples/01-normal-sale.mjs` (or `yarn case 1`) → 200 with the fiscal number, verification URL, and receipt journal; corrupted key → 401 rendered cleanly; wrong-scope key → 403 `USER_FORBIDDEN`.
2. `yarn case 03-normal-refund` → 200; the script makes its own sale inline, then refunds it (reusing the sale's invoice number). The numbered refund/copy/proforma scripts are all self-standing — no argv needed.
3. `yarn case 09` (copy sale), `yarn case 15` (cancel — makes + cancels its own sale), `yarn case 11` (proforma → trigger → fiscalised) → each completes with its own fiscal number.
4. `node --env-file=.env examples/17-multi-location.mjs` → declares your store codes; sales block until an admin maps them, then sign at the mapped location's cert.
   4b. `yarn case 17` (no env var needed) → declares two store codes, reads them back with their statuses, fiscalises by `storeCode`, shows an undeclared code being proposed rather than rejected, and asserts `422 LOCATION_SELECTOR_EXCLUSIVE` when both selectors are sent.
5. `yarn test` → full suite green (sales incl. GTIN/VAT0/split-tender/training, refund, copies, proforma lifecycle, cancel, location, negatives incl. `LOCATION_NOT_FOUND`, idempotency replay with the `Idempotency-Replayed: true` header); non-zero exit when any step fails.
6. `yarn format` leaves no diff.
