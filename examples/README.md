# Integration examples

Runnable scripts for the VSMS Connect **generic HTTP connector**. Files `01`–`14` are the **14 canonical V-SDC cases** (one per accreditation case); the rest are extras. Each case script is complete and self-standing — the refund/copy/proforma-refund scripts create their own prerequisite sale inline, so any file runs on its own with no argument juggling.

They share [`lib.mjs`](lib.mjs) (config, the `fetch` call, polling, receipt printing, and line/total builders) so each case file focuses on its **request body** — the part you'd adapt. The full wire contract is in [../docs/SPEC.md](../docs/SPEC.md) §1.

## Setup

```bash
cp ../.env.example ../.env   # backend URL, business ID, http-scoped API key
```

Node ≥ 20.6 (`--env-file` + native `fetch`). Nothing to install.

**One-time tax setup (required).** There are no pre-seeded tax codes (TAXCORE-646), so before the sale/refund cases can sign, the business must have the codes these scripts use — `VAT15` and `VAT0` — mapped to V-SDC labels. Declare them with `21-declare-tax-rates.mjs`, then have an admin confirm each mapping on the HTTP integration screen. Until that is done every invoice comes back **imported + blocked** with `MISSING_TAX_MAPPING` (a 201, not a fiscalised 200) — see `22-custom-tax-code.mjs` for exactly that state.

## Running one case at a time

Shortcut — `yarn case <number|name>` dispatches to the matching script (env inherited, extra args passed through):

```bash
yarn case 07                  # → examples/07-advance-refund.mjs
yarn case advance-refund      # → same (name substring)
yarn case mixed               # → examples/16-sale-mixed.mjs
node --env-file=.env examples/17-multi-location.mjs         # declare your own store codes → sale by storeCode (no GUID anywhere)
yarn case cancel <fiscalNo>   # extra args pass through
yarn case --list              # list every case
```

Or invoke a file directly:

## The 14 canonical cases

```bash
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
```

## Extras

```bash
node --env-file=.env examples/16-sale-mixed.mjs              # multi-line, VAT15 + VAT0, split cash/card tender
node --env-file=.env examples/18-partial-refund-by-line.mjs  # refund one line of a multi-line sale (item-level partial refund)
node --env-file=.env examples/19-refund-different-tender.mjs # sale paid CASH, refunded to CARD
node --env-file=.env examples/20-multiple-partial-refunds.mjs # two partial refunds against one sale
node --env-file=.env examples/21-declare-tax-rates.mjs      # declare your tax table up front → admin maps each code to a V-SDC label
node --env-file=.env examples/22-custom-tax-code.mjs [CODE] # send an unmapped code → accepted but blocked (MISSING_TAX_MAPPING), surfaces for mapping
node --env-file=.env examples/23-get-invoice.mjs <invoiceId> # retrieve one invoice by its invoiceId → prints status + block reasons (single GET, no polling)
node --env-file=.env examples/24-retry-same-body.mjs        # POST the same body twice → cached replay (Idempotency-Replayed: true), no duplicate
node --env-file=.env examples/25-duplicate-invoice-number.mjs     # another SALE reusing an invoiceNumber → 409 INVOICE_DUPLICATE
node --env-file=.env examples/26-reuse-number-for-refund.mjs # REFUND on the sale's invoiceNumber → distinct linked document (new invoiceId)
node --env-file=.env examples/27-multi-tax-line.mjs      # ONE line item bearing several taxes (taxCode as an array)
node --env-file=.env examples/15-cancel.mjs                 # makes a sale, cancels it by invoiceNumber (no SDC number)
node --env-file=.env examples/status-poll.mjs <invoiceId>    # poll a 202 (queued) invoice to terminal
```

### Refund parity (`18`–`20`)

These three show the refund cases beyond a plain whole-invoice refund. Each creates its own sale inline, then refunds against that sale's fiscal number.

| Script                            | Demonstrates                                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `18-partial-refund-by-line.mjs`   | **Item-level partial refund** — the refund body carries its own line item(s), so you return specific lines rather than a proportional slice of the whole invoice. The refund total is below the sale total.    |
| `19-refund-different-tender.mjs`  | **Refund in a different tender than the sale** — the sale is paid `CASH`, the refund settles to `CARD`. The refund's `paymentType` drives the credit note's tender.                                            |
| `20-multiple-partial-refunds.mjs` | **Several partial refunds against one sale** — two refunds against the same sale fiscal number, each returning a different line. The running total is guarded server-side and can never exceed the sale total. |

### Several taxes on one line (`27`)

