// Deterministic demo source generator. Outputs to demo/public/demo/.
//
//   photo.jpg     — 2000×1500, busy multi-color composition (typical web photo)
//   photo-4k.jpg  — 4000×3000, same kind of content at 4K (large source)
//   ui.png        — 1280× 800, flat UI mock with hard edges (screenshot-like)
//   portrait.jpg  — 2000×1500 stored with EXIF orientation=6 (auto-rotate test)
//
// Run from repo root: `node scripts/gen-demo-images.mjs`
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const OUT_DIR = "demo/public/demo";
await mkdir(OUT_DIR, { recursive: true });

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function fbm(width, height, octaves, seed) {
  const out = new Float32Array(width * height);
  const r = lcg(seed);
  for (let octave = 0; octave < octaves; octave++) {
    const cell = 1 << (3 + octave);
    const cx = Math.ceil(width / cell) + 1;
    const cy = Math.ceil(height / cell) + 1;
    const grid = new Float32Array(cx * cy);
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    const amp = 1 / (1 << octave);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const gx = Math.floor(x / cell);
        const gy = Math.floor(y / cell);
        const fx = (x % cell) / cell;
        const fy = (y % cell) / cell;
        const n00 = grid[gy * cx + gx];
        const n10 = grid[gy * cx + gx + 1];
        const n01 = grid[(gy + 1) * cx + gx];
        const n11 = grid[(gy + 1) * cx + gx + 1];
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const a = n00 + (n10 - n00) * sx;
        const b = n01 + (n11 - n01) * sx;
        out[y * width + x] += (a + (b - a) * sy) * amp;
      }
    }
  }
  return out;
}

async function generatePhoto(width, height, outPath, seed) {
  const buf = Buffer.alloc(width * height * 4);
  const noise = fbm(width, height, 5, seed);
  const r = lcg(seed ^ 0xa5a5);

  const palette = [
    [255, 138, 70],
    [80, 60, 180],
    [240, 70, 130],
    [70, 200, 180],
    [255, 220, 100],
    [40, 90, 130],
  ];

  const regionMap = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      regionMap[y * width + x] = Math.floor((y / height) * 4) % palette.length;
    }
  }
  const rectCount = Math.floor((width * height) / 33333);
  for (let i = 0; i < rectCount; i++) {
    const cx = Math.floor(r() * width);
    const cy = Math.floor(r() * height);
    const rw = Math.floor((50 + r() * 350) * (width / 2000));
    const rh = Math.floor((50 + r() * 250) * (height / 1500));
    const color = Math.floor(r() * palette.length);
    const x0 = Math.max(0, cx - (rw >> 1));
    const y0 = Math.max(0, cy - (rh >> 1));
    const x1 = Math.min(width, cx + (rw >> 1));
    const y1 = Math.min(height, cy + (rh >> 1));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        regionMap[y * width + x] = color;
      }
    }
  }

  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = palette[regionMap[y * width + x]];
      const n = noise[y * width + x] - 0.6;
      const grain = (r() - 0.5) * 18;
      const tint = n * 60;
      buf[i++] = Math.max(0, Math.min(255, p[0] + tint + grain));
      buf[i++] = Math.max(0, Math.min(255, p[1] + tint * 0.9 + grain));
      buf[i++] = Math.max(0, Math.min(255, p[2] + tint * 1.1 + grain));
      buf[i++] = 255;
    }
  }

  await sharp(buf, { raw: { width, height, channels: 4 } })
    .jpeg({ quality: 92 })
    .toFile(outPath);
}

async function generateUiMock(width, height, outPath) {
  const buf = Buffer.alloc(width * height * 4);
  const bg = [248, 248, 250];
  const panelDark = [30, 30, 36];
  const accent = [255, 138, 70];
  const text = [60, 60, 70];
  const muted = [200, 205, 215];

  function fill(x0, y0, x1, y1, c) {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
        const i = (y * width + x) * 4;
        buf[i] = c[0];
        buf[i + 1] = c[1];
        buf[i + 2] = c[2];
        buf[i + 3] = 255;
      }
    }
  }

  fill(0, 0, width, height, bg);
  fill(0, 0, width, 64, panelDark);
  fill(24, 18, 200, 46, accent);
  fill(width - 200, 22, width - 24, 42, muted);

  fill(0, 64, 240, height, [240, 240, 246]);
  for (let i = 0; i < 8; i++) {
    fill(20, 90 + i * 56, 220, 130 + i * 56, muted);
    fill(40, 100 + i * 56, 180, 120 + i * 56, text);
  }

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x = 280 + col * 320;
      const y = 96 + row * 220;
      fill(x, y, x + 290, y + 200, [255, 255, 255]);
      fill(x + 16, y + 16, x + 274, y + 100, accent);
      fill(x + 16, y + 116, x + 200, y + 132, text);
      fill(x + 16, y + 144, x + 260, y + 156, muted);
      fill(x + 16, y + 164, x + 230, y + 176, muted);
    }
  }

  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 6 })
    .toFile(outPath);
}

async function generatePhonePortrait(outPath) {
  const W = 1500;
  const H = 2000;
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const isSky = t < 0.55;
    const sky = [
      Math.round(255 - t * 80),
      Math.round(180 - t * 40),
      Math.round(120 + t * 60),
    ];
    const ground = [
      Math.round(40 + (1 - t) * 30),
      Math.round(70 + (1 - t) * 40),
      Math.round(50 + (1 - t) * 30),
    ];
    const c = isSky ? sky : ground;
    for (let x = 0; x < W; x++) {
      const dx = x - W * 0.5;
      const dy = y - H * 0.18;
      const r2 = dx * dx + dy * dy;
      const sunR = 180;
      let cr = c[0],
        cg = c[1],
        cb = c[2];
      if (isSky && r2 < sunR * sunR) {
        const k = 1 - r2 / (sunR * sunR);
        cr = Math.round(cr + (255 - cr) * k);
        cg = Math.round(cg + (220 - cg) * k);
        cb = Math.round(cb + (140 - cb) * k);
      }
      const i = (y * W + x) * 4;
      buf[i] = cr;
      buf[i + 1] = cg;
      buf[i + 2] = cb;
      buf[i + 3] = 255;
    }
  }

  await sharp(buf, { raw: { width: W, height: H, channels: 4 } })
    .rotate(-90)
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .toFile(outPath);
}

await generatePhoto(2000, 1500, `${OUT_DIR}/photo.jpg`, 0xc0ffee);
await generatePhoto(4000, 3000, `${OUT_DIR}/photo-4k.jpg`, 0xfeed5);
await generateUiMock(1280, 800, `${OUT_DIR}/ui.png`);
await generatePhonePortrait(`${OUT_DIR}/portrait.jpg`);

for (const f of [
  `${OUT_DIR}/photo.jpg`,
  `${OUT_DIR}/photo-4k.jpg`,
  `${OUT_DIR}/ui.png`,
  `${OUT_DIR}/portrait.jpg`,
]) {
  const m = await sharp(f).metadata();
  const orient = m.orientation ? ` (orientation=${m.orientation})` : "";
  console.log(`${f}: ${m.width}×${m.height} ${m.format}${orient}`);
}
