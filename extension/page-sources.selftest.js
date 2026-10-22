// /usr/local/bin/node extension/page-sources.selftest.js
// Which scripts each runtime loads: every manifest content_scripts entry, the worker's importScripts chain, every
// extension page. A check over a page's code reads the page's files from here, not a file it names, so it still sees
// the code after the code moves to another file of that page. Required by the other selftests; run directly, it checks
// that every shipped script is in some runtime (a script no runtime loads is a script no check reads).
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
};
const all = walk(".");
// dev/ folders and dev-sidepanel/ hold mocks and the dev preview: they are runtimes for load-order, not shipped code.
const isDev = (f) => f.split(path.sep).some((part) => /^dev/.test(part));

// [{ where, files, dev }]: where is a page's path, "background.js", or a content_scripts entry's last file.
const runtimes = [];
for (const c of JSON.parse(read("manifest.json")).content_scripts) runtimes.push({ where: c.js.at(-1), files: c.js, dev: false });
// The worker runs the first importScripts list before background.js's own top level.
const calls = [...read("background.js").matchAll(/importScripts\(([^)]*)\)/g)].map((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
runtimes.push({ where: "background.js", files: [...calls[0], "background.js", ...calls.slice(1).flat()], dev: false });
for (const page of all.filter((f) => f.endsWith(".html"))) {
  const files = [...read(page).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.normalize(path.join(path.dirname(page), m[1])));
  runtimes.push({ where: page, files, dev: isDev(page) });
}

// The scripts a runtime loads (both content_scripts entries that end in content.js, for "content.js").
const scripts = (where) => {
  const found = runtimes.filter((r) => r.where === where);
  assert.ok(found.length, `no runtime ${where}`);
  return [...new Set(found.flatMap((r) => r.files))];
};
// The scripts only this runtime loads (dev runtimes aside): its own code, not the shared libraries.
const own = (where) => {
  const files = scripts(where);
  return files.filter((f) => runtimes.every((r) => r.dev || r.where === where || !r.files.includes(f)));
};
// Every script some shipped runtime loads.
const shipped = [...new Set(runtimes.filter((r) => !r.dev).flatMap((r) => r.files))];
// 分拣台's two modes: 关注's scripts are named follow* (the worker may load one too); 收藏夹's are the rest of the page's
// own scripts but the libraries both modes load. triage is the page's code: its own scripts and 关注's.
const bothModes = ["triage/tag-picker.js", "triage/tag-dialogs.js", "triage/tag-store.js", "triage/runs.js", "triage/writes.js"];
const follow = scripts("triage/triage.html").filter((f) => /^follow/.test(path.basename(f)));
const favorites = own("triage/triage.html").filter((f) => !follow.includes(f) && !bothModes.includes(f));
const triage = [...new Set([...own("triage/triage.html"), ...follow, ...bothModes])];
// Every shipped runtime's own scripts and 分拣台's: the code of the pages, the worker and the content scripts, without
// the libraries.
const pageCode = [...new Set([...runtimes.filter((r) => !r.dev).flatMap((r) => own(r.where)), ...triage])];
// The files' text as one string.
const text = (files) => files.map(read).join("\n");

module.exports = { read, text, runtimes, scripts, own, shipped, pageCode, triage, favorites, follow };

if (require.main === module) {
  // messages.js is the message list messages.selftest.js checks; it is not shipped.
  // vendor/defuddle.js is injected into web pages on demand (background.js readWebPage), by no runtime's list.
  const files = all.filter((f) => f.endsWith(".js") && !f.endsWith(".selftest.js") && !isDev(f) && f !== "messages.js" && f !== "vendor/defuddle.js");
  assert.deepStrictEqual(files.filter((f) => !shipped.includes(f)), [], "every shipped script is loaded by some runtime");
  assert.deepStrictEqual(own("popup.html"), ["popup.js"]);
  assert.deepStrictEqual(own("content.js"), ["content.js"], "both content.js entries are one runtime");
  assert.ok(own("background.js").includes("triage/follow-bg.js") && !own("background.js").includes("triage/shared.js"));
  assert.ok(favorites.includes("triage/fav-page.js") && follow.includes("triage/follow.js") && !favorites.includes("triage/shared.js"));
  assert.ok(bothModes.every((f) => scripts("triage/triage.html").includes(f)), "bothModes names files the page loads");
  console.log("page-sources selftest ok");
}
