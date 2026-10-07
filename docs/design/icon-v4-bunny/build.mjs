// Generates the bunny-eared 月团 toolbar icons and the one-colour brand mark.
// No tile: the 月团 alone on a transparent canvas, fitted to the canvas so it reads as large as possible.
// Writes icon{16,32,48,128}.svg and preview.png here, icon{16,32,48,128}.png and moondigest-mark.svg to extension/icons/.
// Run from the repo root: bun docs/design/icon-v4-bunny/build.mjs
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, "../../../extension/icons");
const SIZES = [16, 32, 48, 128];

// Artwork in 256 units: cloud body, saturn ring (back arc + front arc), two ears behind the body.
const BODY = "M81 89C82.3333 68.3333 93 61 113 67C134.333 48.3333 151.333 51.6667 164 77C189.333 86.3333 195 107.333 181 140C180.333 164 167.333 177.667 142 181C116.667 197 98.6667 193.333 88 170C60.6667 166 52.6667 153 64 131C60.6667 113.667 66.3333 99.6667 81 89Z";
const ORBIT_BACK = "M49 150C20 93 191 78 207 111C223 143 72 184 49 150Z";
const ORBIT_BACK_ARC = "M49 150C20 93 191 78 207 111";
const ORBIT_FRONT = "M51 145C70 179 184 153 205 120";
const EAR_ROOTS = [[112, 78], [152, 72]]; // on the body's two top bumps
const EYE_COLS = [112.5, 143.5]; // eye centres; eyes start at y 105
const defs = `<defs>
<linearGradient id="pink" x1="82.3" y1="55.1" x2="174.7" y2="186.8" gradientUnits="userSpaceOnUse"><stop stop-color="#FFE4EC"/><stop offset="0.52" stop-color="#EE9DBD"/><stop offset="1" stop-color="#C45B97"/></linearGradient>
<linearGradient id="lilac" x1="78.7" y1="120" x2="89" y2="177.5" gradientUnits="userSpaceOnUse"><stop stop-color="#EEE5FF"/><stop offset="0.52" stop-color="#B7A0FF"/><stop offset="1" stop-color="#7354D8"/></linearGradient>
<linearGradient id="earL" x1="0.3" y1="0" x2="0.6" y2="1"><stop stop-color="#E4D9FF"/><stop offset="0.6" stop-color="#B7A0FF"/><stop offset="1" stop-color="#8E72E6"/></linearGradient>
</defs>`;

// Per size, in artwork units. orbit: ring stroke. back: full back loop or just its top arc. gap: transparent cut
// around the front ring at 16. eyes: whole-pixel eye rects (null = vector eyes). Ears: rx/ry half width/length,
// rot outward tilt (deg), spread pushes each root outward so the ears stay apart at small sizes.
// face: blush and ω mouth (48 and up). fill: share of the canvas the artwork's longer side takes.
const sizes = {
  128: { fill: 0.98, orbit: 13, back: "loop", eyes: null, ear: { rx: 19, ry: 41, rot: 18, spread: 0 }, face: true },
  48: { fill: 1, orbit: 15, back: "loop", eyes: { h: 4, w: 2 }, ear: { rx: 20, ry: 41, rot: 19, spread: 2 }, face: true },
  32: { fill: 1, orbit: 19, back: "loop", eyes: { h: 3, w: 1 }, ear: { rx: 21, ry: 41, rot: 20, spread: 5 }, face: false },
  16: { fill: 1, orbit: 24, back: "arc", gap: 16, eyes: { h: 2, w: 1 }, ear: { rx: 25, ry: 41, rot: 20, spread: 10 }, face: false },
};

