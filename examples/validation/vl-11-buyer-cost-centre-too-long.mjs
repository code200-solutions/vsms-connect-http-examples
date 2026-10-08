#!/usr/bin/env node
// VL-11. buyer.costCentreId of 51 characters → BLOCKED (BUYER_COST_CENTER_TOO_LONG)
// V-SDC's buyerCostCenterId allows at most 50 characters. The sale is ACCEPTED
// (201) and then blocked at ingest; it shows on Home as Blocked.
//   node --env-file=.env examples/validation/vl-11-buyer-cost-centre-too-long.mjs
import { expectBlockedOnIngest, fiscalise, validSaleBody } from "../lib.mjs";

const body = validSaleBody("VL11");
body.buyer = { tin: "123456", costCentreId: "C".repeat(51) }; // <- V-SDC buyerCostCenterId max 50

await expectBlockedOnIngest(
  await fiscalise(body),
  "VL-11 buyer.costCentreId of 51 characters",
  "BUYER_COST_CENTER_TOO_LONG",
);
