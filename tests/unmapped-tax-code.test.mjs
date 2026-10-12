// An invoice carrying a tax code with NO confirmed mapping must arrive BLOCKED
// (HTTP 201, `MISSING_TAX_MAPPING`) and must never be dispatched. It is released
// later by mapping the code and running "Re-sync blocked invoices".
//
//   node --env-file=.env --test tests/unmapped-tax-code.test.mjs
//
// WHY THIS FILE EXISTS
//   On an INVOICE-BASIS business a sale may be sent with no `payments` at all.
//   The block used to be stamped only on the payments, so a payment-free sale
//   had nothing to carry it: the server dispatched the invoice with empty tax
//   labels, the consumer failed it ("line item has no confirmed V-SDC tax
//   label"), and it ended FAILED — a state the app cannot retry. The client saw
//   a 502 FISCAL_ERROR instead of a 201 with `fiscalisationBlockReasons`.
//
//   Cash basis was never affected (it requires payments, and the block survives
//   on them). That is asserted here too, as a guard against regressing it.
//
// WHAT RUNS WHERE
//   * Cases 1-3 need an INVOICE-basis business (VSMS_CONNECT_IB_BUSINESS_ID +
//     VSMS_CONNECT_IB_API_KEY, or a main business that is itself on invoice
//     basis — see examples/invoice-basis/README.md). On a cash-basis business
//     case 1 detects that and the IB cases skip rather than fail.
//   * Case 4 runs against the main (cash) credentials.
//   * Case 3 additionally needs `VAT15` and the suite's store code mapped on the
//     IB business, because it signs one real at-issue sale to edit.
//
// WHAT IT LEAVES BEHIND
//   Cases 1, 2 and 4 sign NOTHING — every invoice is blocked. Case 3 signs one
//   sale (the one it edits). Each run proposes a fresh `UNMAPPED-<timestamp>`
//   code, which will sit in the business's unmapped-tax-types list; map or
//   ignore it. The codes are unique per run so a re-run is never an
//   idempotent replay and the code is guaranteed unmapped.
//
// THE FIX UNDER TEST ships in the backend. Against a backend without it, case 1
// fails with HTTP 200/202/502 (the invoice was dispatched), not 201.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  declareTaxRates,
  fiscalise,
  getStatus,
  IB,
  pollUntilTerminal,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "../examples/lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A code no business has ever mapped — unique per run. */
const unmappedCode = () => `UNMAPPED-${Date.now().toString(36).toUpperCase()}`;

const reasonsOf = (paymentResult) =>
  [paymentResult.fiscalisationBlockReasons ?? []].flat().join(",");

/** The common sale body. Pass `payments` only when the case needs them. */
function saleBody({ invoiceNumber, lineItems, payments }) {
  return {
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    storeCode: STORE_CODE,
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "unmapped-tax-test",
    lineItems,
    ...(payments ? { payments } : {}),
    ...totalsOf(lineItems),
  };
}

function describe(result) {
  return `HTTP ${result.status} ${result.envelope.code ?? ""} ${result.envelope.message ?? ""}`.trim();
}

/**
 * Assert a POST answered "imported but BLOCKED on a missing tax mapping":
 * 201 (no job was created, so no sync wait), at least one payment result, none
 * of them signed or errored, and the block reason named.
 */
function assertBlockedOnMissingMapping(result, what) {
  assert.equal(
    result.status,
    201,
    `${what}: expected 201 (blocked, nothing dispatched) but got ${describe(result)}. ` +
      `200/202 means a job ran; 502 FISCAL_ERROR means it ran and failed.`,
  );
  assert.ok(!result.envelope.error, `${what}: ${describe(result)}`);
  const results = result.payload.paymentResults ?? [];
  assert.ok(results.length > 0, `${what}: no payment result came back`);
  for (const pr of results) {
    assert.equal(
      pr.fiscalInvoiceNumber,
      null,
      `${what}: an unmapped invoice was SIGNED (${pr.fiscalInvoiceNumber})`,
    );
    assert.notEqual(
      String(pr.status).toLowerCase(),
      "error",
      `${what}: payment is already in error`,
    );
    assert.equal(
      pr.eligibleForFiscalisation,
      false,
      `${what}: payment is eligible, so nothing stops it being dispatched`,
    );
    assert.match(
      reasonsOf(pr),
      /MISSING_TAX_MAPPING/,
      `${what}: block reasons were [${reasonsOf(pr)}]`,
    );
  }
}

/**
 * The original failure arrived asynchronously: the POST answered, then a job
 * failed a few seconds later and flipped the payment to `error`. So a clean
 * response alone proves little — keep reading the invoice back for a while and
 * fail the moment anything signs or errors.
 */
async function assertStaysBlocked(invoiceId, client, what, windowMs = 12_000) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const { status, envelope, payload } = await getStatus(invoiceId, client);
    assert.ok(!envelope.error, `${what}: status GET failed, HTTP ${status}`);
    for (const pr of payload.paymentResults ?? []) {
      assert.equal(
        pr.fiscalInvoiceNumber,
        null,
        `${what}: signed after the fact`,
      );
      assert.notEqual(
        String(pr.status).toLowerCase(),
        "error",
        `${what}: flipped to error after the POST (dispatched with empty labels)`,
      );
      assert.equal(pr.eligibleForFiscalisation, false, `${what}: unblocked`);
    }
    if (Date.now() >= deadline) return;
    await sleep(2000);
  }
}

let invoiceBasis = null; // null = not probed, true/false once case 1 has run

