---
title: Limits
description: What edgesharp can and can't handle. Memory, CPU, file size, dimensions.
---

edgesharp inherits the limits of its host: Cloudflare Workers + R2. The
defaults are generous for typical web traffic (100 KB–10 MB JPEGs, 4K
maximum, browser `<Image>` use), but raw DSLR files and very large dimensions
are outside the envelope.

## What scales

- **Storage** — R2 has no practical per-bucket cap. Stored output costs
  [$0.015/GB-month](https://developers.cloudflare.com/r2/pricing/);
  egress is free.
- **Concurrency** — Workers run per-request and stateless on the global edge.
  No fixed connection cap; CF spreads load across data centers.
- **Cache hit rate** — repeat requests for the same `(url, width, quality, format)`
  never re-transform; they hit Cache API or R2 in single-digit ms.

## What doesn't

| Limit | Source | Where it bites |
|---|---|---|
| Workers isolate memory | [128 MB](https://developers.cloudflare.com/workers/platform/limits/) | RGBA decode buffer = `width × height × 4`. A 5500×5500 image → 121 MB → out of memory. **Practical ceiling: source dimensions ~4000×4000.** |
| Worker request body | [100 MB on Paid](https://developers.cloudflare.com/workers/platform/limits/) | Source images larger than this get rejected before edgesharp can decode them. |
| Worker CPU time per request | [30 s on the Standard usage model (Paid default)](https://developers.cloudflare.com/workers/platform/limits/) | A 4K JPEG → AVIF transform is ~1–2 s CPU. Standard is the default for new Paid Workers, so cold transforms fit. |
| `MAX_WIDTH` constant | 3840 (Next.js default) | Output width caps here regardless of source. Edit `MAX_WIDTH` in `src/worker.ts` if you need larger outputs. |
| `MAX_URL_LENGTH` | 3072 chars | Source URL parameter cap. Long signed-URL inputs may need bumping. |

## Workers Paid is required

edgesharp needs [Workers
Paid](https://developers.cloudflare.com/workers/platform/pricing/) ($5/month
per Cloudflare account). Workers Free is not supported: the 10 ms CPU/request
cap is too tight for cold transforms (a 4K JPEG → AVIF is ~1–2 seconds CPU),
and Durable Objects — required for the warm WASM pool — are Paid-only.

## Practical sweet spot

| | Comfortable | Stretches | Fails |
|---|---|---|---|
| Source file size | < 10 MB | 10–50 MB | > 100 MB (Workers Paid request body cap) |
| Source dimensions | < 4000×4000 | 4000–5000 px on a side | > 5500 px (memory) |
| Output width | up to 3840 | n/a (capped) | n/a |
| Output format | any of jpeg/png/webp/avif | n/a | n/a |
| Cold transforms / sec | ~10 | ~50 (Standard usage model) | unbounded with concurrent isolates, but bills accumulate |

## What to do when you hit a limit

- **Source file too large** — pre-process at the origin. Most static-site
  generators downsize originals before publishing; do that, and edgesharp
  takes a reasonable input.
- **Source dimensions too large** — same as above, or use
  [Cloudflare Images](https://developers.cloudflare.com/images/) for the
  initial downsize. CF Images has higher resource limits as a managed
  service.
- **CPU exceeded** — Standard usage model (30 s CPU/request) is the default
  for new Paid Workers, so a fresh deploy from this repo is already in the
  right place. If you cloned the wrangler config from a much older Worker
  that was on Bundled (50 ms), the simplest fix is to redeploy as a new
  Worker.
- **Memory exceeded** — almost always means the source is bigger than
  ~4000×4000. Either downsize at origin or set `IMAGE_BACKEND: cf-images`
  for that traffic and let Cloudflare Images handle it.

## What edgesharp doesn't try to be

- A general image-transformation service (cropping, watermarking, focal-point
  detection — that's [Cloudflare Images](https://developers.cloudflare.com/images/)).
- A photo-pipeline backend (RAW processing, color-managed exports — that's
  Sharp/libvips on a real server).
- A video transformer (use [Stream](https://developers.cloudflare.com/stream/)).

It's specifically a `<Image>`-loader replacement that handles the formats
Next.js's default loader handles, on Cloudflare's runtime instead of
Vercel's.
