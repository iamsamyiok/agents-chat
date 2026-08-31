#!/usr/bin/env node
// 生成桌面版图标（零依赖）：256x256 RGBA PNG → 包装为 .ico（Vista+ 支持 PNG-in-ICO）
// 图形：圆角方块绿底 + 白色三点群聊气泡（2x 超采样抗锯齿）
// 用法：node scripts/gen-icon.js  →  build/icon.png + build/icon.ico
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 2; // 超采样倍数
const N = SIZE * SS;

// ---- 像素绘制（N x N 画布，SSIZE 空间坐标）----
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}
function inCircle(x, y, cx, cy, r) {
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}
function hit(x, y) {
  // x,y 为 N 级坐标：先升到 SS 空间判定
  const sx = x / SS, sy = y / SS;
  if (!inRoundRect(sx, sy, 28, 28, 228, 208, 44)) return [0, 0, 0, 0]; // 透明背景
  const green = [31, 191, 117]; // 品牌绿
  // 气泡尾巴（右下小三角指向说话人）
  if (inRoundRect(sx, sy, 118, 196, 186, 232, 16) || inCircle(sx, sy, 118, 214, 18)) return [255, 255, 255, 255];
  // 主气泡内的三个白点
  for (const cx of [84, 128, 172]) {
    if (inCircle(sx, sy, cx, 118, 15)) return [255, 255, 255, 255];
  }
  return green;
}

// ---- PNG 编码 ----
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size) {
  // 降采样：N 级画布按 SSxSS 平均 → size 级 RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1)); // 每行 1 字节 filter 前缀
  const canvas = [];
  for (let y = 0; y < N; y++) {
    const row = [];
    for (let x = 0; x < N; x++) row.push(hit(x, y));
    canvas.push(row);
  }
  for (let y = 0; y < size; y++) {
    const line = y * (size * 4 + 1);
    raw[line] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
        const p = canvas[y * SS + dy][x * SS + dx];
        r += p[0]; g += p[1]; b += p[2]; a += p[3];
      }
      const n = SS * SS, o = line + 1 + x * 4;
      raw[o] = Math.round(r / n); raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n); raw[o + 3] = Math.round(a / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO 容器（单目录项 + 内嵌 PNG）----
function wrapIco(png) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // 1 张图
  const entry = Buffer.alloc(16);
  entry[0] = SIZE >= 256 ? 0 : SIZE; entry[1] = SIZE >= 256 ? 0 : SIZE; // 256 记 0
  entry.writeUInt16LE(1, 4); // 1 平面
  entry.writeUInt16LE(32, 6); // 32 bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // 数据偏移：6 + 16
  return Buffer.concat([head, entry, png]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePng(SIZE);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), wrapIco(png));
console.log(`已生成: build/icon.png (${(png.length / 1024).toFixed(1)} KB) + build/icon.ico (${((png.length + 22) / 1024).toFixed(1)} KB)`);
