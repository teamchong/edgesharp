/**
 * Native AVIF encoder for the Worker.
 *
 * Uses a custom-built libavif/libaom WASM (vendored at `wasm/vendor/avif_enc/`)
 * compiled with size-first emcc flags and 8-bit-only AV1. ~1.5 MB raw / ~743 KB
 * gzip versus jsquash's stock 3.4 MB / 1.1 MB build, which is what keeps the
 * single Worker bundle compact at ~838 KB gzip.
 *
 * Cloudflare Workers disallow `WebAssembly.compile(bytes)` at runtime, so the
 * WASM must be a static `import` that wrangler compiles at deploy time. The
 * Emscripten glue (`avif_enc.js`) is also vendored alongside, they're built
 * as a pair and aren't interchangeable with upstream jsquash artefacts.
 *
 * This module is always bundled into `src/worker.ts`. The static import below
 * is what makes wrangler precompile the libavif WASM at deploy time; the
 * encoder module itself is only instantiated lazily on the first AVIF
 * request, so Workers that never serve AVIF never pay the libavif startup
 * cost. Adding `avif` to the `DISABLED_FORMATS` env var (settable in the
 * Cloudflare dashboard) drops AVIF from negotiation at runtime without
 * redeploying.
 */
// @ts-expect-error, wasm import resolved by wrangler's CompiledWasm rule
import avifEncWasm from "../wasm/vendor/avif_enc/avif_enc.wasm";
// @ts-expect-error, emscripten glue, no .d.ts; we use a single bound API
import avifEncFactory from "../wasm/vendor/avif_enc/avif_enc.js";

type AvifEncoderFn = (
  rgba: Uint8Array,
  width: number,
  height: number,
  quality: number,
) => Promise<ArrayBuffer>;

type EmscriptenAvifModule = {
  encode: (
    data: Uint8Array,
    width: number,
    height: number,
    options: Record<string, unknown>,
  ) => { buffer: ArrayBuffer } | null;
};

let modulePromise: Promise<EmscriptenAvifModule> | null = null;

function getModule(): Promise<EmscriptenAvifModule> {
  if (!modulePromise) {
    modulePromise = (avifEncFactory as (opts: Record<string, unknown>) => Promise<EmscriptenAvifModule>)({
      noInitialRun: true,
      instantiateWasm: (
        imports: WebAssembly.Imports,
        callback: (instance: WebAssembly.Instance) => void,
      ) => {
        const instance = new WebAssembly.Instance(avifEncWasm as WebAssembly.Module, imports);
        callback(instance);
        return instance.exports;
      },
    });
  }
  return modulePromise;
}

/** Encoder bound to this Worker's compiled libavif module. */
export function createAvifEncoder(_env: unknown): AvifEncoderFn {
  return async (rgba, width, height, quality) => {
    const m = await getModule();
    const result = m.encode(rgba, width, height, {
      quality,
      qualityAlpha: -1,
      denoiseLevel: 0,
      tileColsLog2: 0,
      tileRowsLog2: 0,
      // Speed 8, encodes ~3× faster than libavif's default 6 at the cost of
      // ~3-6% larger files and ~1 dB PSNR. For "encode once, serve forever
      // from cache" this is the right tradeoff: the CPU bill is paid on the
      // first request per (image, w, q, format) and amortized over every cache
      // hit afterwards. Drop back to 6 if you re-encode often or quality is
      // critical (e.g., editorial photography). Allowed range: 0 (slowest,
      // best compression) to 10 (fastest).
      speed: 8,
      subsample: 1,
      chromaDeltaQ: false,
      sharpness: 0,
      tune: 0,
      enableSharpYUV: false,
      bitDepth: 8,
      lossless: false,
    });
    if (!result) throw new Error("avif encode failed");
    return result.buffer;
  };
}
