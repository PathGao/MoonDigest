// /usr/local/bin/node extension/agent-covers.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in CONTRIBUTING.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// Waits of a second or more (the 8 s image timeout, the time left before a deadline) fire after 80 ms and are recorded:
// well clear of the fake CDN's 3 ms even on Windows, whose timers tick about every 16 ms.
const waits = [];
const fastWait = (fn, ms) => (ms >= 1000 ? (waits.push(ms), setTimeout(fn, 80)) : setTimeout(fn, ms));
const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout: fastWait, clearTimeout, setInterval, clearInterval, AbortController, btoa });
// The worker's load order up to the helpers agent-covers.js uses, then the file itself with addMethods caught.
const order = [...fs.readFileSync(path.join(__dirname, "background.js"), "utf8").matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
const shared = order.indexOf("triage/shared.js");
assert.ok(order.indexOf("agent-covers.js") > shared, "agent-covers.js loads after triage/shared.js");
for (const file of order.slice(0, shared + 1).filter((f) => !f.startsWith("agent-"))) vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
let M = null;
ctx.MdgAgentBridge = { addMethods: (m) => (M = m) };
vm.runInContext(fs.readFileSync(path.join(__dirname, "agent-covers.js"), "utf8"), ctx);
assert.deepStrictEqual(Object.keys(M), ["covers"]);
const K = ctx.MdgLimits.KEYS;
const plain = (x) => JSON.parse(JSON.stringify(x));

let local = {};
ctx.chrome = { storage: { local: { get: async (keys) => (keys == null ? { ...local } : Object.fromEntries(keys.filter((k) => k in local).map((k) => [k, local[k]]))) } } };

// ---- fake CDN: a URL's file name says what it does ----
const fetched = [];
let inFlight = 0;
let maxInFlight = 0;
ctx.fetch = async (url, init = {}) => {
  const call = { url, init };
  fetched.push(call);
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (url.includes("hang")) await new Promise(() => {});
    await new Promise((r) => setTimeout(r, 3));
    if (url.includes("down")) throw new Error("network");
    return { ok: !url.includes("gone"), blob: async () => ({ url }) };
  } finally {
    inFlight--;
  }
};
ctx.createImageBitmap = async (blob) => {
  if (blob.url.includes("notimage")) throw new Error("decode");
  return { width: 640, height: 360, from: blob.url };
};

const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
let canvas = null;
ctx.OffscreenCanvas = class {
  constructor(width, height) {
    Object.assign(this, { width, height, calls: [] });
    canvas = this;
  }
  getContext(kind) {
    assert.strictEqual(kind, "2d");
    const calls = this.calls;
    const g = {};
    for (const name of ["fillRect", "drawImage", "fillText", "roundRect", "beginPath", "fill"]) g[name] = (...args) => void calls.push({ name, args, fillStyle: g.fillStyle, font: g.font });
    return g;
  }
  async convertToBlob(opts) {
    this.blobOpts = opts;
    return new Blob([JPEG]);
  }
};

const bv = (i) => `BV1${String(i).padStart(9, "0")}`;
const N = (n) => Array.from({ length: n }, (_, i) => bv(i + 1));
const item = (i, cover = `http://i0.hdslb.com/bfs/${i}.jpg`) => ({ bvid: bv(i), title: `视频 ${i}`, cover });
const store = (items) => (local = { [K.triageSnapshot("11")]: { items } });
const far = () => Date.now() + 55_000;
const calls = (name) => canvas.calls.filter((c) => c.name === name);
const origin = (i) => [(i % 4) * 320, Math.floor(i / 4) * 200];

const cases = [];
const check = (name, fn) => cases.push([name, fn]);

check("BAD_PARAMS: none, 17, a duplicate, not a BV id; nothing read or drawn", async () => {
  for (const bvids of [undefined, "BV1000000001", [], N(17), [bv(1), bv(1)], ["BV123"], [bv(1), 5], ["av170001"]]) {
    const r = await M.covers({ bvids }, far());
    assert.deepStrictEqual([r.ok, r.code, typeof r.error], [false, "BAD_PARAMS", "string"], JSON.stringify(bvids));
  }
  assert.strictEqual((await M.covers(undefined, far())).code, "BAD_PARAMS");
  assert.strictEqual(fetched.length, 0);
  assert.strictEqual(canvas, null);
});

