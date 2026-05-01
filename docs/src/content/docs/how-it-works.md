---
title: How It Works
description: The pull-through proxy architecture.
---

## Pull-through proxy

edgesharp is a pull-through cache, not an upload service. It fetches images from your origin server on first request and caches the optimized result.

```
Browser                    edgesharp Worker                Your Next.js app
  │                              │                               │
  │  /_next/image?url=...        │                               │
  │─────────────────────────────>│                               │
  │                              │                               │
  │                   ┌──────────┤                               │
  │                   │ L1 Cache │                               │
  │                   │   hit?   │                               │
  │                   └──────────┤                               │
  │                              │                               │
  │                   ┌──────────┤                               │
  │                   │ L2 R2    │                               │
  │                   │   hit?   │                               │
  │                   └──────────┤                               │
  │                              │                               │
  │                              │  fetch /photo.jpg             │
  │                              │──────────────────────────────>│
  │                              │<──────────────────────────────│
  │                              │                               │
  │                   ┌──────────┤                               │
  │                   │ WASM     │                               │
  │                   │ decode   │                               │
  │                   │ resize   │                               │
  │                   │ encode   │                               │
  │                   └──────────┤                               │
  │                              │                               │
  │     optimized image          │                               │
  │<─────────────────────────────│                               │
```

## 3-tier cache

| Tier | Storage | Latency | Cost | Survives |
|---|---|---|---|---|
| L1 | Cache API | ~5ms | Free | Datacenter eviction |
| L2 | R2 bucket | ~20ms | $0.015/GB/mo | Persistent |
| L3 | WASM transform | ~100ms | Worker CPU only | N/A (computed) |

99%+ of requests hit L1 or L2. The WASM transform only runs once per unique image+width+quality combination.

## Durable Object pool

WASM modules need V8 TurboFan to compile the SIMD code for peak performance. Cold starts use Liftoff (baseline compiler), which is slower.

edgesharp uses deterministically named Durable Objects (`img-slot-0` through `img-slot-7`) to keep WASM instances warm. After the first request compiles the WASM, subsequent requests to the same slot run at full TurboFan speed.

The slot is chosen by hashing the image URL, distributing load evenly across the pool.

## Format negotiation

edgesharp reads the browser's `Accept` header and picks the best format
the browser accepts AND the operator has enabled. The `DISABLED_FORMATS`
env var (comma-separated; recognized values: `jpeg`, `png`, `webp`, `avif`,
`gif`, `svg`) drops formats from negotiation at runtime. For transformed
outputs (jpeg/png/webp/avif), the negotiator skips disabled formats and
picks the next-best one the browser accepts; if every format the browser
accepts is disabled, the Worker returns 415. For passthrough inputs
(animated gif / svg), the Worker rejects those source types with 415
instead of returning the bytes unchanged.

You can also route every request through Cloudflare Images by setting
`IMAGE_BACKEND: cf-images` (and binding `IMAGES`) — `DISABLED_FORMATS`
still applies.

| Accept header | `DISABLED_FORMATS=""` | `DISABLED_FORMATS="avif"` | `DISABLED_FORMATS="avif,webp"` |
|---|---|---|---|
| `image/avif, image/webp, */*` | AVIF (vendored libavif) | WebP (WASM) | JPEG (WASM) |
| `image/webp, */*` | WebP (WASM) | WebP (WASM) | JPEG (WASM) |
| `*/*` | JPEG (WASM) | JPEG (WASM) | JPEG (WASM) |

When a transformed format is disabled, the negotiator picks the next-best
one the browser accepts. AVIF → WebP keeps 60–80% of AVIF's compression
savings; WebP → JPEG loses more but works everywhere. The bundled WASM
doesn't shrink — encoders simply aren't instantiated when their format is
disabled, so flipping the switch costs nothing on cold start either.

## Security

Every response includes:

- `Cache-Control: public, max-age=31536000, immutable` — 1-year cache, URL encodes all params
- `Vary: Accept` — CDN caches per Accept header
- `ETag: "<hash>"` — strong validator derived from `(imageUrl, w, q, format)`; supports `If-None-Match` → 304
- `X-Content-Type-Options: nosniff` — prevents MIME sniffing
- `Content-Security-Policy: script-src 'none'; frame-src 'none'; sandbox;` — blocks XSS via image
- `Content-Disposition: inline` — prevents download prompts

Input URLs are validated:

- Path-relative `?url=/foo.jpg` is fetched from the configured `ORIGIN`
- Absolute `?url=https://...` is allowed only if its origin (or hostname)
  matches an entry in `ALLOWED_ORIGINS`
- Protocol-relative `//host/path` and non-https schemes are rejected
- The fetched `Content-Type` is validated against a whitelist of safe image MIME types
