// Rule: every Enter/Esc handler starts with `if (BocTyping.composing(e)) return;`, every global shortcut with `if (composing(e) || typingIn(e)) return;`, every live filter uses bindLive.
// Typing guards shared by the pages and the content scripts (manifest, before the scripts that use it). Idempotent like limits.js.
(() => {
  if (globalThis.BocTyping) {
    return;
  }

  // This key belongs to the IME (picking a candidate, cancelling the composition), not to the page.
  const composing = (e) => Boolean(e.isComposing || e.keyCode === 229);

  // The key was typed into a text field: the danmaku box, a comment box inside Bilibili's shadow roots, a note.
  function typingIn(e) {
    const el = e.composedPath?.()[0] || e.target;
    return Boolean(el?.isContentEditable || el?.closest?.("input, textarea, select"));
  }

  // Runs run(input.value) delay ms after typing stops, but never mid-IME: input events while composing are skipped
  // and compositionend runs with the committed text (Chrome sends no plain input after it).
  function bindLive(input, run, delay = 150) {
    let timer = 0;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(input.value), delay);
    };
    input.addEventListener("input", (e) => {
      if (!e.isComposing) later();
    });
    input.addEventListener("compositionstart", () => clearTimeout(timer));
    input.addEventListener("compositionend", later);
  }

  // Whether an IME composition is open anywhere in this document, for re-renders that would rebuild the field under it.
  let open = false;
  globalThis.document?.addEventListener?.("compositionstart", () => (open = true), true);
  globalThis.document?.addEventListener?.("compositionend", () => (open = false), true);
  // Esc that reaches the page mid-composition (keyCode 27, not 229) would cancel an open <dialog> and lose or save the half-typed text.
  globalThis.document?.addEventListener?.("cancel", (e) => open && e.preventDefault(), true);

  globalThis.BocTyping = { composing, typingIn, bindLive, isComposing: () => open };
})();
