---
title: Architecture
description: WASM engine, Durable Object pool, and caching design.
---

## System overview

![edgesharp architecture diagram](/edgesharp/architecture.svg)

## WASM engine

The image processing engine is written in Zig, compiled to WebAssembly with Relaxed SIMD enabled.

**Binary size:** 172 KB raw / ~87 KB gzip (Zig WASM, includes libwebp + miniz). The full Worker bundle including libavif lands at ~838 KB gzip.

| Module | Language | Purpose |
|---|---|---|
| jpeg.zig | Pure Zig | Baseline JPEG decoder (Huffman, IDCT, YCbCr→RGB) |
| decode.zig | Pure Zig | PNG decoder (all color types, zlib inflate) |
| encode.zig | Zig + C | JPEG encoder (DCT) + PNG encoder (miniz) + WebP encoder (libwebp) |
| webp_encode.zig | Zig→C | Binding to libwebp for WebP encoding |
| resize.zig | Pure Zig | Lanczos3 with SIMD FMA + premultiplied alpha |
| deflate.zig | Zig→C | Binding to miniz for zlib compression |
| memory.zig | Pure Zig | WASM heap allocator |
| libc_glue.zig | Pure Zig | malloc/free/memcpy/math functions for C libraries |

### Why Zig + C?

Three C libraries are statically linked into the single Worker:

- **[miniz](https://github.com/richgel999/miniz)** (public domain) — deflate compression for PNG encoding. Smaller and more predictable than Zig stdlib's flate path on freestanding WASM.
- **[libwebp](https://chromium.googlesource.com/webm/libwebp)** (BSD) — WebP encoding. Patched `cpu.c` to add `__wasm__` detection (upstream only checks for `EMSCRIPTEN`). Software math functions in `libc_glue.zig` replace Zig builtins that recurse on freestanding WASM.
- **[libavif](https://github.com/AOMediaCodec/libavif) + [libaom](https://aomedia.googlesource.com/aom)** — AVIF encoder, always bundled. Custom-built (see `tools/build-avif/`) with size-first emcc flags and 8-bit-only AV1, weighing ~1.5 MB versus jsquash's stock ~3.4 MB build. Lazily instantiated on the first AVIF request, so Workers that never serve AVIF never pay its startup cost; flip `ENABLE_AVIF=false` in the Cloudflare dashboard for a runtime kill switch.

### SIMD acceleration

The build targets `wasm32-freestanding` with these features:
- `simd128` — 128-bit SIMD vectors
- `relaxed_simd` — fused multiply-add (FMA) for Lanczos kernel
- `bulk_memory` — fast memory operations
- `sign_ext` — sign extension instructions

The Lanczos3 resize uses `@mulAdd(Vec4, a, b, c)` which compiles to `f32x4.relaxed_madd` — processing 4 RGBA channels per instruction.

### Premultiplied alpha

edgesharp premultiplies alpha before resizing and unpremultiplies after, matching Sharp/libvips behavior. Without this, transparent edges get color fringing because the Lanczos kernel blends RGB values from fully transparent pixels.

## Durable Object pool

8 deterministically named DOs (`img-slot-0` through `img-slot-7`) hold warm WASM instances. The slot is chosen by hashing the image URL.

V8's compilation tiers:
1. **Liftoff** (first request) — fast compile, slower execution
2. **TurboFan** (subsequent requests) — optimized SIMD code, full speed

Because the DOs persist between requests, TurboFan has time to optimize the WASM. Cold starts (~2-3s for WASM compilation) only happen when a DO is evicted.

## Caching strategy

URLs encode all transform parameters (`url`, `w`, `q`, format), so each unique combination is a distinct cache key. Responses are `immutable` — the URL uniquely identifies the output.

Cache hierarchy:
1. **Cache API** — per-datacenter, free, evicted under memory pressure
2. **R2** — persistent, survives cache eviction. [$0.015/GB-month storage, free egress](https://developers.cloudflare.com/r2/pricing/), so cached output ships back to viewers at no bandwidth cost
3. **WASM** — recomputes on double-miss (extremely rare)

The `Vary: Accept` header ensures the CDN caches different format responses separately (JPEG vs PNG vs AVIF).
