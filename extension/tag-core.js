// Tag rules shared by 分拣台 (triage/shared.js, follow.js) and the 「+」 picker on B站 pages (badges.js). Pure functions,
// no DOM: badges.js runs in a closed shadow root that cannot use triage's UI, so this is the one copy both load first.
(() => {
  // Catppuccin Latte accents (desaturated); chips keep --text on top, so these are only borders and tints.
  // Mauve, blue, green, red and yellow are left out: they mean where-you-are, next step, keep, delete and pending.
  const TAG_COLORS = ["#da86c3", "#298287", "#dc6d2d", "#3590a0", "#8595ea", "#cf5c66", "#2497c6", "#cf8686", "#ce9386"];
  // A tag name as both modes and the AI keep it: no commas or 顿号 (the CSV joins names with 、), trimmed, at most 12
  // characters. triage-bg.js has the same rule as triageCleanTagName; shared.selftest.js checks they agree.
  const cleanTagName = (s) => String(s ?? "").replace(/[,，、]/g, "").trim().slice(0, 12);
  // A new tag's color: the first one no tag in the list has, so deleting a tag frees its color.
  const nextTagColor = (tags) => TAG_COLORS.find((c) => !tags.some((t) => t.color === c)) || TAG_COLORS[tags.length % TAG_COLORS.length];
  // 管理's color button: the next color in the palette.
  const cycleTagColor = (color) => TAG_COLORS[(TAG_COLORS.indexOf(color) + 1) % TAG_COLORS.length];
  // A new tag's id; 关注's (UP) tags use the prefix "ft".
  const newTagId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  globalThis.BocTagCore = { TAG_COLORS, cleanTagName, nextTagColor, cycleTagColor, newTagId };
})();
