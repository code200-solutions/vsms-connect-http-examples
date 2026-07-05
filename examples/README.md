# Integration examples

Runnable scripts for the VSMS Connect **generic HTTP connector**. Files `01`–`14` are the **14 canonical V-SDC cases** (one per accreditation case); the rest are extras. Each case script is complete and self-standing — the refund/copy/proforma-refund scripts create their own prerequisite sale inline, so any file runs on its own with no argument juggling.

They share [`lib.mjs`](lib.mjs) (config, the `fetch` call, polling, receipt printing, and line/total builders) so each case file focuses on its **request body** — the part you'd adapt. The full wire contract is in [../docs/SPEC.md](../docs/SPEC.md) §1.

## Setup

```bash
cp ../.env.example ../.env   # backend URL, business ID, http-scoped API key
```

Node ≥ 20.6 (`--env-file` + native `fetch`). Nothing to install.

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
node --env-file=.env examples/sale-to-location.mjs           # sale signed by a specific location's cert (needs VSMS_CONNECT_LOCATION_ID)
node --env-file=.env examples/15-cancel.mjs <fiscalInvoiceNumber>
node --env-file=.env examples/status-poll.mjs <invoiceId>    # poll a 202 (queued) invoice to terminal
```

Run from the repo root (the `--env-file` path is resolved from the working directory). For the full assertable matrix in one command, use `yarn test` (see [../README.md](../README.md)).
