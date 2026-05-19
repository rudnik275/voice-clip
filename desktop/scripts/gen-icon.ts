// Generates the Voice Clip macOS app icon source (1024×1024 RGBA PNG).
//
// Brand-matched to the PWA record button: a dark rounded tile with a soft
// accent aura and an accent-gradient microphone glyph (#7383ff → #b15eff,
// the same --accent-a/--accent-b tokens as web/style.css).
//
// Dependency-free: software SDF rasterizer + a minimal PNG encoder built on
// node:zlib. Output feeds `cargo tauri icon` which derives icon.icns /
// icon.ico / all PNG sizes.
//
//   bun run desktop/scripts/gen-icon.ts
//
// Writes desktop/src-tauri/icons/_source.png (1024²). Re-run to regenerate.

import { deflateSync } from "node:zlib";
import { mkdirSync } from "node:fs";

const SIZE = 1024;
const SS = 4; // 4×4 supersampling

// ---- brand palette ----------------------------------------------------------
const ACCENT_A = [0x73, 0x83, 0xff]; // #7383ff
const ACCENT_B = [0xb1, 0x5e, 0xff]; // #b15eff
const BG_TOP = [0x16, 0x14, 0x36]; // deep indigo
const BG_BOT = [0x07, 0x07, 0x0b]; // --bg-0

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: number[], b: number[], t: number) =>
  [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// signed distance to a rounded rect centred at (cx,cy), half-extents (hx,hy), radius r
function sdRoundRect(
  px: number,
  py: number,
  cx: number,
  cy: number,
  hx: number,
  hy: number,
  r: number,
) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// signed distance to a line segment a→b
function sdSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

// distance to a circular arc (centre c, radius R), spanning angles a0..a1 (rad)
function sdArc(
  px: number,
  py: number,
  cx: number,
  cy: number,
  R: number,
  a0: number,
  a1: number,
) {
  let ang = Math.atan2(py - cy, px - cx);
  if (ang < 0) ang += Math.PI * 2;
  let lo = a0;
  let hi = a1;
  if (ang >= lo && ang <= hi) return Math.abs(Math.hypot(px - cx, py - cy) - R);
  // outside the span → distance to the nearer endpoint
  const e0x = cx + R * Math.cos(a0);
  const e0y = cy + R * Math.sin(a0);
  const e1x = cx + R * Math.cos(a1);
  const e1y = cy + R * Math.sin(a1);
  return Math.min(Math.hypot(px - e0x, py - e0y), Math.hypot(px - e1x, py - e1y));
}

// The PWA mic lives in a 24-unit viewBox. Map it into a centred square.
const VB = 24;
const glyphSpan = SIZE * 0.5; // glyph box edge
const glyphScale = glyphSpan / VB;
const gx = (u: number) => (SIZE - glyphSpan) / 2 + u * glyphScale;
const stroke = 2 * glyphScale; // 2 viewBox units

function sample(px: number, py: number): [number, number, number, number] {
  // 1 ── dark rounded tile (transparent outside the radius)
  const tile = sdRoundRect(px, py, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, 230);
  const tileCov = smooth(1.0, -1.0, tile);
  if (tileCov <= 0) return [0, 0, 0, 0];

  // diagonal bg gradient
  const gt = clamp01((px + py) / (2 * SIZE));
  let rgb = lerp3(BG_TOP, BG_BOT, gt);

  // 2 ── soft accent aura behind the mic
  const aura =
    Math.exp(-(((px - SIZE / 2) ** 2 + (py - SIZE * 0.46) ** 2) /
      (2 * (SIZE * 0.34) ** 2))) * 0.42;
  rgb = lerp3(rgb, lerp3(ACCENT_A, ACCENT_B, 0.5), aura);

  // 3 ── microphone glyph (accent gradient, vertical)
  // capsule body: x 9..15, y 2..14, rx 3
  const body = sdRoundRect(
    px,
    py,
    gx(12), // cx (viewBox x 9..15)
    gx(8), // cy (viewBox y 2..14)
    3 * glyphScale, // hx = (15-9)/2
    6 * glyphScale, // hy = (14-2)/2
    3 * glyphScale, // corner radius (rx 3)
  );
  // cradle arc: centre (12,11) r 7, lower half (the "M5 11 a7 7 0 0 0 14 0")
  const cradle =
    sdArc(px, py, gx(12), gx(11), gx(7) - gx(0), 0, Math.PI) - stroke / 2;
  // stem: 12,18 → 12,22
  const stem = sdSegment(px, py, gx(12), gx(18), gx(12), gx(22)) - stroke / 2;
  // base bar: 8,22 → 16,22 (added for icon-scale weight)
  const base = sdSegment(px, py, gx(8), gx(22), gx(16), gx(22)) - stroke / 2;

  const mic = Math.min(body, cradle, stem, base);
  const micCov = smooth(0.75, -0.75, mic);
  if (micCov > 0) {
    const mt = clamp01((py - gx(2)) / (gx(22) - gx(2)));
    rgb = lerp3(rgb, lerp3(ACCENT_A, ACCENT_B, mt), micCov);
  }

  return [rgb[0], rgb[1], rgb[2], 255 * tileCov];
}

// ---- render with supersampling ---------------------------------------------
const px = new Uint8Array(SIZE * SIZE * 4);
const inv = 1 / (SS * SS);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0,
      g = 0,
      b = 0,
      a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const s = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += s[0];
        g += s[1];
        b += s[2];
        a += s[3];
      }
    }
    const o = (y * SIZE + x) * 4;
    px[o] = Math.round(r * inv);
    px[o + 1] = Math.round(g * inv);
    px[o + 2] = Math.round(b * inv);
    px[o + 3] = Math.round(a * inv);
  }
}

