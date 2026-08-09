// End-to-end acceptance suite for the VSMS Connect generic HTTP connector.
// Needs a running backend stack + an `http`-scoped API key in .env.
//
//   yarn test          (= node --env-file=.env --test "tests/*.test.mjs")
//
// Group 1 covers the 14 canonical V-SDC cases, named exactly to match the
// accreditation matrix. Group 2 adds extra wire coverage (GTIN, VAT0, split
// tender, proforma conversion, cancellation). Group 3 is the negative +
// idempotency checks.
//
// Tests run sequentially in file order and chain state through module-level
// variables (a refund needs the sale's fiscal number, a copy needs the
// refund's, etc.). Later tests fail fast with a clear message when a
// prerequisite step failed.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE,
  LOCATION_ID,
  cancel,
  ensureFiscalised,
  errorHaystack,
  fiscalise,
  firstFiscal,
  getStatus,
  makeCopy,
  makeInvoice,
  pollUntilTerminal,
  trigger,
  uniqueInvoiceNumber,
} from "./helpers.mjs";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// Advance-chain amounts: unitPrice 10000 × qty 3 → subtotal 30000, tax 4500,
// total 34500, split into 3 deposits of 11500. A deposit refund is a scaled
// self-contained body: unitPrice 10000 × qty 1 → total 11500.
const ADVANCE_UNIT = 10000;
const ADVANCE_QTY = 3;
const DEPOSIT_UNIT = 10000; // net; total 11500 with VAT15

// Chained state captured across the 14 cases (file order = execution order).
const captured = {
  normalSale: null, // { invoiceNumber, fiscal: { number, timestampMs } }
  normalSaleBuyer: null,
  normalRefund: null, // { fiscal }
  advanceSale: null,
  advanceSaleBuyer: null,
  proforma: null, // { invoiceNumber, fiscal }
  trainingSale: null,
};

function need(value, what) {
  assert.ok(value, `prerequisite missing: ${what} (an earlier test failed)`);
  return value;
}

// ── Connectivity + auth probe ───────────────────────────────────────────────

