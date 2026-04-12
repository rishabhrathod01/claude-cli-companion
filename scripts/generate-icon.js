#!/usr/bin/env node
/**
 * Generates icon.png (128x128) using only Node.js built-ins (zlib).
 * Design: dark rounded terminal window with >_ prompt in Claude orange.
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 128;
// RGBA pixel buffer
const pixels = new Uint8Array(SIZE * SIZE * 4);

// ─── Colour palette ───────────────────────────────────────────────────────────
const TRANSPARENT  = [0,   0,   0,   0  ];
const BG           = [22,  22,  26,  255]; // #16161a  card background
const HEADER       = [32,  32,  38,  255]; // #202026  title-bar strip
const ORANGE       = [218, 107,  43,  255]; // #DA6B2B  Claude orange
const CURSOR_GREY  = [140, 140, 155, 255]; // underscore / cursor
const DOT_RED      = [255,  90,  90,  255];
const DOT_YEL      = [255, 185,  50,  255];
const DOT_GRN      = [ 80, 200, 120,  255];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function px(x, y, [r, g, b, a]) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = a;
}

function fillRect(x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++)
      px(x, y, color);
}

function circle(cx, cy, r, color) {
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++)
      if ((x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r)
        px(x, y, color);
}

/** Filled rounded rectangle */
function roundRect(x0, y0, w, h, r, color) {
  // Fill body minus corners
  fillRect(x0 + r, y0,     w - 2*r, h,       color);
  fillRect(x0,     y0 + r, r,       h - 2*r, color);
  fillRect(x0+w-r, y0 + r, r,       h - 2*r, color);
  // Four corner circles
  circle(x0+r,   y0+r,   r, color);
  circle(x0+w-r, y0+r,   r, color);
  circle(x0+r,   y0+h-r, r, color);
  circle(x0+w-r, y0+h-r, r, color);
}

/**
 * Draw a single glyph from a tiny bitmap font (5×7 grid, 1=on).
 * Each glyph is an array of 7 rows, each row a 5-bit number (MSB=left).
 */
const GLYPHS = {
  '>': [
    0b10000,
    0b11000,
    0b11100,
    0b11110,
    0b11100,
    0b11000,
    0b10000,
  ],
  '_': [
    0b00000,
    0b00000,
    0b00000,
    0b00000,
    0b00000,
    0b00000,
    0b11111,
  ],
};

function drawGlyph(glyph, x0, y0, scale, color) {
  const rows = GLYPHS[glyph];
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < 5; col++) {
      if (rows[row] & (1 << (4 - col))) {
        fillRect(x0 + col * scale, y0 + row * scale, scale, scale, color);
      }
    }
  }
}

// ─── Draw icon ────────────────────────────────────────────────────────────────

// 1. Transparent canvas
fillRect(0, 0, SIZE, SIZE, TRANSPARENT);

// 2. Card background (rounded rect, 4px inset on each side)
const PAD = 4, RADIUS = 18;
roundRect(PAD, PAD, SIZE - 2*PAD, SIZE - 2*PAD, RADIUS, BG);

// 3. Title bar strip at top
//    Mask to stay inside the rounded rect: draw as rect then re-round the top
fillRect(PAD + RADIUS, PAD,            SIZE - 2*(PAD+RADIUS), 28,  HEADER);
fillRect(PAD,          PAD + RADIUS,   SIZE - 2*PAD,          28 - RADIUS + 2, HEADER);
circle(PAD + RADIUS,            PAD + RADIUS, RADIUS, HEADER);
circle(SIZE - PAD - RADIUS - 1, PAD + RADIUS, RADIUS, HEADER);

// 4. Traffic-light dots in title bar
circle(24, PAD + 14, 5, DOT_RED);
circle(38, PAD + 14, 5, DOT_YEL);
circle(52, PAD + 14, 5, DOT_GRN);

// 5. Prompt  >_  centred in the lower two-thirds of the card
//    Scale=7 → glyph is 35×49 px; two glyphs + 6px gap = 76px wide
const SCALE = 7;
const GLYPH_W = 5 * SCALE;          // 35
const GAP     = 6;
const totalW  = 2 * GLYPH_W + GAP;  // 76
const startX  = Math.round((SIZE - totalW) / 2);
const startY  = Math.round((SIZE + 28) / 2) - Math.round((7 * SCALE) / 2) + 4;

drawGlyph('>', startX,               startY, SCALE, ORANGE);
drawGlyph('_', startX + GLYPH_W + GAP, startY, SCALE, CURSOR_GREY);

// ─── Encode PNG ───────────────────────────────────────────────────────────────

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  for (let i = 0; i < buf.length; i++)
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf    = Buffer.allocUnsafe(4);
  const crcBuf    = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// IHDR
const ihdr = Buffer.allocUnsafe(13);
ihdr.writeUInt32BE(SIZE, 0); // width
ihdr.writeUInt32BE(SIZE, 4); // height
ihdr[8]  = 8;  // bit depth
ihdr[9]  = 6;  // colour type: RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

// Raw scanlines: each row prefixed with filter byte 0 (None)
const raw = Buffer.allocUnsafe(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0; // filter none
  pixels.copy
    ? Buffer.from(pixels.buffer).copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y+1) * SIZE * 4)
    : raw.set(pixels.subarray(y * SIZE * 4, (y+1) * SIZE * 4), y * (1 + SIZE * 4) + 1);
}

const compressed = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`icon.png written (${png.length} bytes)`);
