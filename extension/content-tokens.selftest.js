// node extension/content-tokens.selftest.js
// content.css cannot link tokens.css (its :root would restyle the host page), so it mirrors the values as --mdg-*.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = (css) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim().replace(/\s+/g, " "),
    body,
    vars: new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim().replace(/\s+/g, " ")]))
  }));
const asMdg = (vars) => new Map([...vars].map(([k, v]) => [`--mdg-${k.slice(2)}`, v]));
const pick = (vars, prefix) => new Map([...vars].filter(([k]) => k.startsWith(prefix)));

const tokenRules = rules(read("tokens.css")).filter((r) => r.selector === ":root");
assert.strictEqual(tokenRules.length, 2, "tokens.css has one light and one dark :root block");
const [light, dark] = tokenRules.map((r) => asMdg(r.vars));

const contentRules = rules(read("content.css"));
const tokenSets = contentRules.filter((r) => r.vars.has("--mdg-text"));
const lightSets = tokenSets.filter((r) => r.vars.get("--mdg-text") === light.get("--mdg-text"));
const darkSets = tokenSets.filter((r) => r.vars.get("--mdg-text") === dark.get("--mdg-text"));
const overrides = tokenSets.filter((r) => !lightSets.includes(r) && !darkSets.includes(r));

assert.strictEqual(lightSets.length, 1, "one light token set");
assert.strictEqual(pick(lightSets[0].vars, "--mdg-").size, light.size, "light set has no extra --mdg-* tokens");
assert.deepStrictEqual(new Map([...lightSets[0].vars].filter(([k]) => light.has(k))), light, "light set matches tokens.css");
assert.ok(darkSets.length >= 2, "host-dark and prefers-dark sets exist");
for (const r of darkSets) {
  assert.strictEqual(pick(r.vars, "--mdg-").size, dark.size, `${r.selector}: no extra --mdg-* tokens`);
  assert.deepStrictEqual(new Map([...r.vars].filter(([k]) => dark.has(k))), dark, `${r.selector}: dark set matches tokens.css`);
}
for (const r of overrides) {
  for (const k of r.vars.keys()) {
    if (k.startsWith("--mdg-") && !k.startsWith("--mdg-reader-")) {
      assert.ok(light.has(k), `${r.selector}: overrides unknown token ${k}`);
    }
  }
}
for (const r of contentRules) {
  for (const k of r.vars.keys()) {
    assert.ok(!/^--(?!mdg-)/.test(k), `${r.selector}: unprefixed custom property ${k} would collide with the host page`);
  }
}

const used = new Set([...read("content.css").matchAll(/var\((--mdg-[\w-]+)\)/g)].map((m) => m[1]));
const declared = new Set(contentRules.flatMap((r) => [...r.vars.keys()]));
assert.deepStrictEqual([...used].filter((k) => !declared.has(k)), [], "every var() without a fallback is declared");

// badges.css cannot read the tokens either and writes the colors out. Every literal that stands for a token is listed
// here: [selector as written, property, token, theme]. A new hard-coded token color in badges.css goes in this list.
const badgeRules = rules(read("badges.css"));
const tokensOf = { light: tokenRules[0].vars, dark: tokenRules[1].vars };
const BADGE_TOKENS = [
  [".mdg-badge .mdg-keep", "color", "--ok", "light"],
  [".mdg-badge .mdg-drop", "color", "--danger", "light"],
  [".mdg-badge .mdg-unsure", "color", "--warn", "light"],
  [".mdg-badge .mdg-act-keep", "background", "--ok", "light"],
  [".mdg-badge .mdg-act-unfav", "background", "--danger", "light"],
  ["html.bili_dark .mdg-keep", "color", "--ok", "dark"],
  ["html.bili_dark .mdg-drop", "color", "--danger", "dark"],
  ["html.bili_dark .mdg-unsure", "color", "--warn", "dark"],
  ["html.bili_dark .mdg-act-keep", "background", "--ok", "dark"],
  ["html.bili_dark .mdg-act-unfav", "background", "--danger", "dark"],
  [".mdg-seen-bar i", "background", "--accent", "light"],
  [".mdg-seen-bar", "background", "--cover-track", "light"],
  [".mdg-seen-mark.mdg-faint", "background", "--cover-faint", "light"],
  [".mdg-seen-veil .mdg-seen-mark:not(.mdg-faint)", "background", "--cover-veil", "light"]
];
const declOf = (selector, prop) => {
  const r = badgeRules.find((r) => r.selector === selector);
  assert.ok(r, `badges.css has no rule ${selector}`);
  const m = r.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  assert.ok(m, `${selector} sets no ${prop}`);
  return m[1].trim().toLowerCase();
};
for (const [selector, prop, token, theme] of BADGE_TOKENS) {
  assert.strictEqual(declOf(selector, prop), tokensOf[theme].get(token).toLowerCase(), `badges.css ${selector} ${prop} = ${theme} ${token}`);
}

// 看完了 is 看到哪 (DESIGN 视觉设计 · 颜色): pink --accent on B站 pages, in the 分拣台 and in the settings page's example.
assert.strictEqual(declOf(".mdg-seen .mdg-seen-mark", "background"), tokenRules[0].vars.get("--accent").toLowerCase(), "the ✓ 看完了 mark is pink");
const seenTagBg = (file, selector = ".seen-tag") => rules(read(file)).find((r) => r.selector === selector).body.match(/(?:^|;)\s*background\s*:\s*([^;]+)/)[1].trim().toLowerCase();
assert.strictEqual(seenTagBg("triage/triage.css"), "var(--accent)", "the 分拣台's 看完了 tag is pink");
assert.strictEqual(seenTagBg("triage/triage.css", ".seen-bar i"), "var(--accent)", "the 分拣台's 观看进度 bar is pink");
assert.strictEqual(seenTagBg("options.css"), "var(--accent)", "the settings page's example is pink");
// 已取消收藏 (your decision) and AI 可清理 (a suggestion) share DESIGN 视觉设计 · 颜色's red but not a look: one is solid, one tinted.
assert.notStrictEqual(declOf(".mdg-badge .mdg-act-unfav", "background"), declOf(".mdg-badge .mdg-drop", "background"));

console.log("content-tokens selftest passed");
