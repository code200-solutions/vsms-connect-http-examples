#!/usr/bin/env node
// Extra: a sale that names a specific location (multi-location). The body's
// `locationId` selects which location's default certificate signs the invoice
// — it wins over the API key's location and must belong to the business (else
// 422 LOCATION_NOT_FOUND). Omit it and the API key's location, or the business
// default, is used. `locationId` is forbidden on COPY and ignored on REFUND.
//
//   VSMS_CONNECT_LOCATION_ID=<uuid> node --env-file=.env examples/17-sale-to-location.mjs
//   (or set VSMS_CONNECT_LOCATION_ID in .env)
import {
  fiscalise,
  expectFiscalised,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

const locationId = process.env.VSMS_CONNECT_LOCATION_ID;
if (!locationId) {
  console.error(
    "Set VSMS_CONNECT_LOCATION_ID to a Location UUID for this business (Locations screen / API-key reveal modal).",
  );
  process.exit(2);
}

const lineItems = [vatLine("Branch sale item", 1000, 1)];
const body = {
  invoiceNumber: uniqueNumber("EX-LOC"),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  locationId, // ← the location whose certificate signs this sale
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  payments: [
    {
      amount: totalsOf(lineItems).totalAmount,
      paymentType: "CASH",
      paymentDate: new Date().toISOString(),
    },
  ],
  ...totalsOf(lineItems),
};

// A different location's cert produces a different `signedBy` segment in the
// SDC fiscal number — compare against a sale to another location to confirm.
printReceipt(
  await expectFiscalised(await fiscalise(body), "sale to location"),
  `Sale to location ${locationId}`,
);