// Each ear is an ellipse whose bottom sits 10 units inside the body, tilted outward about its root.
// fill null = coloured ear with a pink inner ear (32 and up); otherwise one flat colour (for the mark).
function ears(size, fill = null) {
  const e = sizes[size].ear;
  return EAR_ROOTS.map(([x, y], i) => {
    const dir = i ? 1 : -1;
    const ex = x + dir * e.spread;
    const cy = y - e.ry + 10;
    const inner = !fill && size >= 32 ? `<ellipse cx="${ex}" cy="${cy + 6}" rx="${e.rx * 0.48}" ry="${e.ry * 0.64}" fill="#FFB3CF"/>` : "";
    return `<g transform="rotate(${dir * e.rot} ${ex} ${y})"><ellipse cx="${ex}" cy="${cy}" rx="${e.rx}" ry="${e.ry}" fill="${fill || "url(#earL)"}"/>${inner}</g>`;
  }).join("");
}

function artPaths(size) {
  const c = sizes[size];
  const back = c.back === "loop"
    ? `<path d="${ORBIT_BACK}" stroke="#706DAB" stroke-width="${c.orbit}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
    : `<path d="${ORBIT_BACK_ARC}" stroke="#706DAB" stroke-width="${c.orbit}" stroke-linecap="round" fill="none"/>`;
  const body = `<path d="${BODY}" fill="url(#pink)"/>`;
  const art = [];
  if (c.gap) {
    art.push(`<mask id="gap" maskUnits="userSpaceOnUse" x="-64" y="-64" width="384" height="384"><rect x="-64" y="-64" width="384" height="384" fill="#fff"/><path d="${ORBIT_FRONT}" stroke="#000" stroke-width="${c.orbit + c.gap}" stroke-linecap="round" fill="none"/></mask>`);
    art.push(`<g mask="url(#gap)">${back}${ears(size)}${body}</g>`);
  } else art.push(back, ears(size), body);
  art.push(`<path d="${ORBIT_FRONT}" stroke="url(#lilac)" stroke-width="${c.orbit}" stroke-linecap="round" fill="none"/>`);
  if (c.face) {
    art.push(`<ellipse cx="98" cy="134" rx="10" ry="6" fill="#FF7FA8" opacity="0.5"/><ellipse cx="158" cy="134" rx="10" ry="6" fill="#FF7FA8" opacity="0.5"/>`);
    art.push(`<path d="M121 131q3.5 5 7 0q3.5 5 7 0" stroke="#6A3D61" stroke-width="${size >= 128 ? 3 : 4.5}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  if (!c.eyes) art.push(`<rect x="108" y="105" width="9" height="20" rx="4.5" fill="#6A3D61"/><rect x="139" y="105" width="9" height="20" rx="4.5" fill="#6A3D61"/>`);
  return art.join("");
}

