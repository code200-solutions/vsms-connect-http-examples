#!/usr/bin/env node
// VL-16. The same tax code twice on a line → BLOCKED (TAX_LABELS_DUPLICATE)
// A tax can apply to a line at most once. The sale is ACCEPTED (201) and then
// blocked at ingest; it shows on Home as Blocked. The labels are never silently
// de-duplicated — the same outcome for every connector.
//   node --env-file=.env examples/validation/vl-16-duplicate-tax-codes.mjs
import { expectBlockedOnIngest, fiscalise, validSaleBody } from "../lib.mjs";

const body = validSaleBody("VL16");
body.lineItems[0].taxCode = ["VAT15", "VAT15"]; // <- the same tax twice

await expectBlockedOnIngest(
  await fiscalise(body),
  "VL-16 duplicate tax codes",
  "TAX_LABELS_DUPLICATE",
);
