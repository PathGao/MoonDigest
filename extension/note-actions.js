// The one client flow of a note's three exits, 复制 Markdown / 下载 .md / 写入 Obsidian, for every entry (side panel,
// 摘读记录, popup, the video page, 一篇摘录): it sends export-note or write-video-note (obsidian.js resolveNote decides the
// note), asks askPage and ask in the dialogs and sends again, checks the entry did not move on meanwhile, copies or
// downloads, and says the result or the failure with its remedies. The entry only shows the result its own way.
// No DOM of its own: the dialogs and MdgDownload come from the extension pages (download.js); the video page, which
// cannot use their <dialog>, passes its own choose (content.js confirmOverwriteNote) and never downloads.
(() => {
  if (globalThis.MdgNoteActions) {
    return;
  }

  const TYPE = { copy: "export-note", download: "export-note", write: "write-video-note" };
  // What the page dialog's buttons say (MdgOverwriteDialog.choosePage) and what a cancel says.
  const VERB = { copy: "复制", download: "下载", write: "写" };
  const CANCELLED = { copy: "已取消复制", download: "已取消下载", write: "已取消写入 Obsidian" };
  const FAILED = { copy: MdgErrors.TEXT.copyFailed, download: MdgErrors.TEXT.downloadFailed, write: MdgErrors.TEXT.obsidianFailed };
  const EMPTY = { copy: MdgErrors.TEXT.nothingToCopy, download: MdgErrors.TEXT.nothingToDownload, write: MdgErrors.TEXT.nothingToWrite };
  const DONE = { copy: MdgErrors.TEXT.copied, download: MdgErrors.TEXT.downloaded };

  // kind: "copy" | "download" | "write".
  // request(): the note's fields { ref, conversation?, page? }, read again at each send (may return a promise); or
  // note: { filename, markdown } the entry built itself (popup, 一篇摘录, a side panel reply): copied or downloaded as is.
  // send(message): the background's reply (default chrome.runtime.sendMessage). isStale(): after a dialog, why the
  // entry no longer wants this note ("" goes on). dialogs: { choose, choosePage }, default MdgOverwriteDialog.
  // Resolves { ok, done, text, remedies, code?, reason? }: done false is nothing done (取消, switched), not red;
  // ok false is a failure, text its whole line, remedies MdgErrors.remedies(code) and reason the words after 「：」.
  async function run(kind, { request, note, send = (m) => chrome.runtime.sendMessage(m), isStale = () => "", dialogs = globalThis.MdgOverwriteDialog } = {}) {
    try {
      const resp = note || (await resolve(kind, request, send, isStale, dialogs));
      if (resp.stop) return { ok: true, done: false, text: resp.stop, remedies: [] };
      // Any refusal says noClipboard, not Chrome's English ("Document is not focused"); no cause, its code is a DOMException's.
      if (kind === "copy") await navigator.clipboard.writeText(resp.markdown).catch(() => Promise.reject(new Error(MdgErrors.TEXT.noClipboard)));
      if (kind === "download") MdgDownload.text(resp.filename, resp.markdown);
      return { ok: true, done: true, text: DONE[kind] || resp.text, remedies: [] };
    } catch (error) {
      const code = error?.cause?.code;
      if (MdgErrors.reloaded(error)) return { ok: false, done: false, text: MdgErrors.TEXT.reloaded, remedies: [], reason: MdgErrors.TEXT.reloaded };
      if (code === MdgErrors.CODE.NOTE_EMPTY) return { ok: false, done: false, text: EMPTY[kind], remedies: MdgErrors.remedies(code), code, reason: EMPTY[kind] };
      const reason = MdgErrors.messageOf(error, kind === "copy" ? MdgErrors.TEXT.noClipboard : MdgErrors.TEXT.unknown);
      return { ok: false, done: false, text: `${FAILED[kind]}：${reason}`, remedies: MdgErrors.remedies(code), ...(code && { code }), reason };
    }
  }

  // The background's answer after its questions: askPage (the note's page not open, no note yet) for every kind, ask
  // (the note exists) for a write. { stop: text } when the user cancelled or isStale says why.
  async function resolve(kind, request, send, isStale, dialogs) {
    const sendNote = async (extra) => {
      const resp = await send({ ...(await request()), type: TYPE[kind], ...extra });
      if (!resp?.ok) throw MdgErrors.fromResp(resp, kind === "write" ? MdgErrors.TEXT.obsidianWriteFailed : MdgErrors.TEXT.unknown);
      return resp;
    };
    const stopped = (choice, cancelled) => (!choice ? cancelled : isStale());
    let resp = await sendNote({});
    let pageChoice;
    if (resp.askPage) {
      pageChoice = await dialogs.choosePage(resp.url, resp.video, resp.own !== false, VERB[kind]);
      const stop = stopped(pageChoice, CANCELLED[kind]);
      if (stop) return { stop };
      resp = await sendNote({ pageChoice });
    }
    if (resp.ask) {
      const mode = await dialogs.choose(resp.path, { hasAiSection: resp.hasAiSection, aiOff: resp.aiOff, fullReason: resp.fullReason });
      const stop = stopped(mode, MdgErrors.TEXT.obsidianCancelled);
      if (stop) return { stop };
      resp = await sendNote({ pageChoice, mode });
    }
    return resp;
  }

  // The note 下载 would give, as export-note's reply, without a dialog or a download: 摘读记录's zip of several records
  // (request carries pageChoice "own", so no askPage comes back). Rejects on a failed reply.
  const build = (request, send = (m) => chrome.runtime.sendMessage(m)) => resolve("download", () => request, send, () => "", {});

  globalThis.MdgNoteActions = Object.freeze({ run, build });
})();
