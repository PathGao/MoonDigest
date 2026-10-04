// Saves text as a file through the browser's download flow. Extension pages only (needs document).
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
