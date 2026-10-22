// Extension-page helpers (need document): saving text as a file, and the 该笔记已存在 dialog of the side panel and
// 摘读记录 (the video page draws its own copy: content.js confirmOverwriteNote).
(() => {
  if (globalThis.MdgDownload) {
    return;
  }

  function text(filename, content, type = "text/markdown;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let c = ~0;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // files: [{ name, text }] → zip bytes. Stored (no compression); flag bit 11 marks the names as UTF-8.
  // "Made by" Unix with mode 0644: made by DOS, Info-ZIP unzip (macOS's) reads the names as a DOS code page and mangles them.
  function zipStored(files, now = new Date()) {
    const enc = new TextEncoder();
    const entries = files.map((f) => ({ name: enc.encode(f.name), data: enc.encode(f.text) }));
    const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
    const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);
    const put = (at, fields) => fields.reduce((p, [size, value]) => (size === 2 ? view.setUint16(p, value, true) : view.setUint32(p, value, true), p + size), at);
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let local = 0;
    let central = localSize;
    for (const e of entries) {
      const common = [[2, 20], [2, 0x0800], [2, 0], [2, time], [2, date], [4, crc32(e.data)], [4, e.data.length], [4, e.data.length], [2, e.name.length], [2, 0]];
      out.set(e.name, put(local, [[4, 0x04034b50], ...common]));
      out.set(e.data, local + 30 + e.name.length);
      out.set(e.name, put(central, [[4, 0x02014b50], [2, 0x0314], ...common, [2, 0], [2, 0], [2, 0], [4, 0x81a40000], [4, local]]));
      local += 30 + e.name.length + e.data.length;
      central += 46 + e.name.length;
    }
    put(central, [[4, 0x06054b50], [2, 0], [2, 0], [2, entries.length], [2, entries.length], [4, centralSize], [4, localSize], [2, 0]]);
    return out;
  }

  // name, or name (2).md, (3)… while used has it ignoring case (macOS and Windows unzip 「A.md」 and 「a.md」 onto one
  // file); the name returned is added to used.
  function uniqueName(used, name) {
    let path = name;
    for (let i = 2; used.has(path.toLowerCase()); i++) path = name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
    used.add(path.toLowerCase());
    return path;
  }

  globalThis.MdgDownload = Object.freeze({ text, zipStored, uniqueName });
})();

(() => {
  if (globalThis.MdgOverwriteDialog) {
    return;
  }

  // The video page's overwrite choice (content.js confirmOverwriteNote, same words) for extension pages, shown when
  // write-video-note answers ask. Resolves the mode to send again, "full" or "ai", or "" (取消, Esc, a click outside). hasAiSection true offers 只更新 AI 问答; false says why it is
  // missing; left out (a note with no AI 问答 section, such as a conversation note) offers only 整篇覆盖.
  // 整篇覆盖 never sits next to the focused default button. A second dialog answers the first with 取消. fullReason: why
  // 整篇覆盖 cannot be done (no open video page to rebuild the note from); it is disabled with it.
  function choose(filepath, { hasAiSection, fullReason } = {}) {
    return show(`<form method="dialog">
      <h2>该笔记已存在</h2>
      <p>${hasAiSection ? "只更新 AI 问答：保留原笔记，只替换标记之间的「AI 问答」。整篇覆盖：替换全部内容。" : `${hasAiSection === false ? "没有 AI 问答可更新。" : ""}整篇覆盖会替换全部内容：`}</p>
      <code></code>
      <div class="actions">
        <button class="danger" value="full">整篇覆盖</button>
        ${hasAiSection ? '<button value="">取消</button><button class="primary" value="ai" autofocus>只更新 AI 问答</button>' : '<button value="" autofocus>取消</button>'}
      </div>
    </form>`, (dialog) => {
      dialog.querySelector("code").textContent = String(filepath || "");
      if (fullReason) MdgErrors.setReason(dialog.querySelector('[value="full"]'), fullReason);
    });
  }

  // write-video-note's askPage: a web page, or a video whose note needs its page (YouTube, 分 P), with no note yet and
  // not open in any tab. Resolves "open" (打开网页再写 / 打开视频页再写: the background opens it and writes its note),
  // "own" (只写 AI 笔记, the conversation alone) or "" (取消).
  function choosePage(url, video = false) {
    const [title, why, open] = video
      ? ["视频页没有打开", "要写成完整的视频笔记，先在后台打开视频页。只写 AI 笔记会单独存一篇，之后再写视频笔记时库里会有两篇。", "打开视频页再写"]
      : ["网页没有打开", "要写成完整的网页笔记，先在后台打开这个网页。只写 AI 笔记会单独存一篇，之后再写网页笔记时库里会有两篇。", "打开网页再写"];
    return show(`<form method="dialog">
      <h2>${title}</h2>
      <p>${why}</p>
      <code></code>
      <div class="actions">
        <button value="own">只写 AI 笔记</button>
        <button value="">取消</button>
        <button class="primary" value="open" autofocus>${open}</button>
      </div>
    </form>`, (dialog) => (dialog.querySelector("code").textContent = String(url || "")));
  }

  // One dialog at a time: a second answers the first with 取消.
  function show(html, fill) {
    document.querySelector("dialog.mdg-overwrite[open]")?.close("");
    const dialog = document.createElement("dialog");
    dialog.className = "mdg-overwrite";
    dialog.innerHTML = html;
    fill(dialog);
    // A click outside is a press and a release both on the backdrop: a text selection dragged out of the box ends
    // with a click on the dialog too, and must not close it.
    let downOutside = false;
    dialog.addEventListener("pointerdown", (event) => (downOutside = event.target === dialog));
    dialog.addEventListener("click", (event) => {
      if (downOutside && event.target === dialog) {
        dialog.close("");
      }
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        dialog.remove();
        resolve(dialog.returnValue);
      });
    });
  }

  globalThis.MdgOverwriteDialog = Object.freeze({ choose, choosePage });
})();
