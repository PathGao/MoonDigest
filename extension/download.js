// Extension-page helpers (need document): saving text as a file, and the video page's 该笔记已存在 choice.
(() => {
  if (globalThis.BocDownload) {
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

  globalThis.BocDownload = Object.freeze({ text });
})();

(() => {
  if (globalThis.BocOverwriteDialog) {
    return;
  }

  // The video page's overwrite choice (content.js confirmOverwriteNote) for extension pages. Resolves "full",
  // "ai" or "" (取消, Esc, a click outside). 整篇覆盖 never sits next to the focused default button.
  function choose(filepath, { hasAiSection = false } = {}) {
    const dialog = document.createElement("dialog");
    dialog.className = "boc-overwrite";
    dialog.innerHTML = `<form method="dialog">
      <h2>该笔记已存在</h2>
      <p>${hasAiSection ? "只更新 AI 问答：保留原笔记，只替换标记之间的「AI 问答」。整篇覆盖：替换全部内容。" : "没有新的 AI 问答可更新。整篇覆盖会替换全部内容："}</p>
      <code></code>
      <div class="actions">
        <button class="danger" value="full">整篇覆盖</button>
        ${hasAiSection ? '<button value="">取消</button><button class="primary" value="ai" autofocus>只更新 AI 问答</button>' : '<button class="primary" value="" autofocus>取消</button>'}
      </div>
    </form>`;
    dialog.querySelector("code").textContent = String(filepath || "");
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
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

  globalThis.BocOverwriteDialog = Object.freeze({ choose });
})();
