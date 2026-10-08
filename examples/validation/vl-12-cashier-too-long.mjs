#!/usr/bin/env node
// VL-12. cashierId of 51 characters → BLOCKED (CASHIER_ID_TOO_LONG)
// V-SDC's cashier allows at most 50 characters. The sale is ACCEPTED (201) and
// then blocked at ingest: it shows on Home as Blocked with the reason and the
// limit, and an administrator can dismiss it. The cashier is never rewritten.
// (Above the stored column size of 100 characters the request is rejected 422.)
//   node --env-file=.env examples/validation/vl-12-cashier-too-long.mjs
import { expectBlockedOnIngest, fiscalise, validSaleBody } from "../lib.mjs";

const body = validSaleBody("VL12");
body.cashierId = "K".repeat(51); // <- V-SDC cashier max 50

await expectBlockedOnIngest(
  await fiscalise(body),
  "VL-12 cashierId of 51 characters",
  "CASHIER_ID_TOO_LONG",
);
