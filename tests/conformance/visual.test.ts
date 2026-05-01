/**
 * Visual conformance tests — verify edgesharp WASM output matches Sharp
 * (what Vercel/Next.js uses) within acceptable thresholds.
 *
 * Uses Sharp as the reference implementation and compares outputs using
 * PSNR (Peak Signal-to-Noise Ratio) and pixel-level analysis.
 *
 * PSNR thresholds:
 *   >= 30 dB: visually indistinguishable at normal viewing distance
 *   >= 25 dB: minor differences visible on close inspection
 *   <  25 dB: noticeable degradation (test should fail)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { execSync } from "child_process";

const FIXTURES_DIR = join(__dirname, "fixtures");
const OUTPUT_DIR = join(__dirname, "output");
const WASM_PATH = join(__dirname, "../../src/wasm/edgesharp.wasm");

// PSNR threshold: 30 dB = visually indistinguishable
const PSNR_THRESHOLD = 30;

// Maximum allowed dimension difference in pixels after resize
const MAX_DIMENSION_DIFF = 0;

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

let sharp: typeof import("sharp");
let wasmInstance: WebAssembly.Instance;

beforeAll(async () => {
  sharp = (await import("sharp")).default;
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(FIXTURES_DIR, { recursive: true });

  // Generate test fixtures if they don't exist
  await generateFixtures();

  // Load WASM module
  const wasmBytes = await readFile(WASM_PATH);
  const wasmModule = await WebAssembly.compile(wasmBytes);
  wasmInstance = await WebAssembly.instantiate(wasmModule);
});

describe("JPEG decode + resize parity", () => {
  for (const targetWidth of [320, 640, 1080]) {
    it(`resizes JPEG to ${targetWidth}px matching Sharp Lanczos3`, async () => {
      const source = await readFile(join(FIXTURES_DIR, "photo.jpg"));
      const quality = 80;

      // Reference: Sharp with Lanczos3 (Next.js default)
      const sharpResult = await sharp(source)
        .resize(targetWidth, undefined, { kernel: "lanczos3", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();

      // Test subject: edgesharp WASM
      const wasmResult = transformViaWasm(source, targetWidth, 0, quality); // 0 = JPEG

      // Decode both outputs and compare
      const sharpDecoded = await decodeWithSharp(sharpResult);
      const wasmDecoded = await decodeWithSharp(wasmResult);

      // Dimensions must match exactly
      expect(wasmDecoded.width).toBe(sharpDecoded.width);
      expect(wasmDecoded.height).toBe(sharpDecoded.height);

      // Visual quality must be within threshold
      const psnr = calculatePSNR(sharpDecoded.rgba, wasmDecoded.rgba);
      expect(psnr).toBeGreaterThanOrEqual(PSNR_THRESHOLD);

      // Save outputs for manual inspection
      await writeFile(join(OUTPUT_DIR, `jpeg_${targetWidth}_sharp.jpg`), sharpResult);
      await writeFile(join(OUTPUT_DIR, `jpeg_${targetWidth}_wasm.jpg`), wasmResult);
    });
  }
});

describe("PNG decode + resize parity", () => {
  // Source icon is 512px — only test widths smaller than source to match
  // Sharp's withoutEnlargement behavior
  for (const targetWidth of [64, 256, 384]) {
    it(`resizes PNG to ${targetWidth}px matching Sharp Lanczos3`, async () => {
      const source = await readFile(join(FIXTURES_DIR, "icon.png"));

      // Reference: Sharp
      const sharpResult = await sharp(source)
        .resize(targetWidth, undefined, { kernel: "lanczos3", withoutEnlargement: true })
        .png({ quality: 80 })
        .toBuffer();

      // Test subject: edgesharp WASM
      const wasmResult = transformViaWasm(source, targetWidth, 1, 80); // 1 = PNG

      const sharpDecoded = await decodeWithSharp(sharpResult);
      const wasmDecoded = await decodeWithSharp(wasmResult);

      expect(wasmDecoded.width).toBe(sharpDecoded.width);
      expect(wasmDecoded.height).toBe(sharpDecoded.height);

      const psnr = calculatePSNR(sharpDecoded.rgba, wasmDecoded.rgba);
      expect(psnr).toBeGreaterThanOrEqual(PSNR_THRESHOLD);

      await writeFile(join(OUTPUT_DIR, `png_${targetWidth}_sharp.png`), sharpResult);
      await writeFile(join(OUTPUT_DIR, `png_${targetWidth}_wasm.png`), wasmResult);
    });
  }
});

describe("PNG compression ratio", () => {
  it("compressed PNG is within 2x of Sharp output size", async () => {
    const source = await readFile(join(FIXTURES_DIR, "icon.png"));
    const targetWidth = 256;

    const sharpResult = await sharp(source)
      .resize(targetWidth)
      .png()
      .toBuffer();

    const wasmResult = transformViaWasm(source, targetWidth, 1, 80);

    // edgesharp PNG should be at most 2x larger than Sharp (miniz vs libpng)
    const ratio = wasmResult.length / sharpResult.length;
    expect(ratio).toBeLessThan(2.0);
  });
});

describe("aspect ratio preservation", () => {
  it("maintains aspect ratio when resizing", async () => {
    const source = await readFile(join(FIXTURES_DIR, "photo.jpg"));
    const sourceMetadata = await sharp(source).metadata();
    const sourceAspect = sourceMetadata.width! / sourceMetadata.height!;

    const targetWidth = 640;
    const wasmResult = transformViaWasm(source, targetWidth, 0, 80);
    const wasmMetadata = await sharp(wasmResult).metadata();
    const wasmAspect = wasmMetadata.width! / wasmMetadata.height!;

    // Aspect ratio should match within 1 pixel rounding error
    expect(Math.abs(sourceAspect - wasmAspect)).toBeLessThan(0.01);
  });
});

describe("quality levels", () => {
  it("lower quality produces smaller JPEG files", async () => {
    const source = await readFile(join(FIXTURES_DIR, "photo.jpg"));
    const targetWidth = 640;

    const q30 = transformViaWasm(source, targetWidth, 0, 30);
    const q80 = transformViaWasm(source, targetWidth, 0, 80);

    expect(q30.length).toBeLessThan(q80.length);
  });

  it("quality 100 JPEG is larger than quality 50", async () => {
    const source = await readFile(join(FIXTURES_DIR, "photo.jpg"));
    const targetWidth = 640;

    const q50 = transformViaWasm(source, targetWidth, 0, 50);
    const q100 = transformViaWasm(source, targetWidth, 0, 100);

    expect(q100.length).toBeGreaterThan(q50.length);
  });
});

describe("edge cases", () => {
  it("handles 1x1 pixel image", async () => {
    const pixel = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();

    const result = transformViaWasm(pixel, 1, 1, 80);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles wide panorama (10:1 aspect)", async () => {
    const panorama = await sharp({
      create: { width: 2000, height: 200, channels: 3, background: { r: 100, g: 150, b: 200 } },
    }).jpeg().toBuffer();

    const result = transformViaWasm(panorama, 640, 0, 80);
    const metadata = await sharp(result).metadata();
    expect(metadata.width).toBe(640);
    expect(metadata.height).toBe(64); // 200 * (640/2000) = 64
  });

  it("handles tall portrait (1:10 aspect)", async () => {
    const portrait = await sharp({
      create: { width: 200, height: 2000, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).jpeg().toBuffer();

    const result = transformViaWasm(portrait, 64, 0, 80);
    const metadata = await sharp(result).metadata();
    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(640); // 2000 * (64/200) = 640
  });

  it("grayscale JPEG decodes correctly", async () => {
    const gray = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 128, g: 128, b: 128 } },
    }).grayscale().jpeg().toBuffer();

    const result = transformViaWasm(gray, 50, 0, 80);
    expect(result.length).toBeGreaterThan(0);
    const metadata = await sharp(result).metadata();
    expect(metadata.width).toBe(50);
  });

  it("PNG with transparency preserves alpha channel", async () => {
    const rgba = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    }).png().toBuffer();

    const result = transformViaWasm(rgba, 50, 1, 80); // PNG output
    const metadata = await sharp(result).metadata();
    expect(metadata.width).toBe(50);
    expect(metadata.channels).toBe(4); // Alpha preserved
  });
});

// ── WASM interface ──

function transformViaWasm(
  source: Buffer | Uint8Array,
  width: number,
  format: number, // 0=JPEG, 1=PNG
  quality: number,
): Buffer {
  const exports = wasmInstance.exports as any;
  const memory: WebAssembly.Memory = exports.memory;

  // Allocate and copy source bytes
  const srcPtr = exports.wasm_alloc(source.length);
  if (srcPtr === 0) throw new Error("WASM alloc failed for source");

  new Uint8Array(memory.buffer).set(source, srcPtr);

  // Run transform pipeline
  const resultPtr = exports.image_transform(
    srcPtr,
    source.length,
    width,
    format,
    quality,
  );

  exports.wasm_free(srcPtr, source.length);

  if (resultPtr === 0) throw new Error("WASM transform returned null");

  // Read result: [4 bytes length LE][encoded bytes]
  const view = new DataView(memory.buffer);
  const encodedLen = view.getUint32(resultPtr, true);
  const encoded = Buffer.from(
    new Uint8Array(memory.buffer, resultPtr + 4, encodedLen),
  );

  exports.wasm_free(resultPtr, 4 + encodedLen);

  return encoded;
}

// ── Helpers ──

async function decodeWithSharp(
  imageData: Buffer | Uint8Array,
): Promise<DecodedImage> {
  const img = sharp(imageData);
  const metadata = await img.metadata();
  const rgba = await img.ensureAlpha().raw().toBuffer();
  return {
    width: metadata.width!,
    height: metadata.height!,
    rgba: new Uint8Array(rgba),
  };
}

/**
 * Calculate PSNR between two RGBA buffers, weighted by alpha.
 * Fully transparent pixels (alpha=0) are skipped since their RGB
 * values are visually meaningless — different renderers produce
 * different RGB values for alpha=0 pixels, which would tank PSNR
 * even though the images look identical.
 */
