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

## Disabling AVIF without redeploying

Set the environment variable `ENABLE_AVIF` to `"false"` in the Cloudflare
dashboard (Workers → your Worker → Settings → Variables). AVIF requests then
fall back to WebP. The libavif WASM stays bundled — flipping the flag just
skips encoder instantiation. Re-enable by removing the variable or setting
it back to `"true"`.

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
- [ ] Decide whether you want AVIF on (default) or off (set `ENABLE_AVIF: "false"` in the Cloudflare dashboard)
- [ ] If routing AVIF through Cloudflare Images instead, set `IMAGE_BACKEND: "cf-images"` and bind `IMAGES`
- [ ] Test with `pnpm run dev` before deploying
- [ ] Set up an R2 lifecycle rule to bound cache size
- [ ] Update your Next.js `images.loaderFile` to point at the Worker (see [Next.js integration](/edgesharp/nextjs-integration/))
