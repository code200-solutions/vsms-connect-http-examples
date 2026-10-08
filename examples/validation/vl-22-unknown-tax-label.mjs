#!/usr/bin/env node
// VL-22. A raw tax label V-SDC does not publish → payment FAILS before V-SDC (TAX_LABEL_UNKNOWN)
// taxLabel is the escape hatch that skips tax-code mapping. The connector only
// checks its SHAPE (the label set is the authority's and can change), so the
// invoice is accepted and queued. The consumer then checks it against the
// business's own V-SDC /status labels and, in enforce mode, stops the payment
// BEFORE any V-SDC call: status 'error', not retryable, circuit breaker untouched.
//
// Needs VSDC_VALIDATION_MODE=enforce on the CONSUMER. The Q label is assumed
// not to exist for your business; change it if it does.
//   node --env-file=.env examples/validation/vl-22-unknown-tax-label.mjs
import {
  expectFiscalised,
  fiscalise,
  showPayments,
  validSaleBody,
} from "../lib.mjs";

const body = validSaleBody("VL22");
delete body.lineItems[0].taxCode;
body.lineItems[0].taxLabel = "Q"; // <- not a label of this business's V-SDC group

const result = await fiscalise(body);
const payload = await expectFiscalised(result, "VL-22 unknown tax label");
showPayments(payload);

const stopped = (payload.paymentResults ?? []).every(
  (p) => String(p.status).toLowerCase() === "error" && !p.fiscalInvoiceNumber,
);
console.log(
  stopped
    ? "\n✓ Payment errored without a fiscal number. Confirm it was the PRE-FLIGHT\n" +
        "  (consumer log '[VsdcPreflight] … TAX_LABEL_UNKNOWN', InvoicePayments.IsRetryable = 0),\n" +
        "  not a V-SDC rejection."
    : "\n✗ The payment did not stop. Either the consumer is not in enforce mode,\n" +
        "  or label Q exists for this business.",
);
process.exitCode = stopped ? 0 : 1;
