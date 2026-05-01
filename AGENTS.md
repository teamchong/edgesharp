# edgesharp — Agent Development Guide

## What this is

Cloudflare-native image optimization for Next.js. Drop-in replacement for the
default `/_next/image` endpoint. Zig WASM SIMD for JPEG/PNG/WebP, vendored
libavif for native AVIF, Durable Objects for warm instances, 3-tier cache for speed.

## Tech stack

- **Zig 0.16** → wasm32-freestanding with simd128 + relaxed_simd
- **libwebp** (C, statically linked) → WebP encoding (patched cpu.c for `__wasm__` detection)
- **miniz** (C, statically linked) → deflate/PNG compression
- **libavif + libaom** (custom emcc build, always bundled; the `DISABLED_FORMATS` env var drops any of `jpeg`, `png`, `webp`, `avif`, `gif`, `svg` from negotiation) → AVIF encoding
- **@jsquash/avif** → only the JS glue is used; the WASM is our own size-first build
- **TypeScript** → Worker entry, Durable Object, cache orchestration, Next.js loader
- **Cloudflare Workers** → runtime (wrangler dev for local testing)
- **Astro Starlight** → docs site
- **Next.js 15** → demo app shipped as static assets in the same Worker

## Architecture rules

1. **TS = orchestration, WASM = compute** — never decode/resize/encode in TypeScript
2. **Pull-through proxy** — no image uploads, fetch from origin on cache miss
3. **3-tier cache** — Cache API (L1) → R2 (L2) → WASM transform (L3); ETag for 304 revalidation
4. **Deterministic DO names** — `img-slot-{0..7}` keeps V8 TurboFan warm
5. **Premultiplied alpha** — always premultiply before Lanczos resize, unpremultiply after
6. **One Worker entry, one bundle** — `src/worker.ts` always bundles libavif and ships at ~838 KB gzip. Free plan friendly: 838 KB fits the 1 MB compressed limit.
7. **`DISABLED_FORMATS` runtime kill switch** — comma-separated env var in the CF dashboard. Recognized values: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`. Empty/unset = every format enabled. For transformed outputs (jpeg/png/webp/avif), the negotiator skips disabled formats and picks the next-best one the browser accepts; if every format the browser accepts is disabled, the Worker returns 415. For passthrough inputs (animated gif / svg), disabling rejects those source types with 415. AVIF is statically imported so wrangler precompiles the WASM at deploy; the encoder is only instantiated on the first AVIF request, so `DISABLED_FORMATS="avif"` (the typical setting for watching CPU spend) costs nothing on cold start.
8. **Software math on freestanding** — `@log`, `@exp`, `@round` builtins recurse on wasm32-freestanding (they emit calls to `log`, `exp`, `round` symbols). Use `softLog64`, `softExp64`, `softRound64` from `libc_glue.zig` instead.
9. **No runtime `WebAssembly.compile`** — Workers blocks codegen for security. All WASM must be statically imported so wrangler compiles it at deploy time.

## File overview

```
wasm/
  build-wasm.sh      — Zig + C build (size-first flags + wasm-opt -Oz post-pass)
  src/
    wasm.zig         — WASM entry, exports to JS host
    jpeg.zig         — Baseline JPEG decoder (Huffman, IDCT, YCbCr→RGB, EXIF auto-rotate)
    decode.zig       — JPEG + PNG dispatch
    encode.zig       — JPEG encoder (DCT) + PNG encoder (miniz) + WebP encoder (libwebp)
    webp_encode.zig  — libwebp C binding for WebP encoding
    resize.zig       — Lanczos3 with Relaxed SIMD FMA + premultiplied alpha
    deflate.zig      — miniz C binding for zlib compression
    memory.zig       — WASM heap allocator
    libc_glue.zig    — malloc/free/memcpy/math functions for C libraries
    libc/            — Freestanding C headers (stddef, stdint, stdlib, string, math, etc.)
    miniz.c/h        — Deflate compression (public domain)
    libwebp/         — WebP encoder (patched from libwebp v1.5.0)
  vendor/
    avif_enc/        — Custom-built libavif WASM (1.5 MB) + emscripten glue.
                       Always bundled into the single Worker. See tools/build-avif/.

src/
  worker.ts          — Single Worker entry; always bundles libavif
  avif.ts            — libavif wrapper, lazily instantiated on first AVIF request
  image-do.ts        — Durable Object with warm Zig WASM instance
  loader.ts          — Next.js custom image loader (edgesharp/loader export)
  optimizer.ts       — ImageOptimizer class (Node-side, edgesharp/local export)
  local.ts           — Sharp-based path for Node.js / local dev (Node-only)
  types.ts           — Shared TypeScript types

demo/                — Next.js 15 static-export demo, bundled as Worker assets
tools/build-avif/    — Reproducible libavif rebuild (jsquash fork + size-first patches)

