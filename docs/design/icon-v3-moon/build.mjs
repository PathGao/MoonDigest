// Generates the moon-dumpling (月团 A5) toolbar icons: SVG sources, PNGs, and a preview sheet.
// Run from the repo root: bun docs/design/icon-v3-moon/build.mjs
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, "../../../extension/icons");

const BODY = "M81 89C82.3333 68.3333 93 61 113 67C134.333 48.3333 151.333 51.6667 164 77C189.333 86.3333 195 107.333 181 140C180.333 164 167.333 177.667 142 181C116.667 197 98.6667 193.333 88 170C60.6667 166 52.6667 153 64 131C60.6667 113.667 66.3333 99.6667 81 89Z";
const ORBIT_BACK = "M49 150C20 93 191 78 207 111C223 143 72 184 49 150Z";
const ORBIT_BACK_ARC = "M49 150C20 93 191 78 207 111";
const ORBIT_FRONT = "M51 145C70 179 184 153 205 120";
const PLAY = "M182 55.5L198 66L182 76.5Z";

const defs = `<defs>
<linearGradient id="pink" x1="82.3" y1="55.1" x2="174.7" y2="186.8" gradientUnits="userSpaceOnUse"><stop stop-color="#FFE4EC"/><stop offset="0.52" stop-color="#EE9DBD"/><stop offset="1" stop-color="#C45B97"/></linearGradient>
<linearGradient id="lilac" x1="78.7" y1="120" x2="89" y2="177.5" gradientUnits="userSpaceOnUse"><stop stop-color="#EEE5FF"/><stop offset="0.52" stop-color="#B7A0FF"/><stop offset="1" stop-color="#7354D8"/></linearGradient>
</defs>`;

// Per size: tile placement in px (matches the margins of the previous icon sets), stroke weights in
// 256-unit artwork space, an optional art zoom about the tile centre, and eyes in px so they land on whole pixels at small sizes.
const sizes = {
  128: { m: 10, tile: 108, rx: 24, orbit: 13, play: 5, back: "loop", border: true, eyes: null },
  48: { m: 4, tile: 40, rx: 9, orbit: 15, play: 7, back: "loop", border: false, eyes: { y: 20, h: 4, w: 2, x: [20, 25] } },
  32: { m: 3, tile: 26, rx: 6, orbit: 19, play: 10, back: "loop", border: false, eyes: { y: 13, h: 3, w: 1, x: [14, 17] }, playScale: 1.35 },
  16: { m: 1, tile: 14, rx: 3.5, zoom: 1.15, orbit: 24, play: 0, back: "arc", gap: 16, border: false, eyes: { y: 6, h: 2, w: 1, x: [6, 9] } },
};

function svg(size) {
  const c = sizes[size];
  const s = (c.tile / 240) * (c.zoom ?? 1);
  const mid = c.m + c.tile / 2;
  const art = [];
  art.push(c.back === "loop"
    ? `<path d="${ORBIT_BACK}" stroke="#706DAB" stroke-width="${c.orbit}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
    : `<path d="${ORBIT_BACK_ARC}" stroke="#706DAB" stroke-width="${c.orbit}" stroke-linecap="round" fill="none"/>`);
  art.push(`<path d="${BODY}" fill="url(#pink)"${size === 128 ? ` stroke="#F8D8EA" stroke-width="2"` : ""}/>`);
  // Small sizes cut a tile-coloured gap between body and front orbit, as the menu-bar version does.
  if (c.gap) art.push(`<path d="${ORBIT_FRONT}" stroke="#27283F" stroke-width="${c.orbit + c.gap}" stroke-linecap="round" fill="none"/>`);
  art.push(`<path d="${ORBIT_FRONT}" stroke="url(#lilac)" stroke-width="${c.orbit}" stroke-linecap="round" fill="none"/>`);
  if (!c.eyes) art.push(`<rect x="108" y="105" width="9" height="20" rx="4.5" fill="#6A3D61"/><rect x="139" y="105" width="9" height="20" rx="4.5" fill="#6A3D61"/>`);
  if (c.play) {
    const k = c.playScale ?? 1;
    art.push(`<path d="${PLAY}" transform="translate(190 66) scale(${k}) translate(-190 -66)" fill="#FFE4A7" stroke="#FFE4A7" stroke-width="${c.play}" stroke-linejoin="round"/>`);
  }
  const eyes = c.eyes
    ? c.eyes.x.map((x) => `<rect x="${x}" y="${c.eyes.y}" width="${c.eyes.w}" height="${c.eyes.h}" rx="${Math.min(c.eyes.w / 2, 0.8)}" fill="#6A3D61"/>`).join("")
    : "";
  const border = c.border
    ? `<rect x="${c.m + 0.25}" y="${c.m + 0.25}" width="${c.tile - 0.5}" height="${c.tile - 0.5}" rx="${c.rx - 0.25}" fill="none" stroke="#FFFFFF" stroke-width="0.5" opacity=".35"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}
<rect x="${c.m}" y="${c.m}" width="${c.tile}" height="${c.tile}" rx="${c.rx}" fill="#27283F"/>
<g transform="translate(${mid} ${mid}) scale(${+s.toFixed(5)}) translate(-128 -128)">${art.join("")}</g>${eyes}${border}
</svg>
`;
}

const render = (src, opts = {}) => new Resvg(src, { shapeRendering: 2, ...opts }).render().asPng();

const pngs = {};
for (const size of Object.keys(sizes).map(Number)) {
  const src = svg(size);
  writeFileSync(join(here, `icon${size}.svg`), src);
  pngs[size] = render(src);
  writeFileSync(join(iconsDir, `icon${size}.png`), pngs[size]);
}

// Preview sheet: 1x on light and dark toolbar colours, plus nearest-neighbour zooms.
const uri = (b) => `data:image/png;base64,${Buffer.from(b).toString("base64")}`;
const order = [16, 32, 48, 128];
const rows = [["#F1F3F4", "#202124", "Light toolbar"], ["#35363A", "#E8EAED", "Dark toolbar"]];
let body = "";
rows.forEach(([bg, fg, label], r) => {
  const y = 20 + r * 360;
  body += `<rect x="0" y="${y - 20}" width="620" height="360" fill="${bg}"/><text x="20" y="${y + 6}" fill="${fg}" font-family="Helvetica" font-size="15">${label}: 1x</text>`;
  let x = 20;
  for (const sz of order) {
    body += `<image x="${x}" y="${y + 24}" width="${sz}" height="${sz}" href="${uri(pngs[sz])}"/>`;
    x += sz + 24;
  }
  body += `<text x="20" y="${y + 176}" fill="${fg}" font-family="Helvetica" font-size="15">16 at 8x, 32 at 4x, 48 at 3x (pixel view)</text>`;
  x = 20;
  for (const [sz, k] of [[16, 8], [32, 4], [48, 3]]) {
    body += `<image x="${x}" y="${y + 186}" width="${sz * k}" height="${sz * k}" image-rendering="optimizeSpeed" href="${uri(pngs[sz])}"/>`;
    x += sz * k + 30;
  }
});
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="720" viewBox="0 0 620 720">${body}</svg>`;
mkdirSync(here, { recursive: true });
writeFileSync(join(here, "preview.png"), render(sheet, { font: { loadSystemFonts: true } }));
console.log("wrote", order.map((s) => `icon${s}`).join(", "), "and preview.png");
