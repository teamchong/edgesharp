---
title: Configuration
description: All configuration options for edgesharp.
---

## wrangler.json

```json
{
  "name": "edgesharp",
  "main": "src/worker.ts",
  "compatibility_date": "2026-03-28",
  "vars": {
    "ORIGIN": "https://your-nextjs-app.com",
    "ALLOWED_ORIGINS": "https://cdn.example.com,https://images.unsplash.com",
    "IMAGE_BACKEND": "auto",
    "DISABLED_FORMATS": ""
  },
  "assets": {
    "directory": "./demo/out",
    "binding": "ASSETS",
    "run_worker_first": true,
    "not_found_handling": "single-page-application"
  },
  "durable_objects": {
    "bindings": [{ "name": "IMAGE_DO", "class_name": "ImageDO" }]
  },
  "r2_buckets": [
    { "binding": "CACHE_BUCKET", "bucket_name": "edgesharp-cache" }
  ],
  "rules": [
    { "type": "CompiledWasm", "globs": ["**/*.wasm"] }
  ],
  "migrations": [
    { "tag": "v1", "new_classes": ["ImageDO"] }
  ]
}
```

Native AVIF is bundled into the single Worker entry by default — no extra
config or alternate entry point needed. Set `DISABLED_FORMATS="avif"` in the
Cloudflare dashboard to drop AVIF from negotiation at runtime — the
negotiator skips it and picks the next-best format the browser accepts (WebP
on AVIF-capable browsers). No redeploy required. See
[Backend modes](/edgesharp/backend-modes/).

## Environment Variables

### `ORIGIN` (required)

The base URL prepended to path-relative `?url=` parameters. edgesharp fetches
the original image from `${ORIGIN}/<path>` on cache miss.

```json
"ORIGIN": "https://your-nextjs-app.com"
```

### `ALLOWED_ORIGINS` (optional)

Comma-separated list of additional allowed origins for **absolute** `?url=`
parameters. The Worker accepts an absolute `https://` URL only when its origin
(or hostname alone) matches an entry. Prevents the Worker from acting as an
open proxy.

```json
"ALLOWED_ORIGINS": "https://cdn.example.com,https://assets.example.com"
```

