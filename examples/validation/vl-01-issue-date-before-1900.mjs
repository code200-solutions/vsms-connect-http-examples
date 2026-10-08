#!/usr/bin/env node
// VL-01. Issue date before 1900 → BLOCKED (ISSUE_DATE_INVALID)
// V-SDC accepts an issue date only between year 1900 and 9999. The connector does
// not range-check invoiceDate itself, so the sale is ACCEPTED (201) and then
// blocked at ingest — it will never be sent to V-SDC.
//
// Needs VSDC_VALIDATION_MODE=enforce on the BACKEND. In report mode the same
// request is accepted and unblocked; the backend only logs a [VsdcIngest] line.
//   node --env-file=.env examples/validation/vl-01-issue-date-before-1900.mjs
import { expectBlockedOnIngest, fiscalise, validSaleBody } from "../lib.mjs";

const body = validSaleBody("VL01");
body.invoiceDate = "1850-06-01T00:00:00Z"; // <- the one broken field

await expectBlockedOnIngest(
  await fiscalise(body),
  "VL-01 invoiceDate before 1900",
  "ISSUE_DATE_INVALID",
);
