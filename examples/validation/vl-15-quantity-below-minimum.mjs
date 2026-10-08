#!/usr/bin/env node
// VL-15. A negative line quantity → BLOCKED (QUANTITY_INVALID)
// A quantity must be a number of 0 or more. The sale is ACCEPTED (201) and then
// blocked at ingest; it shows on Home as Blocked.
// (A quantity of 0, or between 0 and 0.001, is NOT blocked: it is auto-adjusted
// when signed — sent as 1 with the line total as the price.)
//   node --env-file=.env examples/validation/vl-15-quantity-below-minimum.mjs
import { expectBlockedOnIngest, fiscalise, validSaleBody } from "../lib.mjs";

const body = validSaleBody("VL15");
body.lineItems[0].quantity = -1; // <- must be 0 or more

await expectBlockedOnIngest(
  await fiscalise(body),
  "VL-15 negative line quantity",
  "QUANTITY_INVALID",
);
