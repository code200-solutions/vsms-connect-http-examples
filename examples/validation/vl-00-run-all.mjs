#!/usr/bin/env node
// VL-00. Run every validation example and print a summary
// Each case runs in its own process; the exit code of the whole run is non-zero
// if any case did not behave as documented.
//   node --env-file=.env examples/validation/vl-00-run-all.mjs
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cases = readdirSync(here)
  .filter((f) => /^vl-\d\d-.*\.mjs$/.test(f) && f !== "vl-00-run-all.mjs")
  .sort();

const rows = [];
for (const file of cases) {
  console.log(`\n═══ ${file} ═══`);
  const r = spawnSync("node", ["--env-file=.env", join(here, file)], {
    stdio: "inherit",
  });
  rows.push([file, r.status === 0 ? "as documented" : "UNEXPECTED"]);
}

console.log("\n── Summary ──");
for (const [file, verdict] of rows)
  console.log(`  ${verdict.padEnd(14)} ${file}`);
process.exitCode = rows.some(([, v]) => v !== "as documented") ? 1 : 0;
