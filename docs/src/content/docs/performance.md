---
title: Performance
description: Latency, PSNR, and cost benchmarks.
---

## Latency

Measured on `wrangler dev` (local workerd, same V8 engine as production):

| Operation | Cold (ms) | Warm (ms) | Cached (ms) | Output |
|---|---|---|---|---|
| JPEG 2000×1500 → 640px | 13 | 2 | 2 | 17.5 KB |
| JPEG 2000×1500 → 1080px | 3 | 2 | 1 | 54.1 KB |
| JPEG 2000×1500 → 1920px | 3 | 3 | 2 | 232.6 KB |
| JPEG 2000×1500 → 3840px | 4 | 3 | 4 | 833.9 KB |
| PNG 512×512 → 64px | 1 | 1 | 1 | 2.1 KB |
| PNG 512×512 → 256px | 1 | 1 | 1 | 9.3 KB |
| PNG 512×512 → 384px | 1 | 1 | 1 | 14.4 KB |

**Cold** = first request to a fresh DO (WASM Liftoff compilation + transform).
**Warm** = DO is alive, TurboFan-optimized WASM, no cache hit.
**Cached** = served from Cache API or R2.

Cold starts only happen once per DO slot. With 8 slots in the pool, the first 8 unique image URLs trigger cold starts. Every subsequent request to the same slot runs at warm speed.

### Pure WASM compute time (no network, no V8 JIT)

Median of 10 invocations of `image_transform` running directly under Node 22, measures the algorithm time without workerd / TurboFan effects:

| Operation | Time |
|---|---|
| JPEG 2000×1500 → 320px | 216 ms |
| JPEG 2000×1500 → 640px | 249 ms |
| JPEG 2000×1500 → 1080px | 320 ms |
| JPEG 2000×1500 → 1920px | 453 ms |
| JPEG 2000×1500 → 3840px | 1185 ms |
| PNG 512×512 → 64px | 16 ms |
| PNG 512×512 → 384px | 34 ms |

Reproduce with `node tests/microbench.mjs`.

### vs native Sharp/libvips

Vercel doesn't publish image-optimization latency SLOs. Cold native-Sharp transforms typically run in the 50–100 ms range; warm edgesharp's WASM transform on `wrangler dev` local lands in the low single-digit ms range thanks to V8 TurboFan optimizing the SIMD code and the deterministic DO pool keeping instances warm across requests. We don't claim a head-to-head win without published comparison numbers.

Note: these benchmarks are from `wrangler dev` on a local machine. Production latency on Cloudflare Workers will include network overhead but benefits from edge proximity to the user.

## Visual quality (PSNR)

edgesharp's output is compared pixel-for-pixel against Sharp (the engine Vercel uses) using PSNR (Peak Signal-to-Noise Ratio).

| Test | PSNR | Verdict |
|---|---|---|
| JPEG photo → 320px | >= 30 dB | Visually indistinguishable |
| JPEG photo → 640px | >= 30 dB | Visually indistinguishable |
| JPEG photo → 1080px | >= 30 dB | Visually indistinguishable |
| PNG icon → 64px | >= 30 dB | Visually indistinguishable |
| PNG icon → 256px | >= 30 dB | Visually indistinguishable |
| PNG icon → 384px | >= 30 dB | Visually indistinguishable |

PSNR >= 30 dB means differences are invisible at normal viewing distance. The resize algorithm (Lanczos3) and premultiplied alpha handling match Sharp's behavior.

## PNG compression

edgesharp uses miniz (statically linked C) for deflate compression. Output PNG files are within 2x of Sharp's output size, comparable compression ratio with a much smaller binary.

## Cost at scale

The structural advantage of running on Cloudflare is [free R2 egress](https://developers.cloudflare.com/r2/pricing/), the cached output ships out at no bandwidth cost, no matter how many requests hit the cache. Storage is $0.015/GB/month, transformation work is Workers CPU.

**Sources:**
- Vercel: [Image Optimization Limits and Pricing](https://vercel.com/docs/image-optimization/limits-and-pricing)
- Cloudflare R2: [pricing](https://developers.cloudflare.com/r2/pricing/) (free egress)
- HowdyGo: [Cutting Vercel Costs by 80%](https://www.howdygo.com/blog/cutting-howdygos-vercel-costs-by-80-without-compromising-ux-or-dx), achieved ~$0.02/1K via self-hosted AWS Lambda

This table compares edgesharp against [Vercel's image-optimization pricing](https://vercel.com/docs/image-optimization/limits-and-pricing), the bill people are usually trying to get out from under when they look for an alternative. [Cloudflare Images](https://developers.cloudflare.com/images/pricing/) is a separate, managed service with different ergonomics (focal-point cropping, signed URLs, SLA); pick that when you've outgrown self-operated WASM rather than as a price comparison.

| Monthly unique transforms | [Vercel](https://vercel.com/docs/image-optimization/limits-and-pricing) | edgesharp |
|---|---|---|
| 5K | $0 (free tier) | ~$0 |
| 100K | ~$5 ¹ | ~$0.10 |
| 1M | ~$50 ¹ | ~$1.00 |
| 10M | ~$500 ¹ | ~$10 |

¹ Vercel's $0.05/1K transform fee, plus cache reads ($0.40/1M) and cache writes ($4/1M); the table reflects transform fees only. Cache writes add roughly $4/1M misses on top.

The single edgesharp Worker bundles the vendored libavif build (~1.5 MB WASM) so AVIF requests stay on the WASM path. No per-transform fees on this path; if you flip `IMAGE_BACKEND: "cf-images"` later, requests route through Cloudflare Images and pick up its [pricing model](https://developers.cloudflare.com/images/pricing/), your call when to make that switch.

### edgesharp cost breakdown

edgesharp's cost consists of:
- **R2 storage:** [$0.015/GB/month](https://developers.cloudflare.com/r2/pricing/) for cached optimized images
- **R2 egress:** [Free](https://developers.cloudflare.com/r2/pricing/), no bandwidth fee on cached output served back to viewers
- **Worker requests:** Workers Paid is $5/month base + [$0.30/million requests](https://developers.cloudflare.com/workers/platform/pricing/) past the included 10M/month
- **DO requests:** Included in Workers Paid plan

At 10M transforms with average 20 KB output = 200 GB R2 storage = $3/month, plus Workers CPU.
