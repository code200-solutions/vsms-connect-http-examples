#!/usr/bin/env node
// Per-case dispatcher: `yarn case <n|name>` runs the matching example script.
//
//   yarn case 7                 → examples/07-advance-refund.mjs
//   yarn case 07                → same
//   yarn case advance-refund    → same (name substring)
//   yarn case mixed             → examples/sale-mixed.mjs
//   yarn case cancel <fiscalNo> → examples/cancel.mjs <fiscalNo> (extra args pass through)
//   yarn case --list            → list the available cases
//
// The target runs in a child `node --env-file=.env` so its own process.argv
// (used by cancel/status-poll) and env are exactly as if invoked directly.

import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const examplesDir = dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(examplesDir)
  .filter((f) => f.endsWith(".mjs") && f !== "lib.mjs" && f !== "run.mjs")
  .sort();

const [selector, ...rest] = process.argv.slice(2);

function list() {
  console.log("Available cases (run: yarn case <n|name>):\n");
  for (const f of scripts) console.log(`  ${f.replace(/\.mjs$/, "")}`);
}

if (!selector || selector === "--list" || selector === "-l") {
  list();
  process.exit(selector ? 0 : 2);
}

// Numeric selector → match the NN- prefix (zero-padded); otherwise substring.
const isNumeric = /^\d{1,2}$/.test(selector);
const key = isNumeric ? selector.padStart(2, "0") : selector.toLowerCase();
const matches = scripts.filter((f) =>
  isNumeric ? f.startsWith(`${key}-`) : f.toLowerCase().includes(key),
);

if (matches.length === 0) {
  console.error(`No example matches "${selector}".\n`);
  list();
  process.exit(2);
}
if (matches.length > 1) {
  console.error(`"${selector}" is ambiguous — matches: ${matches.join(", ")}`);
  process.exit(2);
}

const target = join(examplesDir, matches[0]);
console.error(`▶ ${matches[0]}\n`);
const child = spawn("node", ["--env-file=.env", target, ...rest], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
