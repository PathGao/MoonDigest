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

  // The video page's overwrite choice (content.js confirmOverwriteNote, same words) for extension pages. Resolves
  // "full", "ai" or "" (取消, Esc, a click outside). hasAiSection true offers 只更新 AI 问答; false says why it is
  // missing; left out (a note with no AI 问答 section, such as a conversation note) offers only 整篇覆盖.
  // 整篇覆盖 never sits next to the focused default button. A second dialog answers the first with 取消.
  function choose(filepath, { hasAiSection } = {}) {
    document.querySelector("dialog.boc-overwrite[open]")?.close("");
    const dialog = document.createElement("dialog");
    dialog.className = "boc-overwrite";
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

  // A B 站 video note the background built (triage-build-note's data) into Obsidian, as the side panel and the
  // 视频记录 page write it: ask when the note exists, write it on 整篇覆盖, then put section (the AI 问答, may be "")
  // into it. Resolves the choice ("full", "ai" or "" for 取消); a failed check or write throws BocErrors.fromResp.
  async function writeBuiltNote({ baseUrl, apiKey, built, section, noteKey }) {
    const filepath = built.path;
    const send = sender({ baseUrl, apiKey, filepath });
    const exists = await send({ type: "obsidian-note-exists" }, "Local API 检查失败");
    const choice = exists.exists ? await choose(filepath, { hasAiSection: Boolean(section) }) : "full";
    if (choice === "full") await send({ type: "write-obsidian-note", content: built.markdown, cover: built.cover, noteKey }, "Local API 写入失败");
    if (choice && section) await send({ type: "update-obsidian-ai-section", section, noteKey }, "Local API 写入失败");
    return choice;
  }

  // A note with no AI 问答 section (a conversation note): ask when it exists, then write it whole. Resolves true when
  // written, false on 取消; a failed check or write throws BocErrors.fromResp.
  async function writeNote({ baseUrl, apiKey, filepath, content }) {
    const send = sender({ baseUrl, apiKey, filepath });
    const exists = await send({ type: "obsidian-note-exists" }, "Local API 检查失败");
    if (exists.exists && !(await choose(filepath))) return false;
    await send({ type: "write-obsidian-note", content }, "Local API 写入失败");
    return true;
  }

  const sender = (target) => async (message, fallback) => {
    const resp = await chrome.runtime.sendMessage({ ...target, ...message });
    if (!resp?.ok) throw BocErrors.fromResp(resp, fallback);
    return resp;
  };

  globalThis.BocOverwriteDialog = Object.freeze({ choose, writeBuiltNote, writeNote });
})();