// Artwork bounds in 256 units, measured from a render of the -64..320 window at 1024 px.
function measure(content) {
  const { width, height, pixels } = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-64 -64 384 384">${defs}${content}</svg>`).render();
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    if (pixels[(y * width + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const k = 384 / 1024;
  return { x: x0 * k - 64, y: y0 * k - 64, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
}

function svg(size) {
  const c = sizes[size];
  const A = measure(artPaths(size));
  const s = (size * c.fill) / Math.max(A.w, A.h);
  const cx = A.x + A.w / 2, cy = A.y + A.h / 2, mid = size / 2;
  const px = (x, y) => [mid + (x - cx) * s, mid + (y - cy) * s];
  const eyes = c.eyes ? EYE_COLS.map((ex) => {
    const [x, y] = px(ex, 105);
    return `<rect x="${Math.round(x - c.eyes.w / 2)}" y="${Math.round(y)}" width="${c.eyes.w}" height="${c.eyes.h}" rx="${Math.min(c.eyes.w / 2, 0.8)}" fill="#6A3D61"/>`;
  }).join("") : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}
<g transform="translate(${mid} ${mid}) scale(${+s.toFixed(5)}) translate(${-cx.toFixed(3)} ${-cy.toFixed(3)})">${artPaths(size)}</g>${eyes}
</svg>
`;
}

// Brand mark: one-colour silhouette used as a CSS mask (.brand-mark in tokens.css, ~18-22 px). Same layout as the
// icon: ears and body are solid; the front ring and eyes are cut out of the body, the ring is drawn back over the cut.
function markSvg(color = "#000") {
  const content = `<mask id="body" maskUnits="userSpaceOnUse" x="-64" y="-64" width="384" height="384"><rect x="-64" y="-64" width="384" height="384" fill="#fff"/><path d="${ORBIT_FRONT}" fill="none" stroke="#000" stroke-width="34" stroke-linecap="round"/><rect x="102" y="102" width="15" height="26" rx="7.5" fill="#000"/><rect x="138" y="102" width="15" height="26" rx="7.5" fill="#000"/></mask>`
    + `<path d="M49 150C20 93 191 78 207 111" fill="none" stroke="${color}" stroke-width="15" stroke-linecap="round"/>`
    + `<g mask="url(#body)">${ears(128, color)}<path d="${BODY}" fill="${color}"/></g>`
    + `<path d="${ORBIT_FRONT}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>`;
  const b = measure(content);
  const [x, y, w, h] = [Math.floor(b.x), Math.floor(b.y), Math.ceil(b.w) + 1, Math.ceil(b.h) + 1];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${+(20 * w / h).toFixed(2)}" height="20" viewBox="${x} ${y} ${w} ${h}">${content}</svg>\n`;
}

const render = (src, opts = {}) => new Resvg(src, { shapeRendering: 2, ...opts }).render().asPng();

const pngs = {};
for (const size of SIZES) {
  const src = svg(size);
  writeFileSync(join(here, `icon${size}.svg`), src);
  pngs[size] = render(src);
  writeFileSync(join(iconsDir, `icon${size}.png`), pngs[size]);
}
const mark = markSvg();
writeFileSync(join(iconsDir, "moondigest-mark.svg"), mark);

// Preview sheet: icons at 1x on light and dark toolbar colours, nearest-neighbour zooms, and the brand mark
// filled with --accent at 20 and 64 px, as .brand-mark paints it.
const uri = (b) => `data:image/png;base64,${Buffer.from(b).toString("base64")}`;
const accentMark = markSvg("#ff6699"); // --accent
const markPng = (h) => new Resvg(accentMark, { fitTo: { mode: "height", value: h } }).render().asPng();
const rows = [["#F1F3F4", "#202124", "Light toolbar"], ["#35363A", "#E8EAED", "Dark toolbar"]];
const markAspect = Number(mark.match(/width="([\d.]+)"/)[1]) / 20;
let body = "";
const RH = 450;
rows.forEach(([bg, fg, label], r) => {
  const y = 20 + r * RH;
  body += `<rect x="0" y="${y - 20}" width="620" height="${RH}" fill="${bg}"/><text x="20" y="${y + 6}" fill="${fg}" font-family="Helvetica" font-size="15">${label}: 1x</text>`;
  let x = 20;
  for (const sz of SIZES) {
    body += `<image x="${x}" y="${y + 24}" width="${sz}" height="${sz}" href="${uri(pngs[sz])}"/>`;
    x += sz + 24;
  }
  body += `<text x="20" y="${y + 176}" fill="${fg}" font-family="Helvetica" font-size="15">16 at 8x, 32 at 4x, 48 at 3x (pixel view)</text>`;
  x = 20;
  for (const [sz, k] of [[16, 8], [32, 4], [48, 3]]) {
    body += `<image x="${x}" y="${y + 186}" width="${sz * k}" height="${sz * k}" image-rendering="optimizeSpeed" href="${uri(pngs[sz])}"/>`;
    x += sz * k + 30;
  }
  body += `<text x="20" y="${y + 346}" fill="${fg}" font-family="Helvetica" font-size="15">Brand mark (--accent): 20 px and 64 px</text>`;
  x = 20;
  for (const h of [20, 64]) {
    const w = h * markAspect;
    body += `<image x="${x}" y="${y + 360}" width="${w}" height="${h}" href="${uri(markPng(h))}"/>`;
    x += w + 24;
  }
});
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="${RH * 2}" viewBox="0 0 620 ${RH * 2}">${body}</svg>`;
writeFileSync(join(here, "preview.png"), render(sheet, { font: { loadSystemFonts: true } }));
console.log("wrote", SIZES.map((s) => `icon${s}`).join(", "), "moondigest-mark.svg and preview.png");
