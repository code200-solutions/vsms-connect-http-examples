#!/usr/bin/env node
// 23. Retrieve an invoice by its VSMS Connect invoiceId — a single GET against
// GET /api/v1/businesses/:businessId/fiscalise/:invoiceId. This is the only
// retrieval endpoint: lookup is by the server-issued invoiceId GUID (echoed in
// every POST response, NOT your invoiceNumber and NOT the SDC fiscal number).
//
// Unlike status-poll.mjs (which LOOPS until every payment is terminal, so it
// hangs on a non-terminal `imported` invoice) this fetches the CURRENT state
// once and prints it — including the TAXCORE-645 eligibility / block-reason
// fields, so a still-`imported` invoice shows why it hasn't signed.
//   node --env-file=.env examples/23-get-invoice.mjs <invoiceId>
import { getStatus, printReceipt } from "./lib.mjs";

const [invoiceId] = process.argv.slice(2);
if (!invoiceId) {
  console.error(
    "Usage: node --env-file=.env examples/23-get-invoice.mjs <invoiceId>",
  );
  process.exit(2);
}

const { status, envelope, payload } = await getStatus(invoiceId);
if (envelope.error) {
  // 404 INVOICE_NOT_FOUND when the id is unknown (or belongs to another
  // business — the key is business-scoped, so you can never read across).
  console.error(
    `✗ get invoice ${invoiceId}: HTTP ${status} ${envelope.code}: ${envelope.message}`,
  );
  process.exit(1);
}
printReceipt(payload, `Invoice ${invoiceId}`);
