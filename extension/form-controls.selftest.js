// node extension/form-controls.selftest.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

// vendor/: third-party code, not our pages.
const files = require("./page-sources.selftest.js").walk(".", (d) => d === "vendor").filter((f) => /\.(html|js)$/.test(f) && !f.endsWith(".selftest.js"));

const missing = [];
for (const file of files) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  for (const match of source.matchAll(/<(?:input|select|textarea)\b(?:\$\{[^}]*\}|[^>])*>/g)) {
    if (/\s(?:id|name)\s*=/.test(match[0])) continue;
    const line = source.slice(0, match.index).split("\n").length;
    missing.push(`${file}:${line}`);
  }
}

assert.deepStrictEqual(missing, [], `form controls need an id or name:\n${missing.join("\n")}`);
console.log(`form-controls selftest: checked ${files.length} files`);
