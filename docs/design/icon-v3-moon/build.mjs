// Generates the moon-dumpling (月团 A5) toolbar icons: SVG sources, PNGs, and a preview sheet.
// No tile: the 月团 alone on a transparent canvas, fitted to the canvas so it reads as large as possible.
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

const defs = `<defs>
<linearGradient id="pink" x1="82.3" y1="55.1" x2="174.7" y2="186.8" gradientUnits="userSpaceOnUse"><stop stop-color="#FFE4EC"/><stop offset="0.52" stop-color="#EE9DBD"/><stop offset="1" stop-color="#C45B97"/></linearGradient>
<linearGradient id="lilac" x1="78.7" y1="120" x2="89" y2="177.5" gradientUnits="userSpaceOnUse"><stop stop-color="#EEE5FF"/><stop offset="0.52" stop-color="#B7A0FF"/><stop offset="1" stop-color="#7354D8"/></linearGradient>
</defs>`;

// Per size: stroke weights are in artwork units. `fill` is the share of the canvas the artwork's longer side
// takes; `gap` cuts the body and back orbit away around the front orbit at small sizes (a transparent gap,
// like the menu-bar version). Eyes are in px so they land on whole pixels at small sizes.
const sizes = {
  128: { fill: 0.98, orbit: 13, outline: 0, back: "loop", eyes: null },
  48: { fill: 1, orbit: 15, outline: 0, back: "loop", eyes: { h: 4, w: 2 } },
  32: { fill: 1, orbit: 19, outline: 0, back: "loop", eyes: { h: 3, w: 1 } },
  16: { fill: 1, orbit: 24, outline: 0, back: "arc", gap: 16, eyes: { h: 2, w: 1 } },
};

// Artwork bounds in 256 units for one size's strokes, measured from a 1024 px render (1 unit = 4 px).
function measure(c) {
  const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 256 256">${defs}${artPaths(c)}</svg>`;
  const { width, height, pixels } = new Resvg(probe).render();
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  return { x: x0 / 4, y: y0 / 4, w: (x1 - x0 + 1) / 4, h: (y1 - y0 + 1) / 4 };
}

function artPaths(c) {
  const art = [];
  const back = c.back === "loop"
    ? `<path d="${ORBIT_BACK}" stroke="#706DAB" stroke-width="${c.orbit}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
    : `<path d="${ORBIT_BACK_ARC}" stroke="#706DAB" stroke-width="${c.orbit}" stroke-linecap="round" fill="none"/>`;
  const body = `<path d="${BODY}" fill="url(#pink)"${c.outline ? ` stroke="#FFFFFF" stroke-width="${c.outline}" stroke-linejoin="round" paint-order="stroke"` : ""}/>`;
  if (c.gap) {
    art.push(`<mask id="gap" maskUnits="userSpaceOnUse" x="-64" y="-64" width="384" height="384"><rect x="-64" y="-64" width="384" height="384" fill="#fff"/><path d="${ORBIT_FRONT}" stroke="#000" stroke-width="${c.orbit + c.gap}" stroke-linecap="round" fill="none"/></mask>`);
    art.push(`<g mask="url(#gap)">${back}${body}</g>`);
  } else {
    art.push(back, body);
  }
  art.push(`<path d="${ORBIT_FRONT}" stroke="url(#lilac)" stroke-width="${c.orbit}" stroke-linecap="round" fill="none"/>`);
  if (!c.eyes) art.push(`<rect x="108" y="105" width="9" height="20" rx="4.5" fill="#6A3D61"/><rect x="139" y="105" width="9" height="20" rx="4.5" fill="#6A3D61"/>`);
  return art.join("");
}

function svg(size) {
  const c = sizes[size];
  const ART = measure(c);
  const s = (size * c.fill) / Math.max(ART.w, ART.h);
  const cx = ART.x + ART.w / 2;
  const cy = ART.y + ART.h / 2;
  const mid = size / 2;
  const px = (x, y) => [mid + (x - cx) * s, mid + (y - cy) * s];
  // Eyes: centred on the artwork's eye columns (112.5 and 143.5, top 105), rounded to whole pixels.
  const eyes = c.eyes
    ? [112.5, 143.5].map((ex) => {
        const [x, y] = px(ex, 105);
        return `<rect x="${Math.round(x - c.eyes.w / 2)}" y="${Math.round(y)}" width="${c.eyes.w}" height="${c.eyes.h}" rx="${Math.min(c.eyes.w / 2, 0.8)}" fill="#6A3D61"/>`;
      }).join("")
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}
<g transform="translate(${mid} ${mid}) scale(${+s.toFixed(5)}) translate(${-cx} ${-cy})">${artPaths(c)}</g>${eyes}
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