check("canvas size: 4 columns of 320×200, rows as needed", async () => {
  for (const [n, height] of [[1, 200], [4, 200], [5, 400], [16, 800]]) {
    store(N(n).map((_, i) => item(i + 1)));
    const r = await M.covers({ bvids: N(n) }, far());
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual([canvas.width, canvas.height, r.data.width, r.data.height], [1280, height, 1280, height], `${n} covers`);
  }
});

check("each cell: the cover cover-fitted at its origin, its number on a dark box at the top-left", async () => {
  store(N(16).map((_, i) => item(i + 1)));
  const r = await M.covers({ bvids: N(16) }, far());
  const images = calls("drawImage");
  const texts = calls("fillText");
  const boxes = calls("roundRect");
  assert.deepStrictEqual(texts.map((t) => t.args[0]), N(16).map((_, i) => String(i + 1)));
  for (let i = 0; i < 16; i++) {
    const [x, y] = origin(i);
    // 640×360 into 320×200: the full height, 576 of the width, centred.
    assert.deepStrictEqual(images[i].args.slice(1), [32, 0, 576, 360, x, y, 320, 200], `cell ${i + 1} image`);
    assert.match(images[i].args[0].from, new RegExp(`/bfs/${i + 1}\\.jpg@`), "the cell shows its own video");
    const [bx, by, bw, bh] = boxes[i].args;
    assert.deepStrictEqual([bx - x, by - y], [6, 6], `cell ${i + 1} box`);
    const [, tx, ty] = texts[i].args;
    assert.ok(tx > bx && tx < bx + bw && ty > by && ty < by + bh, `cell ${i + 1} number inside its box`);
    assert.strictEqual(texts[i].fillStyle, "#fff");
    assert.match(texts[i].font, /bold 28px/);
  }
  assert.ok(boxes[9].args[2] > boxes[8].args[2], "two digits get a wider box");
  assert.deepStrictEqual(plain(canvas.blobOpts), { type: "image/jpeg", quality: 0.8 });
  assert.strictEqual(r.data.image, `data:image/jpeg;base64,${JPEG.toString("base64")}`);
});

check("URLs: https, a 320×200 rendition unless the URL has its own @ size; only the CDN is asked", async () => {
  store([item(1), item(2, "//i1.hdslb.com/bfs/b.png"), item(3, "https://i2.hdslb.com/bfs/c.jpg@672w_378h_1c.webp")]);
  await M.covers({ bvids: N(3) }, far());
  assert.deepStrictEqual(fetched.map((f) => f.url), [
    "https://i0.hdslb.com/bfs/1.jpg@320w_200h_1c.jpg",
    "https://i1.hdslb.com/bfs/b.png@320w_200h_1c.jpg",
    "https://i2.hdslb.com/bfs/c.jpg@672w_378h_1c.webp"
  ]);
});