function requireInvoiceBasis(t) {
  if (invoiceBasis === false) {
    t.skip(
      "the invoice-basis business is on CASH basis — see this file's header",
    );
    return false;
  }
  assert.equal(
    invoiceBasis,
    true,
    "case 1 did not run, so the basis was never established",
  );
  return true;
}

// ── 1. The reported case: invoice basis, NO payments, unmapped code ─────────

test("1. invoice basis, no payments, declared-but-unmapped code → blocked, not dispatched", async (t) => {
  const code = unmappedCode();

  // The client's situation exactly: the code was DECLARED via /tax-rates (so it
  // sits in the unmapped list as a proposal) but never mapped to a V-SDC label.
  const declared = await declareTaxRates(
    [{ code, name: "Unmapped test code", rate: 0 }],
    IB,
  );
  assert.ok(!declared.envelope.error, `declare: ${describe(declared)}`);

  const body = saleBody({
    invoiceNumber: uniqueNumber("UT-IB"),
    lineItems: [vatLine("Unmapped item", 1000, 1, code)],
    // NO `payments` key — legal only on invoice basis.
  });
  const result = await fiscalise(body, IB);

  // A cash-basis business rejects a payment-free sale at the wire. That is the
  // only probe for the basis, so use it to skip rather than fail the IB cases.
  const wrongBasis =
    result.status === 422 &&
    (result.envelope?.validationErrors ?? []).some(
      (v) => v.field === "payments",
    );
  if (wrongBasis) {
    invoiceBasis = false;
    t.skip("the IB business is on CASH basis (payment-free sale rejected)");
    return;
  }
  invoiceBasis = true;

  assertBlockedOnMissingMapping(result, "payment-free sale");
  await assertStaysBlocked(result.payload.invoiceId, IB, "payment-free sale");
});

// ── 2. Same code, but WITH payments — the path that always worked ───────────

test("2. invoice basis, payments present, unmapped code → blocked (regression guard)", async (t) => {
  if (!requireInvoiceBasis(t)) return;

  const lineItems = [vatLine("Unmapped item", 1000, 1, unmappedCode())];
  const result = await fiscalise(
    saleBody({
      invoiceNumber: uniqueNumber("UT-IBP"),
      lineItems,
      payments: [
        {
          amount: totalsOf(lineItems).totalAmount,
          paymentType: "CASH",
          paymentDate: new Date().toISOString(),
        },
      ],
    }),
    IB,
  );

  assertBlockedOnMissingMapping(result, "sale with payments");
  await assertStaysBlocked(result.payload.invoiceId, IB, "sale with payments");
});

// ── 3. Invoice-basis EDIT: an added line carries an unmapped code ───────────

test("3. invoice-basis edit adding an unmapped-code line (no payments) → blocked, not dispatched", async (t) => {
  if (!requireInvoiceBasis(t)) return;

  const invoiceNumber = uniqueNumber("UT-IBE");
  const coffee = vatLine("Coffee 250g", 500, 2); // mapped code (VAT15)

  // The base sale must exist and be signed, or there is nothing to edit.
  const base = await fiscalise(
    saleBody({ invoiceNumber, lineItems: [coffee] }),
    IB,
  );
  // 201 = imported but blocked (VAT15 or the store code is not mapped yet);
  // 202 = still signing, so wait for it.
  if (base.envelope.error || base.status === 201) {
    t.skip(
      "the base sale did not sign — map VAT15 and the store code on the IB " +
        `business first (${describe(base)})`,
    );
    return;
  }
  const originalInvoiceId = base.payload.invoiceId;
  const signed =
    base.status === 202
      ? await pollUntilTerminal(originalInvoiceId, 120_000, IB)
      : base.payload;
  if (!signed.paymentResults?.some((pr) => pr.fiscalInvoiceNumber)) {
    t.skip(
      "the base sale did not reach a fiscal number, so there is nothing to edit",
    );
    return;
  }

  // Re-push with an extra line whose code nobody mapped, still no payments. The
  // total moved, so the difference is declared as a new chained document — and
  // that document must carry the block just like a fresh sale does.
  const extra = vatLine("Unmapped add-on", 345, 1, unmappedCode());
  const edit = await fiscalise(
    saleBody({ invoiceNumber, lineItems: [coffee, extra] }),
    IB,
  );
  assert.ok(!edit.envelope.error, `edit: ${describe(edit)}`);
  assert.notEqual(
    edit.payload.invoiceId,
    originalInvoiceId,
    "the edit changed the total, so it should have produced a new document",
  );

  assertBlockedOnMissingMapping(edit, "invoice-basis edit");
  await assertStaysBlocked(edit.payload.invoiceId, IB, "invoice-basis edit");
});

// ── 4. Cash basis was never affected — keep it that way ─────────────────────

test("4. cash basis (main credentials), unmapped code with a payment → blocked", async () => {
  const lineItems = [vatLine("Unmapped item", 1000, 1, unmappedCode())];
  const result = await fiscalise(
    saleBody({
      invoiceNumber: uniqueNumber("UT-CASH"),
      lineItems,
      payments: [
        {
          amount: totalsOf(lineItems).totalAmount,
          paymentType: "CASH",
          paymentDate: new Date().toISOString(),
        },
      ],
    }),
  );

  assertBlockedOnMissingMapping(result, "cash-basis sale");
  await assertStaysBlocked(
    result.payload.invoiceId,
    undefined,
    "cash-basis sale",
    6_000,
  );
});
