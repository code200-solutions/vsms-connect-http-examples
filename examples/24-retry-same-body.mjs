#!/usr/bin/env node
// 24. Retry the SAME body → cached replay (no duplicate).
//
//   node --env-file=.env examples/24-retry-same-body.mjs
//
// WHAT THIS SHOWS
//   POST an invoice, then POST the EXACT same body again. The server recognises
//   the retry and returns the first response from cache — it does NOT create a
//   second invoice or a second payment. This is the safety net for a network
//   timeout or an offline queue that drains twice.
//
// HOW IT WORKS
//   The server hashes (invoiceNumber + the whole body) into an idempotency key
//   and caches the response for 5 minutes. A byte-identical re-POST inside that
//   window replays the cached response and sets the header
//   `Idempotency-Replayed: true`.
//
// THE ONE GOTCHA
//   The body must be byte-identical. Build it ONCE with fixed timestamps and
//   reuse the same object — calling new Date() again changes the hash, and the
//   retry would be treated as a brand-new request instead of a replay.
import {
  fiscalise,
  expectFiscalised,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

const lineItems = [vatLine("Coffee 250g", 500, 2)];
const nowIso = new Date().toISOString(); // captured ONCE — see "THE ONE GOTCHA"
const body = {
  invoiceNumber: uniqueNumber("EX-RETRY"),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  invoiceDate: nowIso,
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  payments: [
    {
      amount: totalsOf(lineItems).totalAmount,
      paymentType: "CASH",
      paymentDate: nowIso,
    },
  ],
  ...totalsOf(lineItems),
};

// (1) first POST — the original.
const first = await expectFiscalised(await fiscalise(body), "first POST");
printReceipt(first, "First POST (original)");

// (2) second POST — the SAME object, so the SAME body hash → cached replay.
const replay = await fiscalise(body);

const replayed = replay.headers?.get("idempotency-replayed") === "true";
const sameInvoice = replay.payload?.invoiceId === first.invoiceId;
const noNewPayment =
  (replay.payload?.paymentResults?.length ?? -1) ===
  first.paymentResults.length;

console.log("\nRetry result:");
console.log(
  `  Idempotency-Replayed header : ${replayed ? "true ✓" : "MISSING ✗"}`,
);
console.log(`  same invoiceId              : ${sameInvoice ? "✓" : "✗"}`);
console.log(`  no extra payment created    : ${noNewPayment ? "✓" : "✗"}`);

if (replayed && sameInvoice && noNewPayment) {
  console.log("\n✓ The retry was absorbed — exactly one invoice, one payment.");
} else {
  console.error(
    "\n✗ Expected a cached replay. A missing header means the two bodies differ\n" +
      "  (a fresh timestamp is the usual cause) or the 5-minute window elapsed.",
  );
  process.exit(1);
}
