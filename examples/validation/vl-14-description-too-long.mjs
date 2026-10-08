#!/usr/bin/env node
// VL-14. A line description of 2049 characters → BLOCKED (ITEM_NAME_TOO_LONG)
// V-SDC's item name allows at most 2048 characters. The sale is ACCEPTED (201)
// and then blocked at ingest; it shows on Home as Blocked. The description is
// never truncated.
// (Above the stored column size of 4000 characters the request is rejected 422.)
//   node --env-file=.env examples/validation/vl-14-description-too-long.mjs
import { expectBlockedOnIngest, fiscalise, validSaleBody } from "../lib.mjs";

const body = validSaleBody("VL14");
body.lineItems[0].description = "D".repeat(2049); // <- V-SDC items.name max 2048

await expectBlockedOnIngest(
  await fiscalise(body),
  "VL-14 line description of 2049 characters",
  "ITEM_NAME_TOO_LONG",
);
