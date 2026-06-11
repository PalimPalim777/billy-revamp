import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

let T = null;
function crc32(buf) {
  if (!T) {
    T = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      T[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function writePng(path, S, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(S * (1 + S * 4));
  for (let y = 0; y < S; y++) {
    const row = y * (1 + S * 4);
    raw[row] = 0;
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 3;
      const o = row + 1 + x * 4;
      raw[o] = Math.round(rgb[i]);
      raw[o + 1] = Math.round(rgb[i + 1]);
      raw[o + 2] = Math.round(rgb[i + 2]);
      raw[o + 3] = 255;
    }
  }
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  writeFileSync(path, png);
  console.log('wrote ' + path + ' (' + png.length + ' bytes)');
}

const AMBER = [255, 159, 10];
const SCALE = 0.72;
function sc(v) { return 0.5 + (v - 0.5) * SCALE; }

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  let t = L2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx, qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

function render(S) {
  const rgb = new Float64Array(S * S * 3);
  const C = { x: sc(0.5) * S, y: sc(0.5) * S, r: 0.17 * SCALE * S };
  const sats = [
    { x: sc(0.5) * S, y: sc(0.14) * S },
    { x: sc(0.17) * S, y: sc(0.71) * S },
    { x: sc(0.83) * S, y: sc(0.71) * S }
  ];
  const satR = 0.085 * SCALE * S;
  const halfW = (0.05 * SCALE * S) / 2;

  function paint(coverageFn, opacity) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const cov = coverageFn(x + 0.5, y + 0.5);
        if (cov <= 0) continue;
        const a = opacity * Math.min(1, cov);
        const i = (y * S + x) * 3;
        rgb[i] = AMBER[0] * a + rgb[i] * (1 - a);
        rgb[i + 1] = AMBER[1] * a + rgb[i + 1] * (1 - a);
        rgb[i + 2] = AMBER[2] * a + rgb[i + 2] * (1 - a);
      }
    }
  }

  for (const s of sats) {
    paint(function (px, py) {
      return Math.max(0, Math.min(1, halfW - distSeg(px, py, C.x, C.y, s.x, s.y) + 0.5));
    }, 0.35);
  }
  for (const s of sats) {
    paint(function (px, py) {
      return Math.max(0, Math.min(1, satR - Math.hypot(px - s.x, py - s.y) + 0.5));
    }, 0.55);
  }
  paint(function (px, py) {
    return Math.max(0, Math.min(1, C.r - Math.hypot(px - C.x, py - C.y) + 0.5));
  }, 1.0);

  return rgb;
}

mkdirSync('public/icons', { recursive: true });
for (const S of [180, 192, 512]) {
  writePng('public/icons/billy-' + S + '.png', S, render(S));
}
console.log('done');
