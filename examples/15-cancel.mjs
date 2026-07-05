#!/usr/bin/env node
// Extra: cancel a fiscalised payment. Cancellation is a counter-document flow —
// the original receipt is not mutated; V-SDC signs a NEW record reversing it.
//   node --env-file=.env examples/cancel.mjs <fiscalInvoiceNumber>
// Errors: 404 = unknown fiscal number; 409 = a cancellation is already in flight.
import { cancelDoc, printReceipt } from "./lib.mjs";

const [fiscalInvoiceNumber] = process.argv.slice(2);
if (!fiscalInvoiceNumber) {
  console.error(
    "Usage: node --env-file=.env examples/cancel.mjs <fiscalInvoiceNumber>",
  );
  process.exit(2);
}

const result = await cancelDoc(fiscalInvoiceNumber);
console.log(`HTTP ${result.status}`);
if (result.envelope.error) {
  console.error(`${result.envelope.code}: ${result.envelope.message}`);
  process.exit(1);
}
console.log("cancellationPaymentId:", result.payload.cancellationPaymentId);
printReceipt(result.payload, "Cancellation");
