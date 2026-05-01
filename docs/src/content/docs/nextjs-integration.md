---
title: Next.js Integration
description: Drop-in integration with any Next.js application.
---

## One file

```
your-nextjs-app/
  next.config.mjs        — points images.loaderFile at edgesharp's loader
  app/page.tsx           — uses next/image as you already do (no change)
```

### `next.config.mjs`

```js
export default {
  images: {
    loader: "custom",
    loaderFile: "./node_modules/edgesharp/dist/loader.js",
  },
};
```

That's it. The default loader emits relative URLs (same-origin deploy) or reads
`NEXT_PUBLIC_IMAGEMODE_URL` at build time if you point at a different Worker.

### Why a node_modules path?

Next.js bundles `loaderFile` into the **client** at build time (the loader runs
in the browser), while `next.config.mjs` runs in **Node** at build time. The
two execution contexts don't share modules, so `loaderFile` has to be a path
that the build process can resolve and bundle separately — you can't `import`
the loader into your config.

### `<Image>` is unchanged

```tsx
import Image from "next/image";

export default function Page() {
  return (
    <Image
      src="/hero.jpg"
      width={1200}
      height={630}
      alt="Hero image"
      sizes="(min-width: 1024px) 1200px, 100vw"
    />
  );
}
```

The `<Image>` component still generates a `srcSet` from `deviceSizes` and
`imageSizes`. The only difference is each entry points at your edgesharp
Worker URL instead of `/_next/image` on the same Next.js server.

## What stays the same

- `<Image>` component API — no changes
- `srcSet` generation with `deviceSizes` and `imageSizes` — same breakpoints
- Blur previews via `blurDataURL` — unchanged (the loader doesn't intercept those)
- Priority / lazy loading — unchanged
- Fill mode — unchanged
- Static export (`output: 'export'`) — works; the loader bakes Worker URLs
  into every emitted `srcSet` at build time

## What changes

- Image transforms run on Cloudflare Workers (Zig WASM SIMD) instead of
  Vercel's image optimizer
- No per-transform fees — pay only Workers CPU + R2 storage. R2 egress is free.
- AVIF served natively via vendored libavif. The `DISABLED_FORMATS` env var in the Cloudflare dashboard takes a comma-separated list (recognized: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`) to drop formats from negotiation at runtime.
- EXIF orientation auto-rotated on JPEG decode (mobile portraits render upright
  with no client-side fix)
- Cold cache miss: ~100 ms WASM transform; warm cache hit: ~5 ms. Native
  Sharp on serverless typically lands in the 50–100 ms range (no published
  SLO from any provider, so we don't claim a head-to-head win).

## Same-origin deploy (single Worker)

If you serve the Next.js export from the same Cloudflare Worker that runs the
image API (the configuration this repo uses for its own demo), no extra config
is needed — the loader emits relative paths and the Worker resolves them
itself. `next.config.mjs` then ships everything in `out/` as static assets
bound to `env.ASSETS`, and the Worker handles `/_next/image` while assets
serve the HTML and your source images. See `demo/` in the edgesharp repo for
the working setup.

## Custom Worker URL (cross-origin deploy)

If your Next.js app and the edgesharp Worker live on different domains, point
the loader at the Worker URL. Two options:

**Option A — env var, no extra file:**

```bash
NEXT_PUBLIC_IMAGEMODE_URL=https://images.example.com pnpm build
```

The default loader reads this at build time and bakes the URL into every
`srcSet` entry.

**Option B — wrapper file, URL inline:**

```ts
// edgesharp-loader.ts
import { createLoader } from "edgesharp/loader";
export default createLoader({ url: "https://images.example.com" });
```

```js
// next.config.mjs
images: {
  loader: "custom",
  loaderFile: "./edgesharp-loader.ts",
},
```

Use this when you want the URL checked into source control without an env var.
