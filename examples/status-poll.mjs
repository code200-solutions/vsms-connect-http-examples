#!/usr/bin/env node
// Extra: poll an invoice's status until every payment is terminal. Use after a
// POST that returned HTTP 202 (queued) — its statusUrl points here.
//   node --env-file=.env examples/status-poll.mjs <invoiceId>
import { pollUntilTerminal, printReceipt } from "./lib.mjs";

const [invoiceId] = process.argv.slice(2);
if (!invoiceId) {
  console.error(
    "Usage: node --env-file=.env examples/status-poll.mjs <invoiceId>",
  );
  process.exit(2);
}

const payload = await pollUntilTerminal(invoiceId);
printReceipt(payload, "Status (terminal)");
