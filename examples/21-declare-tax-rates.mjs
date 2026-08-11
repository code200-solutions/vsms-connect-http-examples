#!/usr/bin/env node
// 21. Declare tax rates — the push equivalent of "list all tax rates".
//
// Unlike the OAuth connectors (Xero/Sage/MYOB) there is nothing for VSMS
// Connect to pull: it cannot reach into your system to enumerate your tax
// rates. So you declare them. Each code you send that isn't already mapped
// becomes a PROPOSAL a business admin confirms to a V-SDC label on the HTTP
// integration screen — BEFORE the first invoice arrives, so nothing blocks.
//
// Nothing here is ever auto-confirmed, and a caller can never change what its
// invoices are signed as. Re-declaring a code the admin already confirmed
// flags it for re-review if EITHER its rate OR its display name drifted
// (TAXCORE-646 — the mapping deactivates until an admin re-maps it).
//
// There are NO pre-seeded codes (TAXCORE-646): a fresh business has an empty
// mapping table, so even `VAT15`/`VAT0` must be declared and mapped before an
// invoice carrying them can sign. No integrator can skip this.
//   node --env-file=.env examples/21-declare-tax-rates.mjs
import { declareTaxRates } from "./lib.mjs";

// Your tax table. Three fields, mapped one-to-one onto the columns VSMS
// Connect stores them under (UnmappedTaxTypes / TaxRateMappings):
//
//   code  → ProviderTaxType : the code your invoice lines carry (`taxCode`).
//                             The key the admin maps to a V-SDC label. Required.
//   name  → ProviderTaxName : a human-readable label for that code, shown next
//                             to it in the admin panel. Optional — send a real
//                             name distinct from the code, NOT a restatement of
//                             the code or rate. Omit it and the column stays
//                             null (the panel just shows the code + rate).
//   rate  → ProviderRate    : the percent, for display only. Optional.
const taxRates = [
  { code: "VAT15", name: "Standard-rated VAT", rate: 15 },
  { code: "VAT0", name: "Zero-rated supplies", rate: 0 },
  { code: "EXCISE", name: "Excise duty", rate: 10 },
];

const { status, envelope, payload } = await declareTaxRates(taxRates);

if (envelope.error) {
  console.error(
    `✗ declare tax rates: HTTP ${status} ${envelope.code}: ${envelope.message}`,
  );
  for (const v of envelope.validationErrors ?? [])
    console.error(`    ${v.field}: ${v.message}`);
  process.exit(1);
}

console.log(`✓ Declared ${taxRates.length} tax code(s)`);
console.log(`  proposed (awaiting admin mapping): ${payload.proposed.length}`);
for (const p of payload.proposed)
  console.log(`    ${p.code} — ${p.name ?? "(no name)"} @ ${p.rate ?? "?"}%`);
console.log(`  already mapped:      ${payload.alreadyMapped}`);
console.log(`  drift → re-review:   ${payload.driftDetected}`);
console.log(`  names refreshed:     ${payload.nameRefreshed}`);

console.log(
  "\nNext: a business admin maps each proposed code to a V-SDC label on the " +
    "HTTP integration screen. Until a code is mapped, an invoice line using it " +
    "is accepted but blocked (MISSING_TAX_MAPPING) and shows up in the " +
    "unmapped-tax-types panel for the admin to resolve.",
);