`27-multi-tax-line.mjs` demonstrates passing an **array** to `taxCode` (or to `taxLabel`). An item can be liable for more than one tax at once — VAT plus a levy, say — and in the TaxCore model a label identifies one **rate** inside one **category**, with at most one label per category on a line. So "VAT and ECAL on this bottle" is two labels on one line, not two lines. There is one field, not a `taxCode` / `taxCodes` pair: `"VAT15"` and `["VAT15"]` mean exactly the same thing, so every caller written before multi-tax support keeps working untouched, and adding a second tax to a line means putting its existing value in brackets. Single- and multi-tax lines mix freely inside one invoice; what you cannot do is send `taxCode` **and** `taxLabel` on the same line (`422 TAX_CODE_AND_LABEL_EXCLUSIVE`), or repeat a value (`422 TAX_CODES_DUPLICATE`). There is no cap on how many taxes a line may bear — the tax authority decides how many categories exist, so we do not impose a number of our own.

**You never compute the combined tax.** V-SDC does, from the labels plus the item total, and that is the only place it can be right: a _tax-on-total_ category charges its rate on the item total **including** the other taxes on that line, and an _amount-per-quantity_ category is a fixed sum per unit with the rest computed on the remainder. Both depend on what else is attached to the same line. The `taxRatePercent` and tax amounts you send are for reconciliation and display only.

⚠️ **Every code on the line must be mapped first.** If even one is not, the whole line is blocked with `MISSING_TAX_MAPPING` and nothing is signed — attaching only the mapped subset would produce a receipt that looks successful and under-reports tax. The script prints the block reasons rather than pretending, so run it as `yarn case 27 MY-LEVY` with a code your business has actually mapped.

### Tax-rate declaration (`21`)

`21-declare-tax-rates.mjs` demonstrates `POST /businesses/:businessId/tax-rates` — the push-connector equivalent of "list all tax rates". Because VSMS Connect cannot pull your tax catalogue, you **declare** it: each code you send that isn't already mapped becomes a proposal a business admin maps to a V-SDC label on the HTTP integration screen. `taxCode` on a line item is an open vocabulary (any non-empty string ≤100 chars) — there are **no pre-seeded defaults**, so a fresh business must map every code it uses (even `VAT15`/`VAT0`) before an invoice carrying it can sign. Any code you use is accepted on the wire and surfaces for mapping (either by declaring it here up front, or automatically the first time it appears on an invoice, which blocks that invoice with `MISSING_TAX_MAPPING` until mapped). Nothing declared is ever auto-confirmed; re-declaring a confirmed code only flags rate/name drift for re-review.

### Retrieve an invoice (`23`)

`23-get-invoice.mjs` is the **retrieval** case — the one GET the connector exposes: `GET /businesses/:businessId/fiscalise/:invoiceId`. Lookup is by the **server-issued `invoiceId` GUID** (echoed in every POST response — not your `invoiceNumber`, and not the SDC `fiscalInvoiceNumber`), business-scoped by the API key. There is no list/search endpoint and no lookup by `invoiceNumber`, so the integrator is the system of record for the id. It does a **single** GET and prints the current state — including the `eligibleForFiscalisation` / `fiscalisationBlockReasons` fields (TAXCORE-645) — so it works on a still-`imported` invoice. Use this rather than `status-poll.mjs` when you just want the current state: `status-poll.mjs` loops until every payment is terminal and would hang on a non-terminal `imported` invoice.

### Custom / unmapped tax code (`22`)

`22-custom-tax-code.mjs` is the discovery counterpart to `21`: it sends a fresh SALE with a `taxCode` you haven't mapped (default `TESTRATE`, or pass one as the first arg). The invoice is **accepted** (proving the open vocabulary — a pre-635 backend would reject it with a `422` at the wire, which the script detects and calls out) but **blocked** with `MISSING_TAX_MAPPING` — persisted, not fiscalised — and the code appears in the admin's unmapped-tax-types panel for mapping. This is the truest check for a **new business**: a fresh business has no HTTP tax mappings at all (registration seeds only a default location + certificate, never tax mappings — and since TAXCORE-646 there is no "Initialize"/auto-seed shortcut either), so on day 0 every code blocks until an admin declares via `21` (or lets the code surface from an invoice) and then maps it on the HTTP integration screen. If the code is already mapped the script reports the sale fiscalised instead.

### Idempotency / reusing an invoiceNumber (`24`–`26`)

