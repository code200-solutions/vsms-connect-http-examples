#!/usr/bin/env node
// 17. Multi-location — declare your own store codes, then fiscalise against one.
//
// Before TAXCORE-708 a multi-location integrator had exactly one way to say
// "this sale happened in Luganville": send VSMS Connect's own `locationId`
// GUID, handed over out of band, stored against every one of your stores. Same
// mistake the refund referent made, same fix — you send YOUR identifier and we
// resolve it:
//
//   POST /businesses/:businessId/stores      declare your store codes up front
//   GET  /businesses/:businessId/stores      read back what they resolve to
//   POST .../fiscalise  { storeCode: "..." } sign a sale at one of them
//
// `storeCode` and `locationId` are EXACTLY ONE OF THE TWO on a fiscalise body
// (422 LOCATION_SELECTOR_EXCLUSIVE if you send both — step 5 below). Sending
// NEITHER is the zero-config path: a single-location business never touches any
// of this and keeps resolving as it always has (the API key's location, then
// the business default).
//
// ROUTING FAILS CLOSED. If you send a `storeCode`, the sale signs at that
// store's certificate or it does not sign at all — it is never quietly signed
// at the API key's location instead. Two block reasons, because the admin's fix
// differs:
//
//   HTTP_STORE_NOT_MAPPED               the code is not mapped to a location
//   HTTP_STORE_LOCATION_NO_CERTIFICATE  mapped, but that location holds no cert
//
// A blocked invoice is still ACCEPTED and stored, and an unknown code is still
// raised as a proposal — you are told what happened via
// `fiscalisationBlockReasons`, not by losing the sale. Once the admin maps
// the store to a business location, they re-sync and everything waiting signs.
//
// This script walks the whole lifecycle end to end:
//   1. declare a set of store codes
//   2. read them back with their current status
//   3. fiscalise a sale against one of them
//   4. fiscalise against an UNDECLARED code — proposed, and BLOCKED
//   5. send both selectors at once — 422 LOCATION_SELECTOR_EXCLUSIVE
//
//   node --env-file=.env examples/17-multi-location.mjs
import {
  declareStores,
  listStores,
  fiscalise,
  expectFiscalised,
  firstFiscal,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

// Your store codes. `storeCode` is the only required field — it is YOUR key for
// the store (a branch code, a till group, whatever you already hold), capped at
// 100 chars to match the column it lands in. `name` / `street` / `city` are
// optional and exist purely so the admin reviewing the proposal can recognise
// the store; omit `name` and the code itself is shown instead.
const stores = [
  {
    storeCode: "STORE-PV-01",
    name: "Port Vila — Main Street",
    street: "Lini Highway",
    city: "Port Vila",
  },
  {
    storeCode: "STORE-LUG-01",
    name: "Luganville Branch",
    city: "Luganville",
  },
];

// A code deliberately NOT in the list above, to show step 4's behaviour. Fixed
// rather than randomised so a re-run proposes it once and then finds it already
// pending — repeating this script must not litter the admin's review queue.
const UNDECLARED_STORE = "STORE-UNDECLARED";

const fail = (label, { status, envelope }) => {
  console.error(
    `✗ ${label}: HTTP ${status} ${envelope.code}: ${envelope.message}`,
  );
  for (const v of envelope.validationErrors ?? [])
    console.error(`    ${v.field}: ${v.message}`);
  process.exit(1);
};

/**
 * Assert that every payment came back BLOCKED for `reason`.
 *
 * A blocked invoice is a 201 SUCCESS, not an error envelope — it was accepted
 * and stored, it just cannot be signed yet. So `expectFiscalised` would happily
 * return it and the script would print a cheerful line about a sale that never
 * signed. Checking the reason explicitly is what makes this example an actual
 * demonstration of the contract rather than a description of one.
 */
function expectBlocked(payload, reason, label) {
  const offenders = payload.paymentResults.filter(
    (p) => !(p.fiscalisationBlockReasons ?? []).includes(reason),
  );
  if (offenders.length > 0) {
    console.error(
      `✗ ${label}: expected every payment blocked with ${reason}, got ` +
        offenders
          .map(
            (p) =>
              `${p.status}${(p.fiscalisationBlockReasons ?? []).length ? ` [${p.fiscalisationBlockReasons.join(", ")}]` : ""}`,
          )
          .join(", ") +
        "\n  This backend build may predate TAXCORE-718 (store routing failed OPEN,\n" +
        "  signing at the API key's location instead of blocking).",
    );
    process.exit(1);
  }
  return payload;
}

// ── 1. Declare the store codes ──────────────────────────────────────────────
//
// Idempotent by construction: the declaration is keyed on your code and NEVER
// overwrites an existing row, so re-declaring is a no-op and an admin's edits
// always win. That is also why there is no drift handling here (unlike the tax
// rates in example 21) — a renamed store is cosmetic, whereas a drifted tax
// RATE would change what an invoice is signed as.

const declared = await declareStores(stores);
if (declared.envelope.error) fail("declare stores", declared);

console.log(`✓ Declared ${declared.payload.declared} store code(s)`);
console.log(
  `  newly proposed (awaiting an admin): ${declared.payload.proposed.length ? declared.payload.proposed.join(", ") : "—"}`,
);
console.log(
  `  already known:                     ${declared.payload.alreadyKnown.length ? declared.payload.alreadyKnown.join(", ") : "—"}`,
);

// ── 2. Read back what those codes resolve to ────────────────────────────────

const listed = await listStores();
if (listed.envelope.error) fail("list stores", listed);

console.log("\n✓ Your store codes on this business:");
for (const s of listed.payload.stores)
  console.log(
    `  ${s.storeCode.padEnd(20)} ${String(s.status).padEnd(9)} ${s.name ?? "(no name)"}`,
  );
if (listed.payload.stores.length === 0)
  console.log("  (none — the declaration above should have created them)");

// `locationId` is in each row deliberately: a caller that already stores our
// GUID keeps working, and a caller that doesn't never has to learn it. It is
// the field this endpoint exists to make OPTIONAL, not one to hide.

// ── 3. Fiscalise a sale against one of your codes ───────────────────────────
//
// Only a MAPPED store routes. An unmapped code is not an
// admin decision yet, so signing at it would be us guessing which location's
// certificate the sale belongs to — and guessing is exactly what fail-closed
// exists to stop. The sale is stored and BLOCKED instead, until the store is
// mapped.

const mapped = listed.payload.stores.find((s) => s.status === "mapped");
const target = mapped?.storeCode ?? stores[0].storeCode;

if (!mapped) {
  console.log(
    `\n⚠ No store code is mapped yet — using "${target}", which is NOT MAPPED yet.\n` +
      "  The sale below will be ACCEPTED AND BLOCKED (HTTP_STORE_NOT_MAPPED), not signed\n" +
      "  at some other location. To release it: an admin maps the store to a business\n" +
      "  location on the Generic HTTP screen (Stores tab), then presses “Re-sync\n" +
      "  blocked invoices” — this sale then signs at that location's certificate, no re-send.",
  );
}

const saleLines = [vatLine("Branch sale item", 1000, 1)];
const sale = {
  invoiceNumber: uniqueNumber("EX-STORE"),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  storeCode: target, // ← YOUR code. No GUID anywhere in this body.
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems: saleLines,
  payments: [
    {
      amount: totalsOf(saleLines).totalAmount,
      paymentType: "CASH",
      paymentDate: new Date().toISOString(),
    },
  ],
  ...totalsOf(saleLines),
};

const salePayload = await expectFiscalised(
  await fiscalise(sale),
  `sale to store ${target}`,
);
// Accepted store → it signs. Still a proposal → it is blocked, and saying so is
// the whole point: this is the state a real integration meets first.
if (!mapped)
  expectBlocked(
    salePayload,
    "HTTP_STORE_NOT_MAPPED",
    `sale to unmapped store ${target}`,
  );
report(`Sale with storeCode "${target}"`, salePayload);

// ── 4. An UNDECLARED code — proposed, and blocked ───────────────────────────
//
// This is the rule most worth knowing before production, and it has two halves
// that are easy to conflate:
//
//   * The invoice is NOT rejected. For a push connector an incoming invoice is
//     the only discovery event there is, so a 4xx would make the code
//     undiscoverable AND lose a real sale over a configuration gap. It is
//     accepted, stored, and the code is raised as a proposal for the admin.
//   * The invoice is NOT signed either. It is blocked with
//     HTTP_STORE_NOT_MAPPED until the admin maps the store to a location.
//
// So it behaves exactly like an unmapped `taxCode` (example 22): accepted on
// the wire, surfaced for review, and blocking until resolved. Handle it the
// same way — read `fiscalisationBlockReasons`, do not assume a fiscal number.
// (A code the admin already REJECTED is not re-proposed — that decision sticks,
// and invoices carrying it keep blocking.)

const unknownLines = [vatLine("Sale from an unknown store", 1000, 1)];
const unknownSale = {
  ...sale,
  invoiceNumber: uniqueNumber("EX-STORE-NEW"),
  storeCode: UNDECLARED_STORE,
  lineItems: unknownLines,
  payments: [
    {
      amount: totalsOf(unknownLines).totalAmount,
      paymentType: "CASH",
      paymentDate: new Date().toISOString(),
    },
  ],
  ...totalsOf(unknownLines),
};

const unknownPayload = expectBlocked(
  await expectFiscalised(
    await fiscalise(unknownSale),
    `sale with undeclared storeCode ${UNDECLARED_STORE}`,
  ),
  "HTTP_STORE_NOT_MAPPED",
  `sale with undeclared storeCode ${UNDECLARED_STORE}`,
);
report(`Sale with UNDECLARED storeCode "${UNDECLARED_STORE}"`, unknownPayload);

const after = await listStores();
if (!after.envelope.error) {
  const proposed = after.payload.stores.find(
    (s) => s.storeCode === UNDECLARED_STORE,
  );
  console.log(
    proposed
      ? `  → "${UNDECLARED_STORE}" is now on the list as "${proposed.status}" — discovered from the invoice, awaiting an admin.`
      : `  → "${UNDECLARED_STORE}" is not on the list (an admin has rejected it — a rejection is never re-proposed).`,
  );
}

// ── 5. Both selectors at once → 422 LOCATION_SELECTOR_EXCLUSIVE ─────────────
//
// Two ways to say the same thing must never travel together: whichever one we
// silently preferred would be a rule you could not see. Same rule a line item's
// `taxCode` / `taxLabel` pair follows.

const conflicting = {
  ...unknownSale,
  invoiceNumber: uniqueNumber("EX-STORE-BOTH"),
  storeCode: target,
  locationId: "00000000-0000-0000-0000-000000000000",
};

const rejected = await fiscalise(conflicting);
if (rejected.envelope.error && rejected.status === 422) {
  console.log(
    `\n✓ Both selectors at once → HTTP 422 ${rejected.envelope.code}, as designed:`,
  );
  for (const v of rejected.envelope.validationErrors ?? [])
    console.log(`    ${v.field}: ${v.message}`);
} else {
  console.error(
    `\n✗ Expected 422 LOCATION_SELECTOR_EXCLUSIVE for storeCode + locationId, got HTTP ${rejected.status}.` +
      "\n  This backend build may predate TAXCORE-708.",
  );
  process.exit(1);
}

console.log(
  "\nNext: an admin reviews the proposed stores on the app's Generic HTTP screen (Stores\n" +
    "tab), maps the real ones to a business location, and presses “Re-sync blocked\n" +
    "was blocked on those stores signs then — at that store's own certificate, with no\n" +
    "re-send from you. Compare the `signedBy` segment of the fiscal numbers to see the\n" +
    "routing. Nothing else in your integration changes: you keep sending your own codes.\n" +
    "\nIf a sale stays blocked with HTTP_STORE_LOCATION_NO_CERTIFICATE instead, the store\n" +
    "was mapped but that location holds no certificate — that is the admin's other fix.",
);

/** One compact line per payment — printing two full journals would drown the run. */
function report(label, payload) {
  console.log(`\n✓ ${label} — invoiceId ${payload.invoiceId ?? "—"}`);
  const f = firstFiscal(payload);
  for (const p of payload.paymentResults) {
    let line = `  payment ${p.invoicePaymentId}: ${p.status} — ${p.fiscalInvoiceNumber ?? "—"}`;
    if (p.status !== "fiscalised") {
      const reasons = p.fiscalisationBlockReasons ?? [];
      if (reasons.length > 0) line += `  [blocked: ${reasons.join(", ")}]`;
      else if (p.eligibleForFiscalisation === true)
        line += "  [eligible — awaiting fiscalise]";
    }
    console.log(line);
  }
  // An SDC fiscal number is `requestedBy-signedBy-counter`, and `signedBy`
  // identifies the CERTIFICATE that signed it — the observable proof of which
  // location a sale was routed to. Printed separately (when the number has that
  // shape) so two sales can be compared at a glance.
  const parts = f ? f.number.split("-") : [];
  if (parts.length === 3) console.log(`  signedBy: ${parts[1]}`);
}
