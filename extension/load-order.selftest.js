// /usr/local/bin/node extension/load-order.selftest.js
// Every runtime (each manifest content_scripts entry, the worker's importScripts chain, every extension page) loads
// the file that defines a global before any file that reads it, and every script it names exists. common.js is first
// everywhere, so a file may use MdgCommon without checking which runtime loads it.
// 收藏夹's fav-*.js share plain top-level names, not globalThis.X: triage.selftest.js and follow.selftest.js run
// triage.html's scripts in its order, so a fav file that reads a later one's names while loading fails there.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const PS = require("./page-sources.selftest.js");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith(".js") && !e.name.endsWith(".selftest.js")) files.push(rel);
  }
})(".");

// Globals: whatever a file publishes as globalThis.X = ...
const definedBy = {};
for (const f of files) for (const m of read(f).matchAll(/globalThis\.([A-Z]\w+)\s*=/g)) definedBy[m[1]] ??= f;
for (const g of ["MdgCommon", "MdgLimits", "MdgErrors", "MdgSettings", "MdgSites", "MdgTagCore", "MdgSurfaces", "MdgNote", "MdgTyping", "MdgDownload", "MdgOverwriteDialog", "MdgNoteActions", "TriageUi", "TriageCore", "FollowCore", "MoonTriage", "TagPicker", "TagDialogs"]) {
  assert.ok(definedBy[g], `no file defines ${g}`);
}
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const usesOf = (f) => Object.keys(definedBy).filter((g) => definedBy[g] !== f && new RegExp(`\\b${g}\\b`).test(code(f)));

const runtimes = PS.runtimes.map((r) => [r.where, r.files]);
assert.ok(runtimes.length >= 11, `found ${runtimes.length} runtimes`);

// The worker loads triage/shared.js for its pure helpers; the DOM bindings that read MdgTyping never run there.
// The video page passes its own dialog to note-actions.js and only writes: its download and default dialogs never run there.
const exempt = new Set(["background.js|triage/shared.js|MdgTyping", "content.js|note-actions.js|MdgDownload", "content.js|note-actions.js|MdgOverwriteDialog"]);
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
