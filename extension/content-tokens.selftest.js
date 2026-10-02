// node extension/content-tokens.selftest.js
// content.css cannot link tokens.css (its :root would restyle the host page), so it mirrors the values as --boc-*.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = (css) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim().replace(/\s+/g, " "),
    vars: new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim().replace(/\s+/g, " ")]))
  }));
const asBoc = (vars) => new Map([...vars].map(([k, v]) => [`--boc-${k.slice(2)}`, v]));
const pick = (vars, prefix) => new Map([...vars].filter(([k]) => k.startsWith(prefix)));

const tokenRules = rules(read("tokens.css")).filter((r) => r.selector === ":root");
assert.strictEqual(tokenRules.length, 2, "tokens.css has one light and one dark :root block");
const [light, dark] = tokenRules.map((r) => asBoc(r.vars));

const contentRules = rules(read("content.css"));
const tokenSets = contentRules.filter((r) => r.vars.has("--boc-text"));
const lightSets = tokenSets.filter((r) => r.vars.get("--boc-text") === light.get("--boc-text"));
const darkSets = tokenSets.filter((r) => r.vars.get("--boc-text") === dark.get("--boc-text"));
const overrides = tokenSets.filter((r) => !lightSets.includes(r) && !darkSets.includes(r));

assert.strictEqual(lightSets.length, 1, "one light token set");
assert.strictEqual(pick(lightSets[0].vars, "--boc-").size, light.size, "light set has no extra --boc-* tokens");
assert.deepStrictEqual(new Map([...lightSets[0].vars].filter(([k]) => light.has(k))), light, "light set matches tokens.css");
assert.ok(darkSets.length >= 2, "host-dark and prefers-dark sets exist");
for (const r of darkSets) {
  assert.strictEqual(pick(r.vars, "--boc-").size, dark.size, `${r.selector}: no extra --boc-* tokens`);
  assert.deepStrictEqual(new Map([...r.vars].filter(([k]) => dark.has(k))), dark, `${r.selector}: dark set matches tokens.css`);
}
for (const r of overrides) {
  for (const k of r.vars.keys()) {
    if (k.startsWith("--boc-") && !k.startsWith("--boc-reader-")) {
      assert.ok(light.has(k), `${r.selector}: overrides unknown token ${k}`);
    }
  }
}
for (const r of contentRules) {
  for (const k of r.vars.keys()) {
    assert.ok(!/^--(?!boc-)/.test(k), `${r.selector}: unprefixed custom property ${k} would collide with the host page`);
  }
}

const used = new Set([...read("content.css").matchAll(/var\((--boc-[\w-]+)\)/g)].map((m) => m[1]));
const declared = new Set(contentRules.flatMap((r) => [...r.vars.keys()]));
assert.deepStrictEqual([...used].filter((k) => !declared.has(k)), [], "every var() without a fallback is declared");

console.log("content-tokens selftest passed");
