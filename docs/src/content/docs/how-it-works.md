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

edgesharp reads the browser's `Accept` header and picks the best format. The
single Worker bundle always includes libavif, so AVIF is on by default.
Disable it at runtime with `ENABLE_AVIF=false` in the Cloudflare dashboard,
or route everything through Cloudflare Images by setting
`IMAGE_BACKEND: cf-images` (and binding `IMAGES`).

| Accept header | Default (`ENABLE_AVIF` unset/`"true"`) | `ENABLE_AVIF: "false"` | `IMAGE_BACKEND: cf-images` |
|---|---|---|---|
| `image/avif, image/webp, */*` | **AVIF (vendored libavif)** | WebP (WASM) | AVIF (CF Images) |
| `image/webp, */*` | WebP (WASM) | WebP (WASM) | WebP (CF Images) |
| `*/*` | JPEG (WASM) | JPEG (WASM) | JPEG (CF Images) |

When AVIF is disabled at runtime, AVIF requests gracefully fall back to WebP —
typically 60–80% of the savings AVIF would give, with the same bundle on
disk. The libavif encoder is only instantiated on the first AVIF request,
so disabling it costs nothing on cold start either.

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