check("missing: not in storage, no cover, HTTP error, network error, not an image; all numbered, order as asked", async () => {
  local = {
    [K.triageSnapshot("11")]: { items: [item(1), item(3, ""), item(4, "http://i0.hdslb.com/gone.jpg")] },
    [K.triageSnapshot("22")]: { items: [item(5, "http://i0.hdslb.com/down.jpg"), item(6, "http://i0.hdslb.com/notimage.jpg")] },
    [K.triageRemoved]: { [bv(7)]: { item: item(7), at: 1 } }
  };
  const bvids = [bv(7), bv(2), bv(3), bv(4), bv(5), bv(6), bv(1)];
  const r = await M.covers({ bvids }, far());
  assert.deepStrictEqual(plain(r.data.cells), [
    { n: 1, bvid: bv(7), title: "视频 7" },
    { n: 2, bvid: bv(2), title: "", missing: true },
    { n: 3, bvid: bv(3), title: "视频 3", missing: true },
    { n: 4, bvid: bv(4), title: "视频 4", missing: true },
    { n: 5, bvid: bv(5), title: "视频 5", missing: true },
    { n: 6, bvid: bv(6), title: "视频 6", missing: true },
    { n: 7, bvid: bv(1), title: "视频 1" }
  ]);
  assert.deepStrictEqual(calls("fillText").map((t) => t.args[0]), ["1", "2", "3", "4", "5", "6", "7"]);
  assert.deepStrictEqual(calls("drawImage").map((c) => c.args.slice(5, 7)), [origin(0), origin(6)]);
  // A grey box where the cover is missing (the first fillRect is the whole canvas).
  assert.deepStrictEqual(calls("fillRect").slice(1).map((c) => c.args), [1, 2, 3, 4, 5].map((i) => [...origin(i), 320, 200]));
});

check("a video in two folders: the copy that has a cover", async () => {
  local = { [K.triageSnapshot("11")]: { items: [item(1, "")] }, [K.triageSnapshot("22")]: { items: [item(1)] } };
  assert.deepStrictEqual(plain((await M.covers({ bvids: [bv(1)] }, far())).data.cells), [{ n: 1, bvid: bv(1), title: "视频 1" }]);
});

check("at most 4 images load at a time", async () => {
  store(N(16).map((_, i) => item(i + 1)));
  maxInFlight = 0;
  await M.covers({ bvids: N(16) }, far());
  assert.strictEqual(fetched.length, 16);
  assert.strictEqual(maxInFlight, 4);
});

check("an image that never arrives: given up after 8 s, aborted, the rest still drawn", async () => {
  store([item(1, "http://i0.hdslb.com/hang.jpg"), item(2)]);
  const r = await M.covers({ bvids: N(2) }, far());
  assert.deepStrictEqual(plain(r.data.cells.map((c) => c.missing || false)), [true, false]);
  assert.deepStrictEqual(waits, [8000, 8000]);
  assert.deepStrictEqual(fetched.map((f) => f.init.signal.aborted), [true, false]);
});

check("the deadline: images wait no longer than it leaves, and none starts after it", async () => {
  store(N(8).map((_, i) => item(i + 1, `http://i0.hdslb.com/hang${i}.jpg`)));
  const started = Date.now();
  const r = await M.covers({ bvids: N(8) }, started + 5000);
  assert.ok(r.ok && r.data.cells.every((c) => c.missing));
  assert.ok(waits.length === 8 && waits.every((ms) => ms <= 3000), `waits ${waits}`);
  fetched.length = 0;
  const late = await M.covers({ bvids: N(8) }, Date.now() + 1000);
  assert.ok(late.ok && late.data.cells.every((c) => c.missing));
  assert.strictEqual(fetched.length, 0);
});

check("a canvas failure is an error reply, not a throw", async () => {
  store([item(1)]);
  const real = ctx.OffscreenCanvas;
  ctx.OffscreenCanvas = class { constructor() { throw new Error("no canvas"); } };
  try {
    assert.deepStrictEqual(plain(await M.covers({ bvids: [bv(1)] }, far())), { ok: false, error: "no canvas" });
  } finally {
    ctx.OffscreenCanvas = real;
  }
});

(async () => {
  for (const [name, fn] of cases) {
    local = {};
    fetched.length = 0;
    waits.length = 0;
    canvas = null;
    await fn();
    for (const f of fetched) assert.match(new URL(f.url).hostname, /\.hdslb\.com$/, `${name}: ${f.url} is not the image CDN`);
    console.log(`ok   ${name}`);
  }
  console.log(`agent-covers selftest: all ${cases.length} passed`);
  done = true;
})().catch((e) => (console.error(e), process.exit(1)));
// A call left waiting on an image that never arrives keeps nothing alive: Node would exit 0 midway.
let done = false;
process.on("exit", (code) => !done && code === 0 && (console.error("agent-covers selftest: a call never returned"), (process.exitCode = 1)));
