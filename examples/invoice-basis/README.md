# Invoice-basis examples

The scripts in [`examples/`](../) are the **cash-basis** set. These four are the **invoice-basis** set — the same connector, the same endpoints, a business that accounts for VAT differently.

```bash
yarn case ib-01      # → examples/invoice-basis/ib-01-at-issue-sale.mjs
yarn case ib-02      # refund an at-issue sale
yarn case ib-03      # void (cancel) one
yarn case ib-04      # edit one — increase, decrease, and a no-op
```

## What "basis" means here

**Cash basis** — tax is declared when the money arrives. A payment is the taxable event, so every `payments[]` entry becomes its own fiscal document and an invoice with no payment has nothing to declare.

**Invoice basis** — tax is declared when the invoice is **issued**. The supply is the taxable event; the money is a debt being settled afterwards and is not declared at all.

That single difference produces everything below.

|                                  | Cash basis (`examples/01`–`27`)                                                                      | Invoice basis (here)                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Fresh SALE                       | one fiscal document per `payments[]` entry, carrying your `paymentType`                              | **one** document for the whole `totalAmount`, `paymentType: OTHER`                              |
| `payments` on a SALE             | required                                                                                             | **optional** — omit it entirely for an unpaid credit sale                                       |
| `invoiceType: ADVANCE`           | a deposit chain, one document per deposit                                                            | **rewritten to NORMAL** — no chain; a credit sale is not a prepayment                           |
| Re-POST the same `invoiceNumber` | appends a settlement payment; the totals are **locked** (`422 INVOICE_FIELD_MISMATCH` if they moved) | the totals are **the payload** — the difference is declared as a new document                   |
| Refund                           | resolves the source payment, disambiguated by `sourceExternalPaymentId`                              | resolves the single at-issue document; `sourceExternalPaymentId` **cannot** work (it is `null`) |
| Cancel by `invoiceNumber`        | ambiguous once a sale has several payments                                                           | unambiguous until the invoice is **edited**                                                     |
| `training: true` / PROFORMA      | as documented in `examples/`                                                                         | unchanged — neither is declared at issue                                                        |

## You need a second business

Basis is `Businesses.VatBasis`, **fixed when the business is registered and not editable afterwards**. There is no request field and no toggle, so one business cannot demonstrate both.

1. Register a second business on **invoice** basis (the basis tiles are on the business setup screen).
2. Create an API key with scope `http` for it (plaintext shown once).
3. Map its tax codes (`VAT15`, `VAT0`) and its store code (`STORE-PV-01`) — a fresh business has none of either, exactly as described in the [root README](../../README.md) prerequisites. These are per-business, so the mappings you already made for the cash-basis business do not carry over.
4. Put it in `.env`:

   ```bash
   VSMS_CONNECT_IB_BUSINESS_ID=<that business's uuid>
   VSMS_CONNECT_IB_API_KEY=<that business's http key>
   ```

Leave both unset and these scripts fall back to `VSMS_CONNECT_BUSINESS_ID` — right if that business is already on invoice basis. If it is not, the scripts stop and say so rather than printing cash-basis output under an invoice-basis heading.

> **There is no endpoint that reports a business's basis.** Nothing on this API tells an integrator which one they are on. These scripts detect it from a payment-free sale being rejected (`422`, `payments must be a non-empty array`), which is the only signal available. If you are integrating against a merchant, ask them — or ask their VSMS Connect admin.

## The four cases

| Script                                               | Shows                                                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ib-01-at-issue-sale.mjs`](ib-01-at-issue-sale.mjs) | A credit sale with **no `payments` at all** fiscalises anyway, as one document for the whole total, `paymentType: OTHER`. The at-issue declaration is the feature; everything else follows from it. |
| [`ib-02-refund.mjs`](ib-02-refund.mjs)               | A refund reuses the sale's `invoiceNumber` and names nothing else — no `referentDocumentNumber`, no `sourceExternalPaymentId`. A REFUND still requires `payments`: money really is going back.      |
| [`ib-03-void.mjs`](ib-03-void.mjs)                   | Cancel by `invoiceNumber` alone, with the caveat that this only holds **before** the invoice is edited.                                                                                             |
| [`ib-04-edit.mjs`](ib-04-edit.mjs)                   | Re-pushing with a changed total declares the **difference**: a chained sale for an increase, a partial refund for a decrease, nothing for an unchanged body.                                        |

## Editing, in one paragraph

A signed V-SDC document is immutable, so an invoice that changes after it was declared is never rewritten — the **change** is declared as a document of its own. Up is a chained NORMAL sale for the increase; down is a partial refund of what was over-declared. The server diffs your body against the **last body it declared**, not against the original invoice, so a second edit is measured from the first and a re-push that changes nothing costs nothing. Each edit answers with the **new document's** `invoiceId` — the one your edit produced, not the original's. Keep it: there is no lookup by `invoiceNumber`.

## Things that trip people up

- **`sourceExternalPaymentId` stops working.** The at-issue event is synthesised by the server, so it carries `externalPaymentId: null`. Naming one matches nothing. If your cash-basis integration always sends it, that line has to go.
- **An edited invoice cannot be cancelled by `invoiceNumber` alone.** It now has several fiscalised documents under that number. For a decrease, `transactionType` splits them; for an increase, both are SALEs with null `externalPaymentId`, so you need the `fiscalInvoiceNumber`. A cancel reverses **one** document, not the chain.
- **`ADVANCE` is not honoured.** It is pinned to `NORMAL`. There is no deposit chain to build, and re-pushing your original `ADVANCE` body is fine — the type is simply rewritten again.
- **A blocked invoice blocks the same way.** An unmapped `taxCode` or `storeCode` still returns 201 with `fiscalisationBlockReasons`, and an admin's re-sync still releases it. Basis changes what is declared, not what blocks.

Run these from the repo root — `--env-file` resolves from the working directory.