test("health: backend reachable, auth + scope valid (404 on zero UUID)", async () => {
  const health = await fetch(`${new URL(BASE).origin}/health`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(health.status < 400, `health endpoint HTTP ${health.status}`);

  // A deliberately nonexistent invoice: 404 proves the request passed the
  // API-key check (401 otherwise) and the scope check (403 otherwise).
  const probe = await getStatus(ZERO_UUID);
  assert.equal(probe.status, 404);
});

// ── Group 1: the 14 canonical V-SDC cases ───────────────────────────────────

test("01. Normal Sale", async () => {
  const body = makeInvoice();
  const payload = await ensureFiscalised(await fiscalise(body));
  const fiscal = firstFiscal(payload);
  assert.ok(fiscal?.number, "no fiscal number on the sale");
  assert.ok(Number.isFinite(fiscal.timestampMs), "fiscalTimestamp not numeric");
  captured.normalSale = { invoiceNumber: body.invoiceNumber, fiscal };
});

test("02. Normal Sale with buyer identification", async () => {
  const body = makeInvoice({ buyer: true });
  const payload = await ensureFiscalised(await fiscalise(body));
  const fiscal = firstFiscal(payload);
  assert.ok(fiscal?.number, "buyer sale did not fiscalise");
  captured.normalSaleBuyer = { invoiceNumber: body.invoiceNumber, fiscal };
});

test("03. Normal Refund", async () => {
  const src = need(captured.normalSale, "Normal Sale");
  // Refund reuses the sale's invoiceNumber (evolving-invoice model). The sale
  // has exactly one fiscalised payment, so the server resolves the source from
  // that invoiceNumber alone — no referentDocumentNumber needed (TAXCORE-639).
  // Test 04 keeps the explicit referent to cover the back-compatible path.
  const payload = await ensureFiscalised(
    await fiscalise(
      makeInvoice({
        invoiceNumber: src.invoiceNumber,
        transactionType: "REFUND",
      }),
    ),
  );
  const fiscal = firstFiscal(payload);
  assert.ok(fiscal?.number, "refund did not fiscalise");
  assert.notEqual(fiscal.number, src.fiscal.number);
  assert.equal(payload.invoiceNumber, src.invoiceNumber);
  captured.normalRefund = { fiscal };
});

test("04. Normal Refund with buyer identification", async () => {
  const src = need(captured.normalSaleBuyer, "Normal Sale with buyer");
  // Back-compatible path: pin the source payment by its SDC fiscal number.
  // referentDocumentNumber stays optional (TAXCORE-639) but still resolves.
  const payload = await ensureFiscalised(
    await fiscalise(
      makeInvoice({
        invoiceNumber: src.invoiceNumber,
        transactionType: "REFUND",
        referentDocumentNumber: src.fiscal.number,
        buyer: true,
      }),
    ),
  );
  assert.ok(firstFiscal(payload)?.number, "buyer refund did not fiscalise");
});

test("05. Advance Sale (deposit chain)", async () => {
  const body = makeInvoice({
    invoiceType: "ADVANCE",
    unitPrice: ADVANCE_UNIT,
    quantity: ADVANCE_QTY,
    advanceDeposits: 3,
  });
  const payload = await ensureFiscalised(await fiscalise(body));
  // Each deposit fiscalises as its own event; expect ≥1 fiscal number.
  const fiscal = firstFiscal(payload);
  assert.ok(fiscal?.number, "advance sale did not fiscalise");
  captured.advanceSale = { invoiceNumber: body.invoiceNumber, fiscal };
});

test("06. Advance Sale with buyer identification", async () => {
  const body = makeInvoice({
    invoiceType: "ADVANCE",
    unitPrice: ADVANCE_UNIT,
    quantity: ADVANCE_QTY,
    advanceDeposits: 3,
    buyer: true,
  });
  const payload = await ensureFiscalised(await fiscalise(body));
  const fiscal = firstFiscal(payload);
  assert.ok(fiscal?.number, "advance buyer sale did not fiscalise");
  captured.advanceSaleBuyer = { invoiceNumber: body.invoiceNumber, fiscal };
});

test("07. Advance Refund (refund one deposit)", async () => {
  const src = need(captured.advanceSale, "Advance Sale");
  // Refund the first deposit: self-contained body scaled to that deposit's
  // amount (11500), reusing the advance invoice number.
  const payload = await ensureFiscalised(
    await fiscalise(
      makeInvoice({
        invoiceNumber: src.invoiceNumber,
        invoiceType: "ADVANCE",
        transactionType: "REFUND",
        unitPrice: DEPOSIT_UNIT,
        referentDocumentNumber: src.fiscal.number,
      }),
    ),
  );
  assert.ok(firstFiscal(payload)?.number, "advance refund did not fiscalise");
});

test("08. Advance Refund with buyer identification", async () => {
  const src = need(captured.advanceSaleBuyer, "Advance Sale with buyer");
  const payload = await ensureFiscalised(
    await fiscalise(
      makeInvoice({
        invoiceNumber: src.invoiceNumber,
        invoiceType: "ADVANCE",
        transactionType: "REFUND",
        unitPrice: DEPOSIT_UNIT,
        referentDocumentNumber: src.fiscal.number,
        buyer: true,
      }),
    ),
  );
  assert.ok(
    firstFiscal(payload)?.number,
    "advance buyer refund did not fiscalise",
  );
});

test("09. Copy Sale", async () => {
  const src = need(captured.normalSale, "Normal Sale");
  const payload = await ensureFiscalised(
    await fiscalise(
      makeCopy({
        fiscalNumber: src.fiscal.number,
        fiscalTimestampMs: src.fiscal.timestampMs,
        transactionType: "SALE",
      }),
    ),
  );
  assert.ok(firstFiscal(payload)?.number, "copy sale did not fiscalise");
});

test("10. Copy Refund", async () => {
  const src = need(captured.normalRefund, "Normal Refund");
  const payload = await ensureFiscalised(
    await fiscalise(
      makeCopy({
        fiscalNumber: src.fiscal.number,
        fiscalTimestampMs: src.fiscal.timestampMs,
        transactionType: "REFUND",
      }),
    ),
  );
  assert.ok(firstFiscal(payload)?.number, "copy refund did not fiscalise");
});

test("11. Proforma Sale (quote → trigger → fiscalised)", async () => {
  const body = makeInvoice({
    invoiceType: "PROFORMA",
    paymentType: "WIRE_TRANSFER",
  });
  // A proforma is NOT auto-fiscalised: it comes back 201 with a triggerUrl.
  const quote = await fiscalise(body);
  assert.equal(quote.status, 201, "quote should be accepted, not dispatched");
  assert.ok(quote.payload.triggerUrl, "201 response should carry triggerUrl");

  const dispatched = await trigger(quote.payload.invoiceId);
  assert.ok(
    !dispatched.envelope.error,
    `trigger failed: ${dispatched.envelope.message}`,
  );
  const payload = await pollUntilTerminal(quote.payload.invoiceId);
  const fiscal = firstFiscal(payload);
  assert.ok(fiscal?.number, "quote did not fiscalise after trigger");
  captured.proforma = { invoiceNumber: body.invoiceNumber, fiscal };
});

test("12. Proforma Refund", async () => {
  const src = need(captured.proforma, "Proforma Sale");
  const payload = await ensureFiscalised(
    await fiscalise(
      makeInvoice({
        invoiceNumber: src.invoiceNumber,
        invoiceType: "PROFORMA",
        transactionType: "REFUND",
        paymentType: "WIRE_TRANSFER",
        referentDocumentNumber: src.fiscal.number,
      }),
    ),
  );
  assert.ok(firstFiscal(payload)?.number, "proforma refund did not fiscalise");
});

test("13. Training Sale", async () => {
  const body = makeInvoice({ training: true });
  const payload = await ensureFiscalised(await fiscalise(body));
  const fiscal = firstFiscal(payload);
  assert.ok(fiscal?.number, "training sale did not fiscalise");
  captured.trainingSale = { invoiceNumber: body.invoiceNumber, fiscal };
});

test("14. Training Refund", async () => {
  const src = need(captured.trainingSale, "Training Sale");
  const payload = await ensureFiscalised(
    await fiscalise(
      makeInvoice({
        invoiceNumber: src.invoiceNumber,
        transactionType: "REFUND",
        training: true,
        referentDocumentNumber: src.fiscal.number,
      }),
    ),
  );
  assert.ok(firstFiscal(payload)?.number, "training refund did not fiscalise");
});

// ── Group 2: additional wire coverage ───────────────────────────────────────

test("extra: sale with GTIN barcodes", async () => {
  const payload = await ensureFiscalised(
    await fiscalise(makeInvoice({ gtin: true })),
  );
  assert.ok(firstFiscal(payload)?.number, "GTIN sale did not fiscalise");
});

test("extra: zero-rated VAT0 sale (zero tax)", async () => {
  const body = makeInvoice({ taxCode: "VAT0" });
  assert.equal(body.taxAmount, 0);
  const payload = await ensureFiscalised(await fiscalise(body));
  assert.ok(firstFiscal(payload)?.number, "VAT0 sale did not fiscalise");
});

test("extra: split-tender sale (cash + card on one payment)", async () => {
  const payload = await ensureFiscalised(
    await fiscalise(makeInvoice({ splitTender: true })),
  );
  assert.ok(
    firstFiscal(payload)?.number,
    "split-tender sale did not fiscalise",
  );
});

test("extra: mixed-tax basket (VAT15 + VAT0 lines in one invoice)", async () => {
  const body = makeInvoice({ mixedTax: true });
  // Two tax categories in one basket: standard-rated 1000 (+150 tax) and
  // zero-rated 2×500 (no tax) → subtotal 2000, tax 150, total 2150.
  assert.equal(body.lineItems.length, 2);
  assert.equal(body.taxAmount, 150);
  const payload = await ensureFiscalised(await fiscalise(body));
  assert.ok(firstFiscal(payload)?.number, "mixed-tax basket did not fiscalise");
});

test("extra: mixed basket with split-tender payment (multi-tax + split payment)", async () => {
  // A realistic supermarket basket: three lines across two tax categories,
  // a buyer, and one payment split across cash + card.
  const body = makeInvoice({
    buyer: true,
    lines: [
      {
        description: "Coffee 250g",
        unitPrice: 500,
        quantity: 2,
        taxCode: "VAT15",
      },
      {
        description: "Bread (staple)",
        unitPrice: 300,
        quantity: 3,
        taxCode: "VAT0",
      },
      { description: "Imported cheese", unitPrice: 1200, taxCode: "VAT15" },
    ],
    splitTender: true,
  });
  const payload = await ensureFiscalised(await fiscalise(body));
  assert.ok(
    firstFiscal(payload)?.number,
    "mixed split-tender basket did not fiscalise",
  );
});

test("extra: proforma → NORMAL conversion via reference", async () => {
  const src = need(captured.proforma, "Proforma Sale");
  const payload = await ensureFiscalised(
    await fiscalise(
      makeInvoice({
        paymentType: "WIRE_TRANSFER",
        reference: src.invoiceNumber, // links the sale to the quote
      }),
    ),
  );
  assert.ok(firstFiscal(payload)?.number, "converted sale did not fiscalise");
});

test("extra: cancellation issues a counter-document", async () => {
  const payload = await ensureFiscalised(await fiscalise(makeInvoice()));
  const fiscal = firstFiscal(payload);
  const result = await cancel(fiscal.number);
  assert.ok(
    !result.envelope.error,
    `cancel failed: HTTP ${result.status} ${result.envelope.message}`,
  );
  assert.ok(result.payload.cancellationPaymentId);
});

test(
  "extra: sale to a specific location (multi-location)",
  { skip: LOCATION_ID ? false : "set VSMS_CONNECT_LOCATION_ID to run" },
  async () => {
    // The body locationId picks which location's certificate signs the sale.
    const payload = await ensureFiscalised(
      await fiscalise(makeInvoice({ locationId: LOCATION_ID })),
    );
    assert.ok(firstFiscal(payload)?.number, "location sale did not fiscalise");
  },
);

// ── Group 3: negative + idempotency checks ──────────────────────────────────

test("negative: line sums mismatching totals → 422 LINE_SUM_MISMATCH", async () => {
  const body = makeInvoice();
  body.totalAmount += 500; // break the reconciliation on purpose
  const result = await fiscalise(body);
  assert.equal(result.status, 422);
  assert.match(errorHaystack(result.envelope), /LINE_SUM_MISMATCH/);
});

test("negative: missing cashierId is rejected", async () => {
  const body = makeInvoice();
  delete body.cashierId;
  const result = await fiscalise(body);
  assert.ok(result.envelope.error, "cashierId-less body must be rejected");
  assert.match(errorHaystack(result.envelope), /cashier/i);
});

test("negative: out-of-range GTIN → GTIN_INVALID_LENGTH", async () => {
  const body = makeInvoice();
  body.lineItems[0].gtin = "1234"; // below the 8-char minimum
  const result = await fiscalise(body);
  assert.ok(result.envelope.error, "bad gtin must be rejected");
  assert.match(errorHaystack(result.envelope), /GTIN_INVALID_LENGTH/);
});

test("negative: refund for an unknown invoiceNumber → 404 INVOICE_NOT_FOUND", async () => {
  // Post-TAXCORE-639 a refund resolves its source from the reused invoiceNumber,
  // so a referent is no longer required. What IS still rejected is a refund whose
  // invoiceNumber matches no prior sale — there is nothing to refund against.
  const result = await fiscalise(
    makeInvoice({
      invoiceNumber: uniqueInvoiceNumber("E2E-NO-SOURCE"),
      transactionType: "REFUND",
    }),
  );
  assert.equal(result.status, 404);
  assert.match(errorHaystack(result.envelope), /INVOICE_NOT_FOUND/);
});

test("negative: body locationId outside the business → 422 LOCATION_NOT_FOUND", async () => {
  // A well-formed UUID that does not belong to this business.
  const result = await fiscalise(
    makeInvoice({ locationId: "00000000-0000-0000-0000-000000000000" }),
  );
  assert.equal(result.status, 422);
  assert.match(errorHaystack(result.envelope), /LOCATION_NOT_FOUND/);
});

test("negative: COPY without source → 422 INVALID_COPY_BODY", async () => {
  const result = await fiscalise({
    invoiceNumber: uniqueInvoiceNumber("E2E-COPY"),
    invoiceType: "COPY",
    transactionType: "SALE",
    cashierId: "e2e-suite",
  });
  assert.equal(result.status, 422);
  assert.match(errorHaystack(result.envelope), /INVALID_COPY_BODY/);
});

test("idempotency: byte-identical re-POST replays the cached response", async () => {
  const body = makeInvoice();
  const first = await fiscalise(body);
  const firstPayload = await ensureFiscalised(first);

  const replay = await fiscalise(body); // same body, same invoiceNumber
  assert.ok(!replay.envelope.error, "replay should not error");
  assert.equal(
    replay.payload.invoiceId,
    firstPayload.invoiceId,
    "replay must hit the same invoice, not create a duplicate",
  );
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
});
