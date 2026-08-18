#!/usr/bin/env node
// 11. Proforma Sale — a quote. A PROFORMA is NOT auto-fiscalised: the POST
// returns HTTP 201 with a triggerUrl and the invoice sits as "imported" until
// you explicitly trigger it. This script posts the quote, triggers it, then
// polls until it has a fiscal number.
//   node --env-file=.env examples/11-proforma-sale.mjs
import {
  firstFiscal,
  fiscalise,
  pollUntilTerminal,
  printReceipt,
  STORE_CODE,
  totalsOf,
  trigger,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

const lineItems = [vatLine("Consulting services — Q3", 5000, 10)];
const quote = await fiscalise({
  invoiceNumber: uniqueNumber("EX-QUOTE"),
  invoiceType: "PROFORMA",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  payments: [
    {
      amount: totalsOf(lineItems).totalAmount,
      paymentType: "WIRE_TRANSFER",
      paymentDate: new Date().toISOString(),
    },
  ],
  ...totalsOf(lineItems),
});

console.log(
  `HTTP ${quote.status} (expect 201) — triggerUrl: ${quote.payload?.triggerUrl}`,
);
if (quote.envelope.error) {
  console.error(`${quote.envelope.code}: ${quote.envelope.message}`);
  process.exit(1);
}

// Dispatch the quote to fiscalisation, then poll to a fiscal number.
await trigger(quote.payload.invoiceId);
const payload = await pollUntilTerminal(quote.payload.invoiceId);
console.log(`quote invoiceNumber: ${quote.payload.invoiceNumber}`);
printReceipt(
  payload,
  `11. Proforma Sale — fiscal ${firstFiscal(payload)?.number}`,
);
