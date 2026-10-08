# Validation examples

Requests that deliberately break ONE V-SDC v3 limit, so you can see what VSMS Connect does with each. Every case starts from the same valid sale (`validSaleBody()` in [`../lib.mjs`](../lib.mjs)) and changes a single field, so the field under test is the only thing that can explain the outcome. Bodies are ordinary (non-training) invoices, so they show on Home's **Invoices** tab with their block reasons. VL-20 really signs, so run the set against a test environment.

```bash
yarn case vl-01      # one case
yarn case vl-00      # run them all and print a summary
```

**Where the invoices appear:** Home → **Invoices** tab. A blocked invoice shows a Blocked status and its reason on the row.

Same prerequisites as the cash-basis set: `.env`, and the `VAT15` tax code mapped (see the parent [README](../README.md)).

## Prerequisites

Blocking is always on — there is nothing to switch. VL-20 and VL-22 need **auto-fiscalise ON for the Generic HTTP connector** (Generic HTTP screen); with it off the invoice is imported and waits for an admin, and the script stops with "no fiscalisation job exists". Restart the backend and consumer after pulling the latest code.

## What each case proves

| Case  | Request                         | Expected                                                                                     |
| ----- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| VL-01 | `invoiceDate` in 1850           | **Accepted (201) then BLOCKED** — `ISSUE_DATE_INVALID`. Never sent to V-SDC.                 |
| VL-10 | `buyer.tin` of 21 characters    | **Accepted (201) then BLOCKED** — `BUYER_ID_TOO_LONG`                                        |
| VL-11 | `buyer.costCentreId` of 51      | **Accepted (201) then BLOCKED** — `BUYER_COST_CENTER_TOO_LONG`                               |
| VL-12 | `cashierId` of 51               | **Accepted (201) then BLOCKED** — `CASHIER_ID_TOO_LONG`                                      |
| VL-13 | `invoiceNumber` of 61           | **Accepted (201) then BLOCKED** — `INVOICE_NUMBER_TOO_LONG`                                  |
| VL-14 | line description of 2049        | **Accepted (201) then BLOCKED** — `ITEM_NAME_TOO_LONG`                                       |
| VL-15 | line quantity `-1`              | **Accepted (201) then BLOCKED** — `QUANTITY_INVALID`                                         |
| VL-16 | `taxCode: ["VAT15", "VAT15"]`   | **Accepted (201) then BLOCKED** — `TAX_LABELS_DUPLICATE`                                     |
| VL-20 | quantity `1.2345` (4 decimals)  | **Signed.** Quantity rounded to 3 decimals on the wire only; audit `VSDC_REQUEST_AUTO_FIXED` |
| VL-22 | `taxLabel: "Q"` (unknown label) | **Payment errors before V-SDC** — `TAX_LABEL_UNKNOWN`, not retryable                         |

## Which over-length cases block, and which are rejected

Only values the connector lets through can be **blocked** (VL-01, VL-10 – VL-15): the buyer ID and cost centre are accepted up to the stored column size (100) and then blocked at ingest. The others are refused by the connector's own request validation with a 422 (VL-16), so nothing is persisted. Other sources (Xero, AMICUS, Atrex, Sage 100, Sage 200 Evolution) block the same buyer values, for example from a customer tax number of 21+ characters.

- **Invoice number over 60** — not blocked at ingest; the consumer stops the payment before V-SDC (`INVOICE_NUMBER_TOO_LONG`, not retryable).

## Looking at the result

- **App:** the invoice shows as _Blocked_ with the plain-language reason. A terminally blocked invoice is **not** offered by _Resync Blocked Invoices_ (its data cannot be edited) and **is** offered by _Dismiss Blocked Invoices_.
- **Database** (run it yourself — it is a shared server):

```sql
SELECT p.InvoicePaymentId, i.InvoiceNumber, p.Status, p.EligibleForFiscalisation,
       p.FiscalisationBlockReasons, p.IsRetryable
FROM InvoicePayments p JOIN Invoices i ON i.InvoiceId = p.InvoiceId
WHERE i.InvoiceNumber LIKE 'VL%';
```

- **Audit screen:** `VSDC_REQUEST_AUTO_FIXED`, `INVOICE_BLOCK_DISMISSED`.

A blocked invoice is a **success** envelope (201), not an error — an error envelope means the request never got far enough to be blocked.
