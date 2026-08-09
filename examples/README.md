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
node --env-file=.env examples/17-sale-to-location.mjs           # sale signed by a specific location's cert (needs VSMS_CONNECT_LOCATION_ID)
node --env-file=.env examples/18-partial-refund-by-line.mjs  # refund one line of a multi-line sale (item-level partial refund)
node --env-file=.env examples/19-refund-different-tender.mjs # sale paid CASH, refunded to CARD
node --env-file=.env examples/20-multiple-partial-refunds.mjs # two partial refunds against one sale
node --env-file=.env examples/21-declare-tax-rates.mjs      # declare your tax table up front → admin maps each code to a V-SDC label
node --env-file=.env examples/22-custom-tax-code.mjs [CODE] # send an unmapped code → accepted but blocked (MISSING_TAX_MAPPING), surfaces for mapping
node --env-file=.env examples/23-get-invoice.mjs <invoiceId> # retrieve one invoice by its invoiceId → prints status + block reasons (single GET, no polling)
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

### Tax-rate declaration (`21`)

`21-declare-tax-rates.mjs` demonstrates `POST /businesses/:businessId/tax-rates` — the push-connector equivalent of "list all tax rates". Because VSMS Connect cannot pull your tax catalogue, you **declare** it: each code you send that isn't already mapped becomes a proposal a business admin maps to a V-SDC label on the HTTP integration screen. `taxCode` on a line item is an open vocabulary (any non-empty string ≤100 chars) — there are **no pre-seeded defaults**, so a fresh business must map every code it uses (even `VAT15`/`VAT0`) before an invoice carrying it can sign. Any code you use is accepted on the wire and surfaces for mapping (either by declaring it here up front, or automatically the first time it appears on an invoice, which blocks that invoice with `MISSING_TAX_MAPPING` until mapped). Nothing declared is ever auto-confirmed; re-declaring a confirmed code only flags rate/name drift for re-review.

### Retrieve an invoice (`23`)

`23-get-invoice.mjs` is the **retrieval** case — the one GET the connector exposes: `GET /businesses/:businessId/fiscalise/:invoiceId`. Lookup is by the **server-issued `invoiceId` GUID** (echoed in every POST response — not your `invoiceNumber`, and not the SDC `fiscalInvoiceNumber`), business-scoped by the API key. There is no list/search endpoint and no lookup by `invoiceNumber`, so the integrator is the system of record for the id. It does a **single** GET and prints the current state — including the `eligibleForFiscalisation` / `fiscalisationBlockReasons` fields (TAXCORE-645) — so it works on a still-`imported` invoice. Use this rather than `status-poll.mjs` when you just want the current state: `status-poll.mjs` loops until every payment is terminal and would hang on a non-terminal `imported` invoice.

### Custom / unmapped tax code (`22`)

`22-custom-tax-code.mjs` is the discovery counterpart to `21`: it sends a fresh SALE with a `taxCode` you haven't mapped (default `TESTRATE`, or pass one as the first arg). The invoice is **accepted** (proving the open vocabulary — a pre-635 backend would reject it with a `422` at the wire, which the script detects and calls out) but **blocked** with `MISSING_TAX_MAPPING` — persisted, not fiscalised — and the code appears in the admin's unmapped-tax-types panel for mapping. This is the truest check for a **new business**: a fresh business has no HTTP tax mappings at all (registration seeds only a default location + certificate, never tax mappings — and since TAXCORE-646 there is no "Initialize"/auto-seed shortcut either), so on day 0 every code blocks until an admin declares via `21` (or lets the code surface from an invoice) and then maps it on the HTTP integration screen. If the code is already mapped the script reports the sale fiscalised instead.

Run from the repo root (the `--env-file` path is resolved from the working directory). For the full assertable matrix in one command, use `yarn test` (see [../README.md](../README.md)).