tests/
  conformance/
    visual.test.ts   — Pixel comparison vs Sharp (PSNR >= 30 dB)
    sizes.test.ts    — srcSet width parity with Next.js
    protocol.test.ts — HTTP API contract (58 tests, needs wrangler dev)
    global-setup.ts  — Auto-starts origin server + wrangler dev for protocol tests
  loader.test.ts     — Next.js loader URL generation (9 tests)
  benchmark.ts       — Latency measurements (cold/warm/cached) — needs wrangler dev
  microbench.mjs     — Pure WASM compute timing (no network, no workerd)
  origin-server.mjs  — Test fixture server

docs/                — Astro Starlight site
scripts/             — Demo image generator and helpers
```

## Build & test

```bash
# Build WASM (Zig + C, with wasm-opt -Oz post-pass)
cd wasm && ./build-wasm.sh

# Build the loader package (TS), the WASM, and the Next.js demo
pnpm run build         # default
# OR equivalent of:    pnpm run build:wasm && pnpm run build:loader && pnpm run build:demo

# Run all tests
pnpm run test:node     # vitest unit + conformance
IMAGEMODE_WRANGLER_PORT=8788 IMAGEMODE_TEST_URL=http://localhost:8788 \
  npx vitest run -c vitest.protocol.config.ts   # protocol tests on alt port

# Pure WASM microbench
node tests/microbench.mjs

# Local Worker
pnpm run dev           # always bundles libavif

# Deploy
pnpm run deploy        # single bundle — ~838 KB gz, fits Free plan's 1 MB compressed limit
```

## Known issues

- `zig build wasm` fails because `build.zig` doesn't wire up the freestanding libc include path or the libwebp sources. Use `./build-wasm.sh` (calls `zig build-exe` directly).
- JPEG decoder supports baseline sequential only. Progressive JPEG, arithmetic coding, and CMYK are not supported.
- libwebp `cpu.c` patched to add `#elif defined(__wasm__)` before the `EMSCRIPTEN` check — without this, the x86 CPUID code path is selected and crashes.
- `libc_glue.zig` provides software log/exp/pow/round because Zig builtins (`@log`, `@exp`, `@round`) on wasm32-freestanding emit calls to C symbols that recurse into our exports.
- libwebp's `src/` symlink (`src/libwebp/src -> .`) is required for `#include "src/enc/..."` paths to resolve.
- `tsc` over the full `src/` reports pre-existing strict-null errors in `worker.ts`/`optimizer.ts`. Use `pnpm run build:loader` (compiles only `loader.ts` via `tsconfig.loader.json`) when you only need `dist/loader.js` for the demo.
- All formats are on by default. The `DISABLED_FORMATS` env var in the Cloudflare dashboard takes a comma-separated list of formats to drop (recognized: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`). Transformed outputs (jpeg/png/webp/avif) skip disabled formats and pick the next-best one the browser accepts; passthrough inputs (gif animation / svg) get rejected with 415. If every format the browser accepts is disabled, the Worker returns 415.

## Conformance testing

Visual tests compare against Sharp/libvips (what Vercel uses). Threshold is PSNR >= 30 dB (visually indistinguishable). 88 total tests:

- 15 visual (pixel comparison vs Sharp)
- 6 sizes (srcSet width parity)
- 58 protocol (HTTP API contract)
- 9 loader (URL generation)

Bugs caught and fixed during development:
1. JPEG IDCT scaling error (replaced with reference float IDCT, then optimized with AC-zero fast path + f32 pass)
2. Alpha fringing during resize (added premultiplied alpha)
3. PNG compression failure (statically linked miniz)
4. libwebp infinite recursion (patched cpu.c + software math functions)
5. EXIF orientation ignored on mobile portraits (added APP1/Exif parser + post-decode rotation)

## Bundle size (uncompressed; gzip in parens)

- Single Worker (`src/worker.ts`):
  - `edgesharp.wasm` 172 KB · `avif_enc.wasm` 1.55 MB · Worker JS 14 KB · **total ~1.73 MB raw / ~838 KB gzip**

Free plan friendly: 838 KB fits the 1 MB compressed limit. Cold-boot cost is small (~15–40 ms): wrangler precompiles libavif's WASM at deploy time, and the encoder is only instantiated on the first AVIF request — Workers that never serve AVIF never pay the libavif startup cost.

## Pricing claims

All cost claims in docs link to official sources:
- Vercel: https://vercel.com/docs/image-optimization/limits-and-pricing
- CF Images: https://developers.cloudflare.com/images/pricing/
- HowdyGo case study: https://www.howdygo.com/blog/cutting-howdygos-vercel-costs-by-80-without-compromising-ux-or-dx

Do not make pricing claims without linking to a verifiable source.
