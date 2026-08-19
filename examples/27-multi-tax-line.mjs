#!/usr/bin/env node
// 27. Several taxes on ONE line item — pass an ARRAY to `taxCode`.
//
// An item can be liable for more than one tax at the same time: VAT plus a
// levy, an excise plus VAT, and so on. In the TaxCore model a label identifies
// one RATE inside one CATEGORY, and an item may carry at most one label per
// category — so "VAT 15% and ECAL 10% on this bottle" is two labels on one line,
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
  declareTaxRates,
  expectFiscalised,
  fiscalise,
  printReceipt,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

// The second tax this example attaches alongside VAT15, and the rate it really
// carries. `taxCode` is YOUR vocabulary, so there is no universal second code —
// pass your own as an argument.
//
// The default pairs a 15% VAT with a 2% levy because those are two DIFFERENT
// tax categories in the Vanuatu sandbox (VAT -> label D, TOTL -> label T). That
// matters: a label identifies one rate inside one category, and an item may
// carry at most one label per category, so both codes must map to labels from
// different categories. Two codes that resolve to the SAME label produce a line
// carrying e.g. ["D","D"], which V-SDC rejects outright (502 FISCAL_ERROR).
const SECOND_TAX_CODE = process.argv[2] ?? "TOTL";
const SECOND_TAX_RATE = Number(process.argv[3] ?? 2);
const VAT_RATE = 15;

// Note there is no bespoke line builder here: `vatLine` from lib.mjs — the
// same helper every other example uses — already takes an array, because the
// wire field does. Adding a second tax to a line is putting its existing code
// in brackets, nothing more.
const lineItems = [
  // TWO taxes on one item.
  vatLine(
    "Imported spirits 700ml",
    4500,
    1,
    ["VAT15", SECOND_TAX_CODE],
    null,
    VAT_RATE + SECOND_TAX_RATE, // the line bears BOTH, so state both
  ),
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

// ── Declare both codes WITH THEIR REAL RATES, before sending anything ──────
//
// Not politeness — this is what stops the second code being mis-mapped. A code
// discovered from an invoice is recorded at the line's single
// `taxRatePercent`, and the mapping panel suggests a label by matching that
// rate. So a 17% line carrying VAT15 + a 2% levy would record the levy at 17%
// and invite an admin to map it to the 15% VAT label — at which point BOTH
// codes resolve to the same label, and V-SDC rejects the invoice outright.
//
// Declaring states each code's own rate, so each gets the right suggestion.
const declared = await declareTaxRates([
  { code: "VAT15", name: "Standard-rated VAT", rate: VAT_RATE },
  {
    code: SECOND_TAX_CODE,
    name: `${SECOND_TAX_CODE} levy`,
    rate: SECOND_TAX_RATE,
  },
]);
if (declared.envelope.error) {
  console.error(
    `! declare tax rates: HTTP ${declared.status} ${declared.envelope.code}: ${declared.envelope.message}`,
  );
}

console.log(
  `Sending one line with taxCode: ["VAT15", "${SECOND_TAX_CODE}"]
` +
    `  VAT15 @${VAT_RATE}% + ${SECOND_TAX_CODE} @${SECOND_TAX_RATE}% = ${VAT_RATE + SECOND_TAX_RATE}% on that line.
` +
    `  Map each code to a label from a DIFFERENT tax category (e.g. VAT -> D,
` +
    `  TOTL -> T). Two codes on one line resolving to the SAME label make
` +
    `  V-SDC reject the invoice.
` +
    `  (your own code + rate: yarn case 27 MY-LEVY 2)
`,
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
