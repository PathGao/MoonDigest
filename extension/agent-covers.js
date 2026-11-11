// MoonDigest's agent interface, docs/AGENT.md §2: `covers`, one JPEG grid of up to 16 Bilibili video covers, each cell
// numbered, so a model can tell videos apart when titles do not. Cover URLs come from the 分拣台's local copies (no
// Bilibili API request); only the images are fetched, from the CDN the manifest already grants (*.hdslb.com).
(() => {
  const K = MdgLimits.KEYS;
  const BVID = /^BV[0-9A-Za-z]{10}$/;
  const MAX = 16;
  const COLS = 4;
  const W = 320;
  const H = 200;
  const PARALLEL = 4;
  const FETCH_MS = 8000;
  const DRAW_MS = 2000; // kept back from the deadline for drawing and encoding

  // bvid → the 分拣台's item ({ title, cover }): the folders' copies first, then the videos that left them.
  async function localItems() {
    const keys = (await MdgLimits.storageKeys(chrome.storage.local)).filter((k) => k.startsWith(K.triageSnapshotPrefix));
    const got = await chrome.storage.local.get([...keys, K.triageRemoved]);
    const lists = [...keys.map((k) => got[k]?.items || []), Object.values(got[K.triageRemoved] || {}).map((r) => r?.item)];
    const map = new Map();
    for (const it of lists.flat()) if (it?.bvid && !map.get(it.bvid)?.cover) map.set(it.bvid, it);
    return map;
  }

  // The cover as a bitmap, or null: a failed, slow (FETCH_MS, or `until`) or undecodable image is a missing cell.
  async function load(cover, until) {
    const ms = Math.min(FETCH_MS, until - Date.now());
    if (!cover || ms <= 0) return null;
    const s = TriageUi.https(cover);
    const url = s.includes("@") ? s : `${s}@${W}w_${H}h_1c.jpg`;
    const stop = new AbortController();
    let timer;
    // The timer also ends the wait itself: createImageBitmap takes no signal.
    const late = new Promise((r) => (timer = setTimeout(() => (stop.abort(), r(null)), ms)));
    const image = (async () => {
      const res = await fetch(url, { signal: stop.signal, credentials: "omit", referrerPolicy: "no-referrer" });
      return res.ok ? await createImageBitmap(await res.blob()) : null;
    })().catch(() => null);
    try {
      return await Promise.race([image, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  function draw(g, bitmap, n, x, y) {
    if (bitmap) {
      const scale = Math.max(W / bitmap.width, H / bitmap.height);
      const sw = W / scale;
      const sh = H / scale;
      g.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, x, y, W, H);
      bitmap.close?.();
    } else {
      g.fillStyle = "#777";
      g.fillRect(x, y, W, H);
    }
    const text = String(n);
    const bw = 22 + 16 * text.length;
    g.fillStyle = "rgba(0,0,0,.8)";
    g.beginPath();
    g.roundRect(x + 6, y + 6, bw, 38, 8);
    g.fill();
    g.fillStyle = "#fff";
    g.fillText(text, x + 6 + bw / 2, y + 26);
  }

  async function dataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(bin)}`;
  }

  async function covers(params, deadline) {
    const bvids = params?.bvids;
    if (!Array.isArray(bvids) || bvids.length < 1 || bvids.length > MAX || new Set(bvids).size !== bvids.length || !bvids.every((b) => typeof b === "string" && BVID.test(b)))
      return { ok: false, code: "BAD_PARAMS", error: `bvids must be 1 to ${MAX} distinct BV ids.` };
    try {
      const items = await localItems();
      const until = deadline - DRAW_MS;
      const bitmaps = new Array(bvids.length).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < bvids.length) {
          const i = next++;
          bitmaps[i] = await load(items.get(bvids[i])?.cover, until);
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));

      const width = COLS * W;
      const height = Math.ceil(bvids.length / COLS) * H;
      const canvas = new OffscreenCanvas(width, height);
      const g = canvas.getContext("2d");
      g.fillStyle = "#222"; // JPEG has no alpha: the cells a last row leaves empty would come out black
      g.fillRect(0, 0, width, height);
      g.font = "bold 28px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      const cells = bvids.map((bvid, i) => {
        draw(g, bitmaps[i], i + 1, (i % COLS) * W, Math.floor(i / COLS) * H);
        return { n: i + 1, bvid, title: String(items.get(bvid)?.title || ""), ...(!bitmaps[i] && { missing: true }) };
      });
      const image = await dataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 }));
      return { ok: true, data: { image, width, height, cells } };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  MdgAgentBridge.addMethods({ covers });
})();
