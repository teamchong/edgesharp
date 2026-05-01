---
title: Getting Started
description: Set up edgesharp in 5 minutes.
---

## Prerequisites

- A Next.js application (any hosting, or use the bundled demo)
- A Cloudflare account (Free plan works)
- Node.js 22+
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI
- pnpm (Corepack ships it; otherwise `npm install -g pnpm`)

## 1. Get the source

```bash
git clone https://github.com/teamchong/edgesharp.git
cd edgesharp
pnpm install
```

## 2. Configure your origin

Edit `wrangler.json` and point `ORIGIN` at wherever your source images live:

```json
{
  "vars": {
    "ORIGIN": "https://your-nextjs-app.com"
  }
}
```

If you want to allow images from additional hosts (CDNs, sample image services),
add them to `ALLOWED_ORIGINS`:

```json
{
  "vars": {
    "ORIGIN": "https://your-nextjs-app.com",
    "ALLOWED_ORIGINS": "https://images.unsplash.com,https://picsum.photos"
  }
}
```

The Worker accepts both path-relative URLs (`?url=/photo.jpg`, fetched from `ORIGIN`)
and absolute https URLs whose host matches any entry in `ALLOWED_ORIGINS`.

## 3. Test locally

```bash
pnpm run dev
```

That builds the Zig WASM, the loader, and the Next.js demo, then starts
`wrangler dev`. Open <http://localhost:8787> for the playground.

```bash
curl 'http://localhost:8787/_next/image?url=/demo/photo.jpg&w=640&q=75' \
  -H 'Accept: image/webp' \
  -o optimized.webp
```

## 4. Deploy

```bash
# ~838 KB gzip — JPEG/PNG/WebP via Zig WASM, native AVIF via vendored libavif.
# Free plan friendly: 838 KB fits the 1 MB compressed limit.
pnpm run deploy
```

Ships the bundled Next.js demo as static assets on the same Worker, so the
deployed URL serves both `/` (demo) and `/_next/image` (API). AVIF is on by
default; set `env.ENABLE_AVIF = "false"` in the Cloudflare dashboard if you
want AVIF requests to fall back to WebP without redeploying.

## 5. Point your Next.js app at it

One change to `next.config.mjs`:

```js
export default {
  images: {
    loader: "custom",
    loaderFile: "./node_modules/edgesharp/dist/loader.js",
  },
};
```

If your Next.js app is on a different origin than the Worker, set
`NEXT_PUBLIC_IMAGEMODE_URL=https://edgesharp.<your-subdomain>.workers.dev`
at build time. See [Next.js integration](/edgesharp/nextjs-integration/) for
the cross-origin variants.

That's it — every `<Image>` component now goes through edgesharp.
