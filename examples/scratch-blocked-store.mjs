#!/usr/bin/env node
// Scratch check for TAXCORE-718 — one sale, one unmapped store code.
//
// Deliberately minimal, and deliberately NOT part of the numbered case set:
//
//  * It sends `taxLabel` (the escape hatch) rather than `taxCode`, so the tax
//    mappings you deleted cannot add MISSING_TAX_MAPPING to the answer. The
//    only block reason that can come back is the store one.
//  * It never calls POST /stores. An unknown code is proposed by the fiscalise
//    path itself, so this proves fail-closed routing without depending on the
//    declaration endpoint.
//
//   node --env-file=.env examples/scratch-blocked-store.mjs
//   node --env-file=.env examples/scratch-blocked-store.mjs MY-STORE-CODE
import { fiscalise, totalsOf, uniqueNumber, vatLine } from "./lib.mjs";

const STORE_CODE = process.argv[2] ?? "ST-SCRATCH-1";

const lines = [vatLine("Scratch item", 1000, 1)];
// vatLine defaults to a taxCode; swap in the raw V-SDC label so mapping is
// bypassed entirely and the store reason stands alone.
for (const line of lines) {
  delete line.taxCode;
  line.taxLabel = "A";
}

const body = {
  invoiceNumber: uniqueNumber("EX-SCRATCH"),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "scratch",
  lineItems: lines,
  payments: [
    {
      amount: totalsOf(lines).totalAmount,
      paymentType: "CASH",
      paymentDate: new Date().toISOString(),
    },
  ],
  ...totalsOf(lines),
};

console.log(`→ POST /fiscalise  storeCode="${STORE_CODE}"`);
const res = await fiscalise(body);

if (res.envelope.error) {
  console.error(
    `\n✗ HTTP ${res.status} ${res.envelope.code}: ${res.envelope.message}`,
  );
  for (const v of res.envelope.validationErrors ?? [])
    console.error(`    ${v.field}: ${v.message}`);
  console.error(
    "\n  An ERROR envelope is itself the wrong answer here — a blocked invoice\n" +
      "  is a 201 SUCCESS. Fail-closed must never reject the sale at the wire.",
  );
  process.exit(1);
}

console.log(`\nHTTP ${res.status}   invoiceId ${res.payload.invoiceId}`);
for (const p of res.payload.paymentResults) {
  console.log(`  payment ${p.invoicePaymentId}`);
  console.log(`    status                   ${p.status}`);
  console.log(`    eligibleForFiscalisation ${p.eligibleForFiscalisation}`);
  console.log(
    `    fiscalisationBlockReasons ${JSON.stringify(p.fiscalisationBlockReasons ?? [])}`,
  );
  console.log(`    fiscalInvoiceNumber      ${p.fiscalInvoiceNumber ?? "—"}`);
}

const blocked = res.payload.paymentResults.every((p) =>
  (p.fiscalisationBlockReasons ?? []).includes("HTTP_STORE_NOT_MAPPED"),
);

console.log(
  blocked
    ? "\n✓ Blocked on HTTP_STORE_NOT_MAPPED — fail-closed routing is live.\n" +
        "  The code is now a proposal: map it on the app's Stores tab, press\n" +
        '  "Re-sync blocked invoices", and this invoice signs in place.'
    : "\n✗ NOT blocked. This backend is signing an unmapped store code —\n" +
        "  either it predates TAXCORE-718, or the store is already mapped.",
);
process.exit(blocked ? 0 : 1);
