#!/usr/bin/env node
// 12. Proforma Refund — refund a fiscalised quote. This script creates the
// quote, triggers + polls it to a fiscal number, then refunds it: same
// invoiceNumber, invoiceType PROFORMA, transactionType REFUND, referencing the
// quote's fiscal number.
//   node --env-file=.env examples/12-proforma-refund.mjs
import {
  expectFiscalised,
  fiscalise,
  pollUntilTerminal,
  printReceipt,
  requireFiscal,
  STORE_CODE,
  totalsOf,
  trigger,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber("EX-QUOTE");
const now = () => new Date().toISOString();
const lineItems = [vatLine("Consulting services — Q3", 5000, 10)];
const pay = (t) => [
  { amount: t.totalAmount, paymentType: "WIRE_TRANSFER", paymentDate: now() },
];

// (a) quote → trigger → fiscalised
const quote = await fiscalise({
  invoiceNumber,
  invoiceType: "PROFORMA",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: now(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  payments: pay(totalsOf(lineItems)),
  ...totalsOf(lineItems),
});
if (quote.envelope.error) {
  console.error(`${quote.envelope.code}: ${quote.envelope.message}`);
  process.exit(1);
}
await trigger(quote.payload.invoiceId);
const quotePayload = await pollUntilTerminal(quote.payload.invoiceId);
requireFiscal(quotePayload, "quote to refund");

// (b) refund the quote — SAME invoiceNumber; the server resolves the source
// (TAXCORE-639), so no SDC fiscal number is echoed back.
const refundLines = [vatLine("Consulting services — Q3 (refund)", 5000, 10)];
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber,
      invoiceType: "PROFORMA",
      transactionType: "REFUND",
      invoiceDate: now(),
      currencyCode: "VUV",
      cashierId: "example-pos",
      lineItems: refundLines,
      payments: pay(totalsOf(refundLines)),
      ...totalsOf(refundLines),
    }),
    "12. Proforma Refund",
  ),
  "Proforma Refund",
);
