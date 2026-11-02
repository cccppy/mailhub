/**
 * 生成插件图标（16/32/48/128 PNG）。
 * 纯手写 PNG 编码 + 4 倍超采样抗锯齿，不依赖任何第三方库。
 *
 * 用法：node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });

/* ---------------- PNG 编码 ---------------- */

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 图形 ---------------- */

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const TOP = [0x3b, 0x82, 0xf6]; // #3b82f6
const BOTTOM = [0x1d, 0x4e, 0xd8]; // #1d4ed8
const WHITE = [0xff, 0xff, 0xff];

/** 圆角矩形命中测试，坐标与尺寸都是 0~1 的归一化值 */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 点是否在三角形内（重心坐标法） */
function inTriangle(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// 信封上盖的三角：从上边两角向中间折下来
const FLAP = [
  [0.24, 0.325],
  [0.5, 0.55],
  [0.76, 0.325],
];

/** 单个采样点的颜色，返回 [r,g,b,a] */
function sample(x, y) {
  // 底板
  if (!inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.21)) return [0, 0, 0, 0];

  const bg = mix(TOP, BOTTOM, clamp01((y - 0.02) / 0.96));
  if (!inRoundRect(x, y, 0.23, 0.325, 0.77, 0.685, 0.035)) return [...bg, 255];
  if (inTriangle(x, y, FLAP[0], FLAP[1], FLAP[2])) return [...bg, 255];
  return [...WHITE, 255];
}

function render(size, ss = 4) {
  const buf = Buffer.alloc(size * size * 4);
  const step = 1 / (size * ss);
  const samples = ss * ss;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const x = (px * ss + sx + 0.5) * step;
          const y = (py * ss + sy + 0.5) * step;
          const [sr, sg, sb, sa] = sample(x, y);
          const w = sa / 255;
          r += sr * w;
          g += sg * w;
          b += sb * w;
          a += sa;
        }
      }
      const alphaAvg = a / samples;
      const wsum = a / 255 || 1;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(clamp01(r / wsum / 255) * 255);
      buf[i + 1] = Math.round(clamp01(g / wsum / 255) * 255);
      buf[i + 2] = Math.round(clamp01(b / wsum / 255) * 255);
      buf[i + 3] = Math.round(alphaAvg);
    }
  }
  return buf;
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log(`已生成 ${path.relative(process.cwd(), file)}`);
}