// ---- minimal PNG encoder (RGBA, no interlace) ------------------------------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const td = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i);
  td.set(data, 4);
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(td, 4);
  dv.setUint32(8 + data.length, crc32(td));
  return out;
}

function encodePng(w: number, h: number, pix: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, w);
  idv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    raw.set(pix.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const outDir = new URL("../src-tauri/icons/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
await Bun.write(outDir + "_source.png", encodePng(SIZE, SIZE, px));
console.log(`wrote _source.png (${SIZE}×${SIZE})`);

// ---- menu-bar template icon: black mic silhouette, transparent bg ----------
// macOS treats an all-black + alpha image as a template: it auto-inverts
// for light/dark menu bars and the highlight state.
const TS = 44; // ~22pt @2x
const TVB = 24; // reuse the mic viewBox
const tspan = TS * 0.78; // glyph fills most of the bar height
const tsc = tspan / TVB;
const tgx = (u: number) => (TS - tspan) / 2 + u * tsc;
const tstroke = 2.4 * tsc;
function trayAlpha(pxv: number, pyv: number): number {
  const body = sdRoundRect(pxv, pyv, tgx(12), tgx(8), 3 * tsc, 6 * tsc, 3 * tsc);
  const cradle =
    sdArc(pxv, pyv, tgx(12), tgx(11), tgx(7) - tgx(0), 0, Math.PI) - tstroke / 2;
  const stem = sdSegment(pxv, pyv, tgx(12), tgx(18), tgx(12), tgx(22)) - tstroke / 2;
  const base = sdSegment(pxv, pyv, tgx(8), tgx(22), tgx(16), tgx(22)) - tstroke / 2;
  return smooth(0.75, -0.75, Math.min(body, cradle, stem, base));
}
const tpx = new Uint8Array(TS * TS * 4);
for (let y = 0; y < TS; y++) {
  for (let x = 0; x < TS; x++) {
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        a += trayAlpha(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      }
    }
    const o = (y * TS + x) * 4;
    tpx[o + 3] = Math.round((255 * a) / (SS * SS)); // RGB stays 0 (black)
  }
}
await Bun.write(outDir + "tray.png", encodePng(TS, TS, tpx));
console.log(`wrote tray.png (${TS}×${TS} template)`);
