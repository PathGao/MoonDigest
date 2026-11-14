// Runs every selftest one after another and stops at the first failure: the one command CI and README give, on every OS
// (a shell loop does not run in PowerShell). The tests run on the node that runs this file.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ext = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const tests = ["", "triage", "history", "agent-sites"].flatMap((dir) =>
  fs.readdirSync(path.join(ext, dir)).filter((f) => f.endsWith(".selftest.js")).sort().map((f) => path.join(ext, dir, f))
);
for (const test of tests) {
  const run = spawnSync(process.execPath, [test], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
  process.stdout.write(run.stdout);
  // Node exits 0 when a test is left awaiting something that never comes, so a test has passed only once it says so
  // on its last line.
  const said = /\b(ok|passed|checked)\b/.test(run.stdout.trimEnd().split("\n").pop());
  if (run.status !== 0 || !said) {
    console.error(`failed: ${path.relative(ext, test)}${run.status === 0 ? " (it stopped before its last line)" : ""}`);
    process.exit(1);
  }
}
console.log(`${tests.length} selftests ok`);
