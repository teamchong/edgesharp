---
title: Compatibility
description: Honest format-by-format comparison with Next.js's default image optimizer.
---

This page lists what edgesharp does and doesn't support, side-by-side with
Next.js's default image optimizer (which on Vercel uses Sharp/libvips). The
goal is to set accurate expectations before you swap loaders, not to claim a
win.

Where a Vercel/Next.js behaviour isn't explicitly documented in their public
docs, the column is marked **?** rather than guessed.

## Input formats

| Format | Next.js default | edgesharp | Notes |
|---|---|---|---|
| JPEG (baseline-sequential) | ✓ | ✓ | Decoded by the in-Zig decoder (`jpeg.zig`). |
| JPEG (progressive) | ✓ | ✓ | Decoded by the vendored `stb_image.h` decoder (public-domain, single-file C). Same RGBA output as the baseline path; same resize and encode pipeline downstream. |
| JPEG (CMYK colorspace) | ✓ | ✗ | Rare on the web; design choice. File an issue if you need it. |
| PNG (8-bit RGBA) | ✓ | ✓ | |
| PNG (16-bit) | ✓ | ✗ | Uncommon; design choice. |
| GIF (still) | ✓ | ✓ | Re-encoded as JPEG/WebP/AVIF. |
| GIF (animated) | ✓ passthrough | ✓ passthrough | Source bytes returned unchanged. |
| WebP (still) | ✓ | ✓ | |
| WebP (animated) | ✓ passthrough | ✓ passthrough | Source bytes returned unchanged. |
| AVIF | ✓ | ✓ | edgesharp uses a vendored libavif build; kill switch via `DISABLED_FORMATS="avif"`. |
| SVG | ✓ (sanitized) | ✓ (passthrough + CSP/sandbox) | Both serve SVG without re-encoding. Next.js sanitizes; edgesharp returns the source bytes with `Content-Security-Policy: script-src 'none'; sandbox;` which neutralizes embedded scripts in the browser. |
| TIFF | ✓ | ✗ | Out of scope (web-image use case). |
| HEIC / HEIF | ? | ✗ | Out of scope. |
| RAW (CR2, NEF, ARW, …) | ✗ | ✗ | Out of scope on both. |
| BMP | ✓ | ✗ | Rare; design choice. |
| ICO | ✓ | ✗ | Rare; design choice. |

## Output formats

| Format | Next.js default | edgesharp | Notes |
|---|---|---|---|
| JPEG (baseline) | ✓ | ✓ | |
| JPEG (progressive) | ? | ✗ | Most outputs are baseline; progressive output requires a multi-scan encoder. |
| PNG | ✓ | ✓ | |
| WebP | ✓ | ✓ | |
| AVIF | ✓ | ✓ | |

## `<Image>` features

These are Next.js component-level features. edgesharp only changes the
`loaderFile`, so anything Next.js does on the client side is unaffected.

| Feature | Next.js default | edgesharp | Notes |
|---|---|---|---|
| `srcSet` generation from `deviceSizes` / `imageSizes` | ✓ | ✓ | Identical — same defaults. |
| `sizes` attribute for responsive images | ✓ | ✓ | |
| `priority` / `loading="eager"` | ✓ | ✓ | |
| Lazy loading | ✓ | ✓ | |
| `fill` mode | ✓ | ✓ | |
| Blur preview via `blurDataURL` | ✓ | ✓ | Next.js generates `blurDataURL` at build time; not affected by the loader. |
| Static export (`output: 'export'`) | ✓ | ✓ | edgesharp bakes the Worker URL into every `srcSet` at build time. |
| EXIF orientation auto-rotate (mobile portraits) | ✓ | ✓ | Both rotate based on EXIF tag 0x0112. |

## Server-side behavior

| Behavior | Next.js default | edgesharp | Notes |
|---|---|---|---|
| Quality range | 1–100 | 1–100 | Default 75 on both. |
| Width allowlist | derived from `deviceSizes`+`imageSizes` | same | edgesharp validates against the same Next.js defaults. |
| `?dpr=1\|2\|3` density multiplier | ? | ✓ | edgesharp accepts `dpr` and clamps to MAX_WIDTH after multiplication. |
| ETag / `304 Not Modified` | ✓ | ✓ | edgesharp's ETag is a strong validator derived from `(imageUrl, w, q, format)`. |
| `Vary: Accept` | ✓ | ✓ | |
| `Cache-Control: public, max-age=31536000, immutable` | ✓ | ✓ | |
| `Content-Disposition: inline` | ✓ | ✓ | |
| `X-Content-Type-Options: nosniff` | ✓ | ✓ | |
| Restrictive CSP on output | ? | ✓ `script-src 'none'; sandbox;` | |
| Unsafe content-type rejection | ✓ | ✓ | |

## Operator-side controls

These are runtime knobs edgesharp adds for self-hosted operators. Vercel's
hosted image optimization is largely zero-config and doesn't expose
equivalent first-class flags.

| Control | Next.js / Vercel | edgesharp | Notes |
|---|---|---|---|
| URL allowlist for upstream image hosts | `images.remotePatterns` | `ALLOWED_ORIGINS` | edgesharp accepts `"*"` as well — useful for demos, not for production. |
| Caller allowlist (Referer / Origin) | ✗ | `ALLOWED_REFERERS` | Stops other sites hotlinking your Worker. |
| Hard cap on `?q=` | ✗ | `MAX_QUALITY` | Cost protection against expensive `q=100` requests. |
| Format kill switch | ✗ | `DISABLED_FORMATS` (CSV: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`) | Drop transformed outputs (negotiator picks next-best the browser accepts) or passthrough inputs (Worker returns 415). |
| Backend pluggability | ✗ | `IMAGE_BACKEND` | Can route every transform through Cloudflare Images instead of WASM. |

## Costs

| Line item | Vercel | edgesharp |
|---|---|---|
| Per-transform fee | [$0.05 per 1K](https://vercel.com/docs/image-optimization/limits-and-pricing) | None |
| Cache read fee | [$0.40 per 1M](https://vercel.com/docs/image-optimization/limits-and-pricing) | None |
| Cache write fee | [$4 per 1M](https://vercel.com/docs/image-optimization/limits-and-pricing) | None |
| Egress | Counted against bandwidth | [Free on R2](https://developers.cloudflare.com/r2/pricing/) |
| Storage | Included in cache layer | [$0.015/GB-month on R2](https://developers.cloudflare.com/r2/pricing/) |
| Workers compute | n/a | $5/month base + [$0.30/M past 10M included](https://developers.cloudflare.com/workers/platform/pricing/) |

## Self-hosting

| | Next.js / Vercel | edgesharp |
|---|---|---|
| Source available | partial (loader API documented) | ✓ MIT, [GitHub](https://github.com/teamchong/edgesharp) |
| Run on your own infrastructure | self-host Next.js, but the optimizer ships with the framework | ✓ Cloudflare Workers + R2 in your account |
| Deploy time | n/a (managed) | One-click [Deploy to Cloudflare](/edgesharp/getting-started/) |

## What's not on this page

- **Latency comparison.** Neither party publishes a latency SLO for image
  optimization, and synthetic benchmarks on `wrangler dev` don't reflect edge
  network behavior. The numbers in [Performance](/edgesharp/performance/) are
  local-machine measurements — directional, not a SLO.
- **Quality / compression ratio.** Visual conformance against Sharp passes at
  PSNR ≥ 30 dB (visually indistinguishable). Output file sizes vary 0–10%
  vs Sharp depending on format and content. See
  [Conformance](/edgesharp/conformance/) for the test harness.
