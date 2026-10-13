// node extension/form-controls.selftest.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(html|js)$/.test(entry.name) && !entry.name.endsWith(".selftest.js")) files.push(file);
  }
};
walk(__dirname);

const missing = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) {
    if (/\s(?:id|name)\s*=/.test(match[0])) continue;
    const line = source.slice(0, match.index).split("\n").length;
    missing.push(`${path.relative(__dirname, file).split(path.sep).join("/")}:${line}`);
  }
}

assert.deepStrictEqual(missing, [], `form controls need an id or name:\n${missing.join("\n")}`);
console.log(`form-controls selftest: checked ${files.length} files`);
