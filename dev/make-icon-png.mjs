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

// Two changes for a MASKABLE icon, which is what the manifest declares:
//
//  - the rounded corner goes. The favicon is read at 16px in a tab, where rounding helps; the install
//    icon is cropped by the launcher, where a rounded rect just loses its corners and looks broken.
//    The background is drawn edge to edge instead.
//  - the artwork is inset to 80% about the centre. A maskable icon's safe zone is the inner circle of
//    80% diameter, and at full size this artwork's lower corners land exactly on that boundary -- fine
//    on a square launcher, clipped on a round one.
const SAFE = 0.8;
const inset = (32 * (1 - SAFE)) / 2;
const bgRect = svg.match(/<rect width="32" height="32"[^>]*\/>/);
if (!bgRect) throw new Error(svgPath + ': no full-size background rect to keep full-bleed');
const bg = bgRect[0].replace(/\srx="[\d.]+"/, '');
const rest = svg.slice(svg.indexOf(bgRect[0]) + bgRect[0].length, svg.lastIndexOf('</svg>'));
const fullBleed = svg.slice(0, svg.indexOf(bgRect[0]))
  .replace(/\swidth="32"\s+height="32"/, '')
  + bg
  + `<g transform="translate(${inset},${inset}) scale(${SAFE})">${rest}</g>`
  + '</svg>';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
await page.setContent(
  `<!doctype html><style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
   svg{display:block;width:${size}px;height:${size}px}</style>${fullBleed}`,
  { waitUntil: 'load' }
);
const buf = await page.screenshot({ type: 'png', omitBackground: false });
await browser.close();
writeFileSync(outPath, buf);
console.log(`${path.basename(outPath)}: ${size}x${size}, ${buf.length} bytes`);
