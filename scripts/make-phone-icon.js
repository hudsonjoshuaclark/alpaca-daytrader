// Generates the home-screen icons for the iPhone dashboard (/phone).
//
// Hand-rolled PNG encoder rather than a dependency: this repo has none, and pulling in a
// canvas library to draw five line segments twice a year is not a trade worth making. Run
// it only when the icon artwork changes - the PNGs it writes are committed.
//
//   node scripts/make-phone-icon.js
//
// iOS will not accept an SVG for apple-touch-icon, and it composites the icon onto black
// before applying its own squircle mask, so these are written opaque (no alpha channel) at
// full bleed with no rounding of our own.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x10, 0x11, 0x10];
const LINE = [0x0c, 0xa3, 0x0c];   // --good, the same green the dashboards use for a gain
const AXIS = [0x2c, 0x2c, 0x2a];   // --grid

// The equity curve, in 0..1 icon space with y measured downward. Deliberately not a
// straight diagonal - a real equity curve has a drawdown in it.
const CURVE = [[0.13, 0.70], [0.31, 0.55], [0.45, 0.63], [0.63, 0.37], [0.87, 0.19]];

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function blend(dst, off, color, alpha) {
  if (alpha <= 0) return;
  for (let c = 0; c < 3; c++) {
    dst[off + c] = Math.round(dst[off + c] * (1 - alpha) + color[c] * alpha);
  }
}

// Coverage of a shape whose signed distance from the pixel centre is `d`, antialiased over
// one pixel. Keeps the diagonals clean at 180px, where aliasing is very visible.
const coverage = (d, radius) => Math.max(0, Math.min(1, radius - d + 0.5));

function draw(size) {
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) px.set(BG, i * 3);

  const pts = CURVE.map(([x, y]) => [x * size, y * size]);
  const strokeR = size * 0.038;   // half-width of the equity line
  const dotR = size * 0.062;      // the "today" marker on the final point
  const axisY = size * 0.845;
  const axisR = size * 0.008;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      const off = (y * size + x) * 3;

      if (cx > size * 0.11 && cx < size * 0.92) {
        blend(px, off, AXIS, coverage(Math.abs(cy - axisY), axisR));
      }

      let d = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        d = Math.min(d, distToSegment(cx, cy, pts[i], pts[i + 1]));
      }
      blend(px, off, LINE, coverage(d, strokeR));

      const last = pts[pts.length - 1];
      blend(px, off, LINE, coverage(Math.hypot(cx - last[0], cy - last[1]), dotR));
    }
  }
  return px;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type 2 = truecolour, no alpha
  // Each scanline is prefixed with filter type 0 (None). The artwork is flat colour over a
  // flat background, so deflate handles it well without per-line filtering.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });
// 180 is what current iPhones request for apple-touch-icon; 512 covers the web manifest
// (and anything that rescales, which is better done from the larger source).
for (const size of [180, 512]) {
  const file = path.join(OUT, `phone-icon-${size}.png`);
  fs.writeFileSync(file, encodePng(draw(size), size));
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${size}x${size})`);
}
