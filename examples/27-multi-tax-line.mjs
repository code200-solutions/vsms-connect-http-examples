#!/usr/bin/env node
// 27. Several taxes on ONE line item — pass an ARRAY to `taxCode`.
//
// An item can be liable for more than one tax at the same time: VAT plus a
// levy, an excise plus VAT, and so on. In the TaxCore model a label identifies
// one RATE inside one CATEGORY, and an item may carry at most one label per
// category — so "VAT 15% and ECAL 5% on this bottle" is two labels on one line,
// not two lines.
//
//   node --env-file=.env examples/27-multi-tax-line.mjs
//
// ── The part that surprises people ──────────────────────────────────────────
//
// You do NOT compute the combined tax. V-SDC does, from the labels and the item
// total, and its figures are the ones on the receipt. That is not a division of
// labour we chose — it is the only place the arithmetic can be correct:
//
//   • a "tax on total" category charges its rate on the item total INCLUDING
//     the other taxes on that same line, so its amount depends on what else is
//     attached to the line;
//   • an "amount per quantity" category is a fixed sum per unit, and the other
//     taxes on the line are then computed on the remainder.
//
// So the amounts are only right when every label on the line is resolved
// together. `taxRatePercent` and the per-line tax amounts you send are used for
// reconciliation and display on our side — never to sign the receipt.
//
// ── Prerequisite ────────────────────────────────────────────────────────────
//
// EVERY code you send must already be mapped by an admin. If even one of them
// is not, the line is blocked with MISSING_TAX_MAPPING and NOTHING is signed —
// deliberately, because attaching only the mapped subset would produce a
// receipt that looks successful and under-reports tax. This example therefore
// prints the block reasons rather than pretending, if the second code has not
// been mapped on your business yet.
import {
  expectFiscalised,
  fiscalise,
  printReceipt,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

// The second tax this example attaches alongside VAT15. Change it to a code
// your business actually has mapped — there is no universal second code, since
// `taxCode` is your own vocabulary (see 21-declare-tax-rates.mjs).
const SECOND_TAX_CODE = process.argv[2] ?? "ECAL";

// Note there is no bespoke line builder here: `vatLine` from lib.mjs — the
// same helper every other example uses — already takes an array, because the
// wire field does. Adding a second tax to a line is putting its existing code
// in brackets, nothing more.
const lineItems = [
  // TWO taxes on one item.
  vatLine("Imported spirits 700ml", 4500, 1, ["VAT15", SECOND_TAX_CODE]),
  // A plain single-tax line beside it — the two forms mix freely within one
  // invoice. What you cannot do is put `taxCode` AND `taxLabel` on one line.
  vatLine("Tonic water 1L", 400, 2, "VAT15"),
];

const totals = totalsOf(lineItems);

const body = {
  invoiceNumber: uniqueNumber("EX-MULTITAX"),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  payments: [
    {
      amount: totals.totalAmount,
      paymentType: "CASH",
      paymentDate: new Date().toISOString(),
    },
  ],
  ...totals,
};

console.log(
  `Sending one line with taxCode: ["VAT15", "${SECOND_TAX_CODE}"]\n` +
    `(pass a different second code as an argument: yarn case 27 MY-LEVY)\n`,
);

const result = await fiscalise(body);

// A blocked invoice is a 201 SUCCESS envelope, not an error — so checking the
// HTTP status alone would report a pass here. Read the per-payment flags.
const blocked = (result.payload?.paymentResults ?? []).flatMap(
  (p) => p.fiscalisationBlockReasons ?? [],
);

if (blocked.includes("MISSING_TAX_MAPPING")) {
  console.log(
    `\n⚠ Accepted but BLOCKED: ${blocked.join(", ")}\n` +
      `\nOne of the codes on the line is not mapped yet — most likely\n` +
      `'${SECOND_TAX_CODE}'. Note that NOTHING was signed: the whole line is\n` +
      `held rather than being signed with only the mapped subset, which would\n` +
      `have under-reported the tax while looking like a success.\n` +
      `\nDeclare it with 21-declare-tax-rates.mjs, have an admin map it on the\n` +
      `Generic HTTP screen, then re-send (or use the admin's "Re-sync blocked\n` +
      `invoices" button to release this one in place).`,
  );
  process.exit(0);
}

const payload = await expectFiscalised(result);
printReceipt(payload, "Multi-tax sale");

console.log(
  "\nThe tax table on the receipt above is V-SDC's, computed from the labels\n" +
    "we attached — not from the taxRatePercent this script sent.",
);
