// node extension/naming.selftest.js
// 3.6 dropped the prefix MoonDigest inherited from upstream. Fails when it shows up again in extension/, docs/ or README.md.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const OLD = /boc/i;
// file ("*" for any) → text that may still contain it.
const ALLOWED = [
  ["extension/limits.js", "boc_"], // the migration's old key prefix
  ["extension/limits.selftest.js", "boc_"], // the migration test's old keys
  ["extension/history/history.selftest.js", "boc_"], // 摘读记录 runs the migration on load
  ["extension/content.js", "boc-content-superseded"], // a 3.5.x copy in an open tab stands down on it; remove after 3.6
  ["*", "bnjihpbocpimaipifanfkjjpfdbigggd"] // the Chrome Web Store extension id
];
const TEXT = /\.(js|mjs|css|html|json|md|svg|txt|py|sh|yml)$/;

// Paths from the repository root. Only the three scanned places are walked, not the whole checkout (worktrees, big untracked folders).
const { walk } = require("./page-sources.selftest.js");
const files = [...walk("../extension"), ...walk("../docs"), "../README.md"].map((f) => f.slice("../".length)).filter((f) => TEXT.test(f));
assert.ok(files.includes("extension/content.js") && files.includes("docs/ARCHITECTURE.md"), `scanned ${files.length} files`);

const self = "extension/naming.selftest.js";
for (const file of files.filter((f) => f !== self)) {
  let text = fs.readFileSync(path.join(root, file), "utf8");
  for (const [where, allowed] of ALLOWED) if (where === "*" || where === file) text = text.split(allowed).join("");
  const line = text.split("\n").findIndex((l) => OLD.test(l));
  assert.strictEqual(line, -1, `${file}:${line + 1} still uses the upstream prefix; use mdg / Mdg / MDG`);
}

console.log("naming selftest ok");