function calculatePSNR(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;

  let mse = 0;
  let count = 0;

  for (let i = 0; i < a.length; i += 4) {
    // Use the max alpha of either image to determine pixel visibility
    const alphaA = a[i + 3];
    const alphaB = b[i + 3];
    const maxAlpha = Math.max(alphaA, alphaB);

    // Skip fully transparent pixels
    if (maxAlpha === 0) continue;

    // Weight RGB channels by alpha visibility
    const weight = maxAlpha / 255;

    for (let c = 0; c < 4; c++) {
      const diff = a[i + c] - b[i + c];
      if (c < 3) {
        // RGB channels weighted by alpha
        mse += diff * diff * weight;
      } else {
        // Alpha channel always counts fully
        mse += diff * diff;
      }
    }
    count++;
  }

  if (count === 0) return Infinity;
  mse /= count * 4;

  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

async function generateFixtures() {
  const photoPath = join(FIXTURES_DIR, "photo.jpg");
  const iconPath = join(FIXTURES_DIR, "icon.png");

  try {
    await readFile(photoPath);
    await readFile(iconPath);
    return; // Fixtures already exist
  } catch {
    // Generate synthetic test images
  }

  // 2000x1500 JPEG with gradient + noise (photographic content)
  const photoPixels = Buffer.alloc(2000 * 1500 * 3);
  for (let y = 0; y < 1500; y++) {
    for (let x = 0; x < 2000; x++) {
      const i = (y * 2000 + x) * 3;
      photoPixels[i] = Math.floor((x / 2000) * 255); // R gradient
      photoPixels[i + 1] = Math.floor((y / 1500) * 255); // G gradient
      photoPixels[i + 2] = Math.floor(Math.random() * 64 + 96); // B noise
    }
  }
  await sharp(photoPixels, { raw: { width: 2000, height: 1500, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(photoPath);

  // 512x512 RGBA PNG with shapes (icon-like content)
  const iconPixels = Buffer.alloc(512 * 512 * 4);
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const i = (y * 512 + x) * 4;
      const cx = x - 256, cy = y - 256;
      const dist = Math.sqrt(cx * cx + cy * cy);
      if (dist < 200) {
        iconPixels[i] = 66;     // R
        iconPixels[i + 1] = 133; // G
        iconPixels[i + 2] = 244; // B
        iconPixels[i + 3] = 255; // A opaque
      } else if (dist < 220) {
        iconPixels[i] = 255;
        iconPixels[i + 1] = 255;
        iconPixels[i + 2] = 255;
        iconPixels[i + 3] = Math.floor((220 - dist) / 20 * 255); // Antialiased edge
      } else {
        iconPixels[i + 3] = 0; // Transparent
      }
    }
  }
  await sharp(iconPixels, { raw: { width: 512, height: 512, channels: 4 } })
    .png()
    .toFile(iconPath);
}
