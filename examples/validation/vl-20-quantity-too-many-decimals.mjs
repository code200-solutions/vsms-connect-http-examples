#!/usr/bin/env node
// VL-20. Quantity with 4 decimals → SIGNED, quantity rounded on the wire
// V-SDC allows at most 3 decimals on quantity. The consumer rounds the WIRE
// request (1.2345 → 1.235) and signs; the stored invoice keeps 1.2345.
//
// Needs VSDC_VALIDATION_MODE=enforce on the CONSUMER. Verify in the audit log:
// an event VSDC_REQUEST_AUTO_FIXED for this invoice listing QUANTITY_ROUNDED.
// In report mode the request goes out unchanged (and V-SDC may reject it).
//   node --env-file=.env examples/validation/vl-20-quantity-too-many-decimals.mjs
import {
  expectFiscalised,
  fiscalise,
  showPayments,
  totalsOf,
  validSaleBody,
  vatLine,
} from "../lib.mjs";

const body = validSaleBody("VL20");
body.lineItems = [vatLine("Fractional quantity item", 1000, 1.2345)]; // <- 4 decimals
Object.assign(body, totalsOf(body.lineItems));
body.payments[0].amount = body.totalAmount;

const result = await fiscalise(body);
const payload = await expectFiscalised(result, "VL-20 quantity 1.2345");
showPayments(payload);
console.log(
  "\nNow check the Audit screen for VSDC_REQUEST_AUTO_FIXED on invoice " +
    body.invoiceNumber +
    " (QUANTITY_ROUNDED).",
);
