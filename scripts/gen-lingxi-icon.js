/*
 * Generate public/providers/lingxi.png — 128×128 rounded-square tile,
 * WPS red gradient + 灵犀 spark mark (white). Zero deps: hand-rolled PNG
 * encoder over zlib deflate.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 128;
const R = 28; // corner radius

// WPS brand red → orange diagonal gradient
function gradient(x, y) {
  const t = (x + y) / (2 * SIZE);
  const c1 = [227, 77, 63]; // #E34D3F
  const c2 = [250, 140, 66]; // #FA8C42
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}

function insideRoundedSquare(x, y) {
  const min = R, maxX = SIZE - 1 - R, maxY = SIZE - 1 - R;
  const cx = Math.max(min, Math.min(maxX, x));
  const cy = Math.max(min, Math.min(maxY, y));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= R * R;
}

// Spark mark: classic 4-point star — octagon outline (4 long tips + 4 short waist corners)
function sparkAlpha(x, y) {
  const cx = 64, cy = 64;
  const dx = Math.abs(x - cx), dy = Math.abs(y - cy); // fold to first quadrant
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > 44) return 0;
  // star outline polygon (quadrant): tip (44,0) → waist (10,10) → (0,44)
  // edge test: point is inside if it lies below both straight edges tip→waist and waist→tip2
  // quadrant polygon: tip (44,0) → waist (10,10) → tip2 (0,44) → center (0,0)
  const inPoly = pointInTriangle(dx, dy, [0, 0], [44, 0], [10, 10]) || pointInTriangle(dx, dy, [0, 0], [10, 10], [0, 44]);
  if (!inPoly) return 0;
  return 1; // (AA handled by supersampling below)
}

function pointInTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}

// 3×3 supersampled coverage for smooth edges
function sparkCoverage(x, y) {
  let acc = 0;
  for (let sy = -1; sy <= 1; sy++) {
    for (let sx = -1; sx <= 1; sx++) {
      acc += sparkAlpha(x + sx / 3, y + sy / 3);
    }
  }
  return acc / 9;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter none
  for (let x = 0; x < SIZE; x++) {
    if (!insideRoundedSquare(x, y)) {
      raw[p++] = 0; raw[p++] = 0; raw[p++] = 0; raw[p++] = 0;
      continue;
    }
    const [r, g, b] = gradient(x, y);
    const sa = sparkCoverage(x, y);
    // white spark over gradient
    const outR = Math.round(r + (255 - r) * sa);
    const outG = Math.round(g + (255 - g) * sa);
    const outB = Math.round(b + (255 - b) * sa);
    raw[p++] = outR; raw[p++] = outG; raw[p++] = outB; raw[p++] = 255;
  }
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../public/providers/lingxi.png", import.meta.url), png);
console.log("written", png.length, "bytes");