"What happens if I POST the same invoice twice?" You never supply an `invoiceId` (that's a server-issued GUID) — you control `invoiceNumber`, and the connector is built around reusing it (the evolving-invoice model). Three separate scripts, one reuse outcome each:

| Script                            | Re-POST                                   | Outcome                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `24-retry-same-body.mjs`          | **Byte-identical body**                   | **Cached replay** — the 5-min HTTP idempotency cache (keyed on `invoiceNumber` + a body hash) returns the first response verbatim with header `Idempotency-Replayed: true`. Same `invoiceId`, no second effect. The body must be byte-identical — build it once with fixed timestamps; a fresh `new Date()` changes the hash and defeats the cache. |
| `25-duplicate-invoice-number.mjs` | **Changed SALE body, same invoiceNumber** | **409 `INVOICE_DUPLICATE`** — a changed body is a cache miss, so it reaches the handler; a SALE cannot reuse a number that already identifies an invoice, and the error names the existing `invoiceId` + status. Proves only an identical body replays; anything else under an existing number is a real, state-dependent operation.                |
| `26-reuse-number-for-refund.mjs`  | **REFUND body**                           | **Linked refund** — a distinct linked document sharing the `invoiceNumber`; the source sale is resolved automatically (no SDC number needed, TAXCORE-639). New `invoiceId`, not a duplicate.                                                                                                                                                        |

Reusing an `invoiceNumber` never creates a duplicate invoice. Appending a further payment to an invoice that is still **open** (instalments/layby) is done as a single ADVANCE POST carrying several `payments[]` — see `05`/`07` — because the schema requires `sum(payments) == totalAmount` on every POST, so a partial second POST isn't a wire pattern. Payment rows are also deduped server-side on their own `externalPaymentId`, so replaying a payment can't double-insert it.

### Multi-location (`17`)

`17-multi-location.mjs` demonstrates the store-code surface — `POST` / `GET /businesses/:businessId/stores` plus the `storeCode` field on a fiscalise body. It is the location counterpart of `21`+`22`: **you declare your own vocabulary and an admin maps it**, so a multi-location integrator never has to hold a VSMS Connect `locationId` GUID against its stores. Run it as `yarn case 17`; it needs no env var, because the codes are yours.

The script walks all five states in one run:

| Step | Sends                                     | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `POST /stores` with two store codes       | Each unknown code becomes a **proposal** for an admin to map to a business location on the app's Stores tab. Re-declaring is a no-op — a declaration never overwrites a row the admin owns, and there is no drift handling (a renamed store is cosmetic).                                                                                                                                                                                            |
| 2    | `GET /stores`                             | Reads back `{ storeCode, name, status, locationId }` per code, `status` ∈ `mapped` / `proposed` / `rejected`. **HTTP-sourced rows only** — a hand-created location has no code of yours, and listing it would only invite sending GUIDs again.                                                                                                                                                                                                       |
| 3    | Sale with `storeCode` of a mapped store   | Signs at that store's certificate. Only a **mapped** code routes: an unmapped code is not an admin decision, so the sale is **blocked** (`HTTP_STORE_NOT_MAPPED`) rather than signed elsewhere. Compare the `signedBy` segment of the fiscal numbers to see the routing.                                                                                                                                                                             |
| 4    | Sale with an **undeclared** `storeCode`   | **Accepted, never rejected — and blocked, never mis-signed.** The invoice is stored and the code raised as a proposal (for a push connector the invoice is the only discovery event there is, so a rejection would make the code undiscoverable and lose a real sale), but it blocks with `HTTP_STORE_NOT_MAPPED` until an admin maps the store to a business location. A code an admin already **rejected** is not re-proposed, and keeps blocking. |
| 5    | `storeCode` **and** `locationId` together | **422 `LOCATION_SELECTOR_EXCLUSIVE`** — two ways to say the same thing must never travel together, the same rule a line item's `taxCode` / `taxLabel` pair follows. Sending **neither** is the zero-config path a single-location business uses.                                                                                                                                                                                                     |

Store codes and tax codes now behave **identically**, and that is worth internalising: both are accepted on the wire, both surface for admin review, and both **block** the invoice until resolved — `MISSING_TAX_MAPPING` (example `22`) and `HTTP_STORE_NOT_MAPPED` / `HTTP_STORE_LOCATION_NO_CERTIFICATE` here. Neither ever loses a sale, and neither is ever quietly signed under the wrong certificate. An earlier revision let an unmapped store fall back to the API key's location; that is gone, because it reported success while signing the sale somewhere it did not belong. Read `fiscalisationBlockReasons` and expect more than one entry.

The `locationId` GUID is still accepted on the wire for callers that already store one, but no example demonstrates it any more: an integrator should never need to hold a VSMS Connect id, and an example teaching that habit works against the whole point of this surface. Every fresh sale here sends `storeCode` instead.

Run from the repo root (the `--env-file` path is resolved from the working directory). For the full assertable matrix in one command, use `yarn test` (see [../README.md](../README.md)).
