// The sites the agent interface reads (docs/AGENT.md §5): one adapter file each in agent-sites/, registered here.
// agent-bridge.js and agent-search.js ask the registry; they name no site.
(() => {
  const sites = new Map();
  // The one site that reads any page the others do not (fallback: true): asked last, whatever the load order.
  let fallback = null;

  function register(adapter) {
    const { id, origins, key, read } = adapter || {};
    // The id prefixes every key, so a ":" in it would split keys wrongly.
    const bad = !/^[a-z0-9-]+$/.test(id) || sites.has(id) || !Array.isArray(origins) || !origins.length || typeof key !== "function" ||
      (read !== "content" && typeof read !== "function");
    if (bad || (adapter.fallback && fallback)) throw new Error(`MdgAgentSites: bad adapter ${id}`);
    sites.set(id, adapter);
    if (adapter.fallback) fallback = adapter;
  }

  // "id:itemId:part" for a page some site reads, else null. The adapter's key(URL) returns "itemId:part".
  function keyOf(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    for (const s of [...sites.values()].filter((x) => x !== fallback).concat(fallback || [])) {
      const k = s.key(u);
      if (k) return `${s.id}:${k}`;
    }
    return null;
  }

  // The page to load for href: a site's own form of it (adapter canonical(URL): youtu.be → its watch page), else href.
  // Only for a requested URL: tabs keep their own URLs, since the content script runs on the canonical pages only.
  function canonical(href) {
    let u;
    try { u = new URL(href); } catch { return href; }
    for (const s of sites.values()) {
      const c = s.canonical?.(u);
      if (c) return c;
    }
    return href;
  }

  const get = (id) => sites.get(id) || null;
  const list = () => [...sites.values()];

  globalThis.MdgAgentSites = { register, keyOf, canonical, get, list };
})();
