---
title: Deployment
description: Deploy edgesharp to Cloudflare Workers.
---

## Quick deploy

```bash
pnpm run deploy
```

Builds the Zig WASM, the loader package, and the bundled Next.js demo, then
runs `wrangler deploy` against `wrangler.json`. The R2 bucket and Durable
Object are created automatically on first deploy.

## The single bundle

| Worker entry | Worker bundle (gzip) | Plan | Formats |
|---|---|---|---|
| `src/worker.ts` | ~838 KB | Free | JPEG, PNG, WebP, native AVIF |

**Free plan friendly: 838 KB fits the 1 MB compressed limit.** AVIF is on by
default. The cold-boot cost over the old 90 KB JPEG/PNG/WebP-only bundle is
small (~15–40 ms): wrangler precompiles the libavif WASM at deploy time, and
the encoder is only instantiated on the first AVIF request — Workers that
never serve AVIF never pay the libavif startup cost.

## `DISABLED_FORMATS` without redeploying

A single comma-separated env var drops formats at runtime. Recognized
values: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`. Empty / unset =
every format enabled. Set in the Cloudflare dashboard (Workers → your
Worker → Settings → Variables).

For transformed outputs (`jpeg`, `png`, `webp`, `avif`), the negotiator
skips disabled formats and picks the next-best one the browser accepts.
If every format the browser accepts is disabled, the Worker returns 415.
For passthrough inputs (`gif`, `svg`), the Worker rejects those source
types with 415 instead of returning the bytes unchanged.

Typical settings:

- `DISABLED_FORMATS="avif"` — drop AVIF first when CPU costs creep. AVIF
  encode is ~3–4× more CPU than WebP; the negotiator picks WebP, which
  keeps 60–80% of AVIF's compression savings.
- `DISABLED_FORMATS="svg,gif"` — refuse SVG and animated GIF inputs.
- `DISABLED_FORMATS="avif,webp"` — JPEG-only output.
- `DISABLED_FORMATS="webp"` — forces JPEG output, useful when a downstream
  tool can't read WebP.
- `DISABLED_FORMATS="png"` — forces JPEG even when only PNG is acceptable;
  loses transparency.

The bundled WASM doesn't shrink either way — encoders simply aren't
instantiated when their format is disabled, so changing the list costs
nothing on cold start.

## R2 bucket setup

edgesharp uses an R2 bucket to cache transformed images (L2 cache). [R2 egress
is free](https://developers.cloudflare.com/r2/pricing/), so the only cost on
the cache hot path is [$0.015/GB-month storage](https://developers.cloudflare.com/r2/pricing/)
for the cached output you keep around. The bucket is created automatically by
Wrangler on first deploy, or you can create it explicitly:

```bash
npx wrangler r2 bucket create edgesharp-cache
```

### Cache eviction

R2 objects don't expire by default. To bound storage cost, set up a lifecycle rule:

```bash
npx wrangler r2 bucket lifecycle set edgesharp-cache \
  --rule '{"id":"expire-30d","enabled":true,"conditions":{"prefix":"v1/"},"expiration":{"days":30}}'
```

This evicts cached output after 30 days; misses re-run the WASM transform.

## Custom domain

To serve from your own domain instead of `*.workers.dev`:

1. Add a custom domain in the Cloudflare dashboard, or
2. Use a route pattern in `wrangler.json`:

```json
{
  "routes": [
    { "pattern": "images.example.com/*", "zone_name": "example.com" }
  ]
}
```

The same Worker URL serves both the bundled Next.js demo (at `/`) and the
`/_next/image` API. If you only want the API exposed, drop the `assets` block
from `wrangler.json`.

## Production checklist

- [ ] Set `ORIGIN` to your production source URL
- [ ] List external image hosts in `ALLOWED_ORIGINS` (or omit to disable absolute URLs)
- [ ] Verify allowed widths match your `next.config.js` `images.deviceSizes` and `images.imageSizes`
- [ ] Decide which formats you want. Defaults: all on. Set `DISABLED_FORMATS` in the dashboard (comma-separated; recognized: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`) to drop any of them. `DISABLED_FORMATS="avif"` is the typical setting when watching CPU spend.
- [ ] If routing AVIF through Cloudflare Images instead, set `IMAGE_BACKEND: "cf-images"` and bind `IMAGES`
- [ ] Test with `pnpm run dev` before deploying
- [ ] Set up an R2 lifecycle rule to bound cache size
- [ ] Update your Next.js `images.loaderFile` to point at the Worker (see [Next.js integration](/edgesharp/nextjs-integration/))
