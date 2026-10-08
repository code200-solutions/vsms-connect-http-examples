#!/usr/bin/env node
// VL-10. buyer.tin of 21 characters → BLOCKED (BUYER_ID_TOO_LONG)
// V-SDC's buyerId allows at most 20 characters. The sale is ACCEPTED (201) and
// then blocked at ingest: it shows on Home as Blocked, and an administrator can
// dismiss it (the data cannot be edited in VSMS Connect — fix it at the source).
// (Above the stored column size of 100 characters the request is rejected 422.)
//   node --env-file=.env examples/validation/vl-10-buyer-tin-too-long.mjs
import { expectBlockedOnIngest, fiscalise, validSaleBody } from "../lib.mjs";

const body = validSaleBody("VL10");
body.buyer = { tin: "T".repeat(21), name: "Acme Trading Ltd" }; // <- V-SDC buyerId max 20

await expectBlockedOnIngest(
  await fiscalise(body),
  "VL-10 buyer.tin of 21 characters",
  "BUYER_ID_TOO_LONG",
);
