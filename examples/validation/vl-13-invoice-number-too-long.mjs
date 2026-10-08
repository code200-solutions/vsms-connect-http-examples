#!/usr/bin/env node
// VL-13. invoiceNumber of 61 characters → BLOCKED (INVOICE_NUMBER_TOO_LONG)
// V-SDC's invoiceNumber allows at most 60 characters. The sale is ACCEPTED
// (201) and then blocked at ingest; it shows on Home as Blocked.
// (Above the stored column size of 255 characters the request is rejected 422.)
//   node --env-file=.env examples/validation/vl-13-invoice-number-too-long.mjs
import { expectBlockedOnIngest, fiscalise, validSaleBody } from "../lib.mjs";

const body = validSaleBody("VL13");
body.invoiceNumber = "N".repeat(61); // <- V-SDC invoiceNumber max 60

await expectBlockedOnIngest(
  await fiscalise(body),
  "VL-13 invoiceNumber of 61 characters",
  "INVOICE_NUMBER_TOO_LONG",
);
