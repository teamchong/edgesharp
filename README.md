# edgesharp

Cloudflare-native image optimization for Next.js. A drop-in replacement for the
default `/_next/image` endpoint, running on Cloudflare Workers with Zig WASM
SIMD for JPEG/PNG/WebP and a vendored libavif for native AVIF.

**[Live playground](https://playground.edgesharp.teamchong.net)** · **[Documentation](https://edgesharp.teamchong.net)**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/teamchong/edgesharp)

## What it is

- One change in `next.config.mjs` and every `<Image>` in your app routes
  through Cloudflare Workers instead of the default Next.js image optimizer.
- 3-tier cache: Cache API → R2 → WASM transform. R2 egress is free, so the
  hot path is bandwidth-free.
- One Worker, one bundle. `src/worker.ts` always ships JPEG / PNG / WebP plus
  native AVIF via vendored libavif. ~838 KB gzip. Needs [Workers
  Paid](https://developers.cloudflare.com/workers/platform/pricing/) ($5/month
  per Cloudflare account); Workers Free is not supported (10 ms CPU/request,
  no Durable Objects). A single `DISABLED_FORMATS` env var (a comma-separated
  list, recognized values: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`) lets
  you drop any output format at runtime, flip it in the Cloudflare dashboard,
  no redeploy. `DISABLED_FORMATS="avif"` is the typical setting since AVIF
  encode is the most CPU-expensive.

## Install

In your Next.js project:

```bash
pnpm add edgesharp
```

```js
// next.config.mjs
export default {
  images: {
    loader: "custom",
    loaderFile: "./node_modules/edgesharp/dist/loader.js",
  },
};
```

Then point the loader at your deployed Worker URL via env var:

```bash
# .env.local (or your hosting platform's env config)
NEXT_PUBLIC_IMAGEMODE_URL=https://your-worker.workers.dev
```

`<Image>` components stay exactly as written, `srcSet`, `sizes`, blur
previews, priority, fill mode all unchanged.

Prefer not to use an env var? Make a tiny custom loader file:

```js
// app/edgesharp-loader.js
import { createLoader } from "edgesharp/loader";
export default createLoader({ url: "https://your-worker.workers.dev" });
```

…and point `loaderFile` at that file instead.

## Deploy your own

The button above takes you through Cloudflare's flow, fork this repo to your
GitHub, connect Workers Builds, auto-create the R2 bucket and Durable Object,
deploy. The pre-built WASM binaries are committed to the repo so the build
doesn't need Zig.

After your first deploy, change a few things in your fork's `wrangler.json`:

- **`ORIGIN`**: your Next.js app's origin URL. Path-relative `?url=/foo.jpg`
  parameters are fetched from here.
- **`ALLOWED_ORIGINS`**: by default `"*"` (so the demo's "paste any URL"
  playground works). Narrow this to a curated list of image hosts before
  putting the Worker in front of real traffic. Pair with [Cloudflare Rate
  Limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/) and
  [Bot Fight Mode](https://developers.cloudflare.com/bots/) if it's publicly
  reachable.
- Optional: `DISABLED_FORMATS` in the Cloudflare dashboard. Comma-separated
  list of formats to drop (recognized: `jpeg`, `png`, `webp`, `avif`, `gif`,
  `svg`). For transformed outputs (jpeg/png/webp/avif), the negotiator skips
  disabled formats and picks the next-best one the browser accepts. For
  passthrough inputs (gif animation / svg), disabling rejects the source
  with 415. If every format the browser accepts is disabled, the Worker
  returns 415. `DISABLED_FORMATS="avif"` is the typical setting for watching
  CPU spend; `DISABLED_FORMATS="svg,gif"` refuses passthrough inputs.

## Local development

```bash
pnpm install
pnpm run build       # builds WASM + TS + demo
pnpm run dev         # wrangler dev on :8787 (single bundle, libavif included)
```

The WASM build needs **Zig 0.16** locally if you change anything under
`wasm/src/`. The pre-built artifacts in `src/wasm/` and `wasm/vendor/` ship
with the repo so deploy-button users don't need Zig.

## Costs

- **Cloudflare Workers Paid** -
  [$5/month per Cloudflare account](https://developers.cloudflare.com/workers/platform/pricing/),
  10M requests/month included, $0.30 per million after. Workers Free is not
  supported.
- **R2 storage**: [$0.015 / GB-month](https://developers.cloudflare.com/r2/pricing/);
  egress is free.
- No per-transform fees. After the first cold transform of each `(url,
  width, quality, format)`, repeat requests serve from R2 with free egress.
  CPU cost is per distinct variant, not per request, so crawler traffic
  on URLs you've already served doesn't scale costs the way per-transform
  pricing does. Compare to [Vercel image optimization
  pricing](https://vercel.com/docs/image-optimization/limits-and-pricing).

## Limitations

The decoder is built for the formats Next.js's `<Image>` actually serves -
not feature-parity with Sharp. Currently unsupported:

- **CMYK JPEGs**: print colorspace, rare on the web. Re-export as RGB.
- **16-bit PNG**: uncommon for web; we decode 8-bit only.
- **BMP, ICO**: design choice, rare on the web.
- **TIFF, HEIC, RAW (CR2/NEF/ARW/...)**: out of scope; these are professional formats that don't appear in `<Image>` source files.

What we *do* handle that the Next.js default also handles: baseline + progressive
JPEGs, PNGs, WebP (still and animated passthrough), GIF (still and animated
passthrough), AVIF, SVG (passthrough with restrictive CSP). See
[Compatibility](https://edgesharp.teamchong.net/compatibility/) for the
full side-by-side.

## Also: social share image generation

The same Worker also serves `/card?url=...` and `/og?url=...` for
generating OpenGraph / Twitter / square share PNGs from any source URL.
Point a `<meta>` tag at it and any site (no SDK, no Next.js) gets share
cards rendered via Satori + Resvg WASM, cached in R2 forever.

```html
<meta property="og:image" content="https://your-worker.workers.dev/card?url=https://mysite.com/post">
```

Try it on the playground's [Share cards
tab](https://playground.edgesharp.teamchong.net/share/). Templates live in
[`src/share/templates/`](./src/share/templates/) — fork and edit the JSX
to customize.

## Documentation

Full docs at **<https://edgesharp.teamchong.net>**.

- [How it works](https://edgesharp.teamchong.net/how-it-works/)
- [Next.js integration](https://edgesharp.teamchong.net/nextjs-integration/)
- [Configuration](https://edgesharp.teamchong.net/configuration/)
- [Compatibility](https://edgesharp.teamchong.net/compatibility/), what's supported vs Next.js's default loader
- [Deployment](https://edgesharp.teamchong.net/deployment/)
- [Production hardening](https://edgesharp.teamchong.net/production-hardening/), what to set before linking the Worker URL publicly
- [Architecture](https://edgesharp.teamchong.net/architecture/)

## License

MIT, see [LICENSE](./LICENSE).
