// Extension-page helpers (need document): saving text as a file, the date in export file names (dateStamp), and the
// 该笔记已存在 dialog of the side panel and 视频记录 (the video page draws its own copy: content.js confirmOverwriteNote).
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

  // The date in every exported file name, by the local day (toISOString's UTC day is yesterday before 8:00 in UTC+8):
  // 2026-10-14, or 2026-10-14-0730 for exports made several times a day.
  function dateStamp(d = new Date(), withTime = false) {
    const pad = (n) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return withTime ? `${day}-${pad(d.getHours())}${pad(d.getMinutes())}` : day;
  }

  globalThis.MdgDownload = Object.freeze({ text, dateStamp });
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
    document.querySelector("dialog.mdg-overwrite[open]")?.close("");
    const dialog = document.createElement("dialog");
    dialog.className = "mdg-overwrite";
    dialog.innerHTML = `<form method="dialog">
      <h2>该笔记已存在</h2>
      <p>${hasAiSection ? "只更新 AI 问答：保留原笔记，只替换标记之间的「AI 问答」。整篇覆盖：替换全部内容。" : `${hasAiSection === false ? "没有 AI 问答可更新。" : ""}整篇覆盖会替换全部内容：`}</p>
      <code></code>
      <div class="actions">
        <button class="danger" value="full">整篇覆盖</button>
        ${hasAiSection ? '<button value="">取消</button><button class="primary" value="ai" autofocus>只更新 AI 问答</button>' : '<button value="" autofocus>取消</button>'}
      </div>
    </form>`;
    dialog.querySelector("code").textContent = String(filepath || "");
    if (fullReason) MdgErrors.setReason(dialog.querySelector('[value="full"]'), fullReason);
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

  globalThis.MdgOverwriteDialog = Object.freeze({ choose });
})();
