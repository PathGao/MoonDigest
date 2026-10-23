// Runs every selftest one after another and stops at the first failure: the one command CI and README give, on every OS
// (a shell loop does not run in PowerShell). The tests run on the node that runs this file.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ext = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const tests = ["", "triage", "history"].flatMap((dir) =>
  fs.readdirSync(path.join(ext, dir)).filter((f) => f.endsWith(".selftest.js")).sort().map((f) => path.join(ext, dir, f))
);
for (const test of tests) {
  if (spawnSync(process.execPath, [test], { stdio: "inherit" }).status !== 0) {
    console.error(`failed: ${path.relative(ext, test)}`);
    process.exit(1);
  }
}
console.log(`${tests.length} selftests ok`);
