// /usr/local/bin/node extension/load-order.selftest.js
// Every runtime (each manifest content_scripts entry, the worker's importScripts chain, every extension page) loads
// the file that defines a global before any file that reads it, and every script it names exists. common.js is first
// everywhere, so a file may use MdgCommon without checking which runtime loads it.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const files = [];
const pages = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith(".html")) pages.push(rel);
    else if (e.name.endsWith(".js") && !e.name.endsWith(".selftest.js")) files.push(rel);
  }
};
walk(".");

// Globals: whatever a file publishes as globalThis.X = ...
const definedBy = {};
for (const f of files) for (const m of read(f).matchAll(/globalThis\.([A-Z]\w+)\s*=/g)) definedBy[m[1]] ??= f;
for (const g of ["MdgCommon", "MdgLimits", "MdgErrors", "MdgSettings", "MdgSites", "MdgTagCore", "MdgSurfaces", "MdgNote", "MdgTyping", "MdgDownload", "MdgOverwriteDialog", "TriageUi", "TriageCore", "MoonTriage", "TagPicker", "TagDialogs"]) {
  assert.ok(definedBy[g], `no file defines ${g}`);
}
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const usesOf = (f) => Object.keys(definedBy).filter((g) => definedBy[g] !== f && new RegExp(`\\b${g}\\b`).test(code(f)));

const runtimes = [];
const manifest = JSON.parse(read("manifest.json"));
manifest.content_scripts.forEach((c, i) => runtimes.push([`content_scripts[${i}] (${c.js.at(-1)})`, c.js]));
// The worker runs the first importScripts list before background.js's own top level.
const calls = [...read("background.js").matchAll(/importScripts\(([^)]*)\)/g)].map((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
runtimes.push(["background importScripts", [...calls[0], "background.js", ...calls.slice(1).flat()]]);
for (const page of pages) {
  runtimes.push([page, [...read(page).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.normalize(path.join(path.dirname(page), m[1])))]);
}
assert.ok(runtimes.length >= 11, `found ${runtimes.length} runtimes`);

// The worker loads triage/shared.js for its pure helpers; the DOM bindings that read MdgTyping never run there.
const exempt = new Set(["background importScripts|triage/shared.js|MdgTyping"]);
let checked = 0;
for (const [where, list] of runtimes) {
  assert.strictEqual(list[0], "common.js", `${where} loads common.js first`);
  list.forEach((f, i) => {
    assert.ok(fs.existsSync(path.join(__dirname, f)), `${where} loads ${f}, which does not exist`);
    for (const g of usesOf(f).filter((g) => !exempt.has(`${where}|${f}|${g}`))) {
      const at = list.indexOf(definedBy[g]);
      assert.ok(at >= 0 && at < i, `${where}: ${f} reads ${g}, so ${definedBy[g]} must load before it`);
      checked++;
    }
  });
}
assert.ok(checked > 40, `checked ${checked} reads`);
console.log("load-order selftest ok");