Use `"*"` to allow any `https://` host. **Only do this for demos or internal
deployments** — combine with [Cloudflare Rate Limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/),
[Bot Management](https://developers.cloudflare.com/bots/), and a tight Worker
budget alert if the deployment is publicly reachable. The bundled
`wrangler.json` ships with `"*"` so the demo's "paste any URL" playground
works; production deployments should switch to a curated list.

```json
"ALLOWED_ORIGINS": "*"
```

See [Production Hardening](/edgesharp/production-hardening/) for the full
checklist of what to tighten before publicly linking your Worker URL.

### `ALLOWED_REFERERS` (optional)

Caller allowlist — `ALLOWED_ORIGINS` controls *what URLs we fetch*;
`ALLOWED_REFERERS` controls *who can call us*. Without it, anyone on the
internet can hit your Worker URL and you pay the CPU.

```json
"ALLOWED_REFERERS": "https://yoursite.com,https://www.yoursite.com"
```

- **Unset** (default): no caller restriction. Fine for demos.
- **Set**: requests with a non-matching `Referer` (or `Origin`) header get
  `403 Forbidden referer`. Same-origin requests (the bundled demo calling its
  own `/_next/image`) are always allowed.
- **Missing Referer is rejected** when this is set. Strict — leave unset if
  your traffic comes through `Referrer-Policy: no-referrer`.

### `MAX_QUALITY` (optional, default: `"100"`)

Hard cap on the `?q=` parameter. Values above the cap are silently clamped —
the loader's emitted `srcSet` keeps working without errors.

```json
"MAX_QUALITY": "85"
```

Quality 85 is visually indistinguishable from 100 for typical web photos and
encodes meaningfully faster (especially for AVIF). Useful as a cost cap
against callers passing `q=100`.

### `IMAGE_BACKEND` (optional, default: `"auto"`)

Controls which engine processes images.

| Value | Behavior | Per-transform cost |
|---|---|---|
| `"auto"` | WASM for everything. AVIF goes through the vendored libavif unless `avif` is listed in `DISABLED_FORMATS`, in which case the negotiator picks WebP. | None |
| `"wasm"` | Same as `auto` minus the CF Images binding fallback (only relevant if `IMAGES` is bound). | None |
| `"cf-images"` | Every request goes through the [Cloudflare Images](https://developers.cloudflare.com/images/pricing/) binding. | CF Images rates |

### `DISABLED_FORMATS` (optional)

Comma-separated list of formats to drop. Empty / unset = every format
enabled. Recognized values: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`.

Two different effects depending on the format:

- **Transformed outputs** (`jpeg`, `png`, `webp`, `avif`) — the negotiator
  skips disabled formats and picks the next-best one the browser accepts.
  If every format the browser accepts is disabled, the Worker returns 415.
- **Passthrough inputs** (`gif`, `svg`) — animated GIF and SVG bytes are
  normally returned unchanged with the original Content-Type. Disabling
  rejects those source types with 415 instead.

Set in the Cloudflare dashboard (no redeploy required).

| Disabling | When to do it | What you save |
|---|---|---|
| `avif` | You don't want to pay the AVIF encode cost (libavif is ~3-4× more CPU than WebP). The negotiator picks WebP for AVIF-capable browsers, which gets you ~60-80% of AVIF's compression gains. | The biggest CPU/cost win — typically the dominant per-transform expense. |
| `webp` | You're seeing WebP rendering issues on a specific client, or you want strict-JPEG output for some downstream tool. | A small CPU win — WebP encode is ~5-10× cheaper than AVIF. |
| `png` | You want to force JPEG even when only PNG is acceptable. Loses transparency support — only safe if you control the input set and know there's no alpha. | Negligible — PNG encode is already cheap. |
| `gif` | You don't want to serve animated GIFs (returns 415 for animated sources). | The Worker stops bandwidth-passing-through arbitrarily large GIF bytes. |
| `svg` | You don't want to serve SVG (returns 415 for `image/svg+xml` sources). | Removes the SVG passthrough surface entirely. |

Examples:

```json
{
  "vars": {
    "DISABLED_FORMATS": "avif"
  }
}
```

```json
{
  "vars": {
    "DISABLED_FORMATS": "svg,gif"
  }
}
```

```json
{
  "vars": {
    "DISABLED_FORMATS": "avif,webp"
  }
}
```

The typical setting is `DISABLED_FORMATS="avif"` — the WASM stays bundled
(so you can re-enable without a redeploy), the encoder is never
instantiated, and your CPU bill stays at WebP-tier pricing.
`DISABLED_FORMATS="svg,gif"` refuses passthrough inputs.
`DISABLED_FORMATS="avif,webp"` collapses output to JPEG-only.

## Cloudflare Images binding (optional)

The single Worker entry doesn't need the `IMAGES` binding — it handles
JPEG/PNG/WebP/AVIF natively. Bind it only if you set `IMAGE_BACKEND: "cf-images"`:

```json
{
  "images": {
    "binding": "IMAGES"
  }
}
```

## Allowed image widths

edgesharp validates requested widths against the same defaults as Next.js:

**Device sizes:** 640, 750, 828, 1080, 1200, 1920, 2048, 3840

**Image sizes:** 16, 32, 48, 64, 96, 128, 256, 384

Requests with widths outside this set are rejected with HTTP 400. The
`?dpr=1|2|3` parameter multiplies the effective width before this check
(post-multiplication still has to fit `MAX_WIDTH = 3840`).

## Quality

Quality parameter (`q`) must be between 1 and 100. Default is 75 (matching Next.js).
