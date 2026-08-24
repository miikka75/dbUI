// make-icon-png.mjs — render an SVG to a square PNG, using the Chromium that Playwright already
// ships for the E2E suite. No image library, no new dependency.
//
// Why a PNG at all: the PWA manifest declares its install icon as `image/png` (Chromium wants one
// square PNG >= 144px to offer installation, and iOS ignores an SVG apple-touch-icon), so a schema
// that brands its tab with an SVG still needs a raster for the installed app.
//
// Why committed rather than generated at build time: there is no build step. The PNG is a source
// artifact like icon-512.png, and this script is how you regenerate it when the SVG changes.
//
//   node dev/make-icon-png.mjs examples/chores-favicon.svg examples/chores-icon-512.png 512
//
// The rendered icon is FULL-BLEED: the manifest declares `purpose: "any maskable"`, so a launcher may
// crop it to a circle. A rounded-rect favicon masked that way loses its corners and looks like a
// mistake, so the background is drawn edge to edge and the artwork inset into the safe zone.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , svgPath, outPath, sizeArg] = process.argv;
if (!svgPath || !outPath) {
  console.error('usage: node dev/make-icon-png.mjs <in.svg> <out.png> [size]');
  process.exit(2);
}
const size = Number(sizeArg || 512);
const svg = readFileSync(svgPath, 'utf8');

// The source SVG comes in two shapes, and they want opposite treatment.
//
// WITH a full-bleed background rect (the branded example icons): drop the rounded corner and inset the
// artwork to 80%. The manifest declares `purpose: "any maskable"`, so a launcher may crop to a circle
// -- a rounded rect loses its corners, and artwork drawn to the edge loses them too.
//
// WITHOUT one (the app default, a bare MDI glyph): render TRANSPARENT and inset the same way. Nothing
// is painted behind it, so the icon sits on whatever the tab or launcher provides.
const SAFE = 0.8;
const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1];
if (!vb) throw new Error(svgPath + ': no viewBox, so there is no way to know what to inset');
const [, , vbW, vbH] = vb.trim().split(/[\s,]+/).map(Number);
const inset = (vbW * (1 - SAFE)) / 2;

const bgRect = svg.match(/<rect width="[\d.]+" height="[\d.]+"(?![^>]*\sx=)[^>]*\/>/);
const transparent = !bgRect;
const open = svg.slice(0, svg.indexOf('>') + 1).replace(/\s(width|height)="[^"]*"/g, '');
const inner = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));

let body;
if (bgRect) {
  const bg = bgRect[0].replace(/\srx="[\d.]+"/, '');
  const rest = inner.slice(inner.indexOf(bgRect[0]) + bgRect[0].length);
  body = bg + `<g transform="translate(${inset},${inset}) scale(${SAFE})">${rest}</g>`;
} else {
  body = `<g transform="translate(${inset},${inset}) scale(${SAFE})">${inner}</g>`;
}
const out = open + body + '</svg>';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
void vbH;   // only the width is needed for a square inset; kept for the reader
await page.setContent(
  `<!doctype html><style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
   svg{display:block;width:${size}px;height:${size}px}</style>${out}`,
  { waitUntil: 'load' }
);
const buf = await page.screenshot({ type: 'png', omitBackground: transparent });
await browser.close();
writeFileSync(outPath, buf);
console.log(`${path.basename(outPath)}: ${size}x${size}, ${buf.length} bytes` + (transparent ? ', transparent' : ''));
