/**
 * Pure WASM microbenchmark, invokes image_transform directly, no wrangler/network.
 * Captures the algorithm time without workerd's JIT/cache effects.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(__dirname, "..", "src", "wasm", "edgesharp.wasm"));
const photoBytes = readFileSync(join(__dirname, "conformance", "fixtures", "photo.jpg"));
const iconBytes = readFileSync(join(__dirname, "conformance", "fixtures", "icon.png"));

const { instance } = await WebAssembly.instantiate(wasmBytes);
const { memory, wasm_alloc, wasm_free, image_transform } = instance.exports;

function readU32LE(ptr) {
  const view = new DataView(memory.buffer, ptr, 4);
  return view.getUint32(0, true);
}

function transformOnce(srcBytes, width, format, quality) {
  const inPtr = wasm_alloc(srcBytes.length);
  new Uint8Array(memory.buffer, inPtr, srcBytes.length).set(srcBytes);
  const outPtr = image_transform(inPtr, srcBytes.length, width, format, quality);
  wasm_free(inPtr, srcBytes.length);
  if (!outPtr) return 0;
  const outLen = readU32LE(outPtr);
  wasm_free(outPtr, 4 + outLen);
  return outLen;
}

function bench(name, srcBytes, width, format, quality, iters) {
  // Warmup
  transformOnce(srcBytes, width, format, quality);
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    const out = transformOnce(srcBytes, width, format, quality);
    times.push(performance.now() - t0);
    if (out === 0) {
      console.log(`  ${name}: FAILED`);
      return;
    }
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const min = times[0];
  console.log(`  ${name.padEnd(30)} median=${median.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  min=${min.toFixed(1)}ms`);
}

console.log("Pure WASM compute benchmark (no network, no workerd)");
console.log("=====================================================\n");
console.log("JPEG photo 2000×1500 (346 KB), decode + resize + encode JPEG q=75:");
bench("→ 320px",  photoBytes, 320,  0, 75, 10);
bench("→ 640px",  photoBytes, 640,  0, 75, 10);
bench("→ 1080px", photoBytes, 1080, 0, 75, 10);
bench("→ 1920px", photoBytes, 1920, 0, 75, 5);
bench("→ 3840px", photoBytes, 3840, 0, 75, 3);

console.log("\nPNG icon 512×512, decode + resize + encode PNG:");
bench("→ 64px",   iconBytes, 64,  1, 80, 10);
bench("→ 256px",  iconBytes, 256, 1, 80, 10);
bench("→ 384px",  iconBytes, 384, 1, 80, 10);

console.log("\nJPEG quality sweep (640px output):");
bench("q=30",     photoBytes, 640, 0, 30,  10);
bench("q=75",     photoBytes, 640, 0, 75,  10);
bench("q=100",    photoBytes, 640, 0, 100, 10);
