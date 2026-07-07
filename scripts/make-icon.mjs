/**
 * Generates the PWA icons (icon-180.png, icon-512.png) with no dependencies:
 * a warm-red tile with a white "article page" and text lines.
 * Run: node scripts/make-icon.mjs
 */
import { writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function inRoundedRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.max(Math.abs(x - cx) - (hw - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (hh - r), 0);
  return dx * dx + dy * dy <= r * r;
}

const BG = [0xb3, 0x43, 0x2b];     // accent red
const PAGE = [0xfd, 0xfa, 0xf4];   // warm white
const LINE = [0xb3, 0x43, 0x2b];

function drawIcon(size) {
  const s = size / 180;
  const rgba = Buffer.alloc(size * size * 4);
  const page = { cx: 90 * s, cy: 90 * s, hw: 52 * s, hh: 62 * s, r: 8 * s };
  // text lines on the page: [y, xStart, xEnd]
  const lines = [
    [52, 55, 125], [72, 55, 125], [92, 55, 125], [112, 55, 100],
  ].map(([y, x1, x2]) => [y * s, x1 * s, x2 * s]);
  const lineH = 7 * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = BG;
      if (inRoundedRect(x, y, page.cx, page.cy, page.hw, page.hh, page.r)) {
        c = PAGE;
        for (const [ly, x1, x2] of lines) {
          if (y >= ly && y < ly + lineH && x >= x1 && x <= x2) { c = LINE; break; }
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

for (const size of [180, 512]) {
  const file = path.join(ROOT, `icon-${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`wrote ${file}`);
}
