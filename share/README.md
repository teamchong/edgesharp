# edgesharp-share

Social share image generation on Cloudflare Workers. Point a meta tag at
the Worker URL, get a rendered PNG card. Works for any site, no SDK, no
build integration.

```html
<meta property="og:image" content="https://share.example.com/card?url=https://mysite.com/post">
```

The Worker fetches the source page, extracts `<title>` / `<meta>` tags,
renders a layout via Satori + Resvg WASM, and caches the PNG to R2
forever.

## Why this exists

- Vercel charges per OG render, plus crawler traffic from Twitter/Slack/
  Discord re-fetching meta tags multiplies the bill.
- Cloudflare Images is for transformation, not generation — there's no
  CF-native equivalent of `@vercel/og`.
- Building OG cards by hand in Photoshop / Figma scales linearly with
  pages.

This Worker plus a flat $5/mo
[Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/)
account renders unlimited cards. R2 egress is free, so once a card is
cached the per-render cost is zero.

## Install

Two pieces:

1. **Deploy the Worker.** One-click via the deploy button on the parent
   [`edgesharp` README](../README.md), or `pnpm install && cd share &&
   wrangler deploy`. Make sure your account has an R2 bucket called
   `edgesharp-share-cache` (deploy button creates this; manual deploys
   need `wrangler r2 bucket create edgesharp-share-cache`).
2. **Add meta tags to your site.** One per platform you care about (see
   below); they all point at your Worker URL with different `p` params.

## Meta tag examples

```html
<!-- OpenGraph: Facebook, LinkedIn, Slack, Discord, iMessage, WhatsApp,
     Bluesky, Threads, Mastodon, most others -->
<meta property="og:image" content="https://share.example.com/card?url=https://mysite.com/post">

<!-- Twitter / X large summary card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://share.example.com/card?url=https://mysite.com/post&p=twitter">

<!-- Square thumbnail (Instagram-style previews) -->
<meta name="thumbnail" content="https://share.example.com/card?url=https://mysite.com/post&p=square">
```

The Worker fetches `https://mysite.com/post` once on first request, parses
the `<head>` for title, description, author, site name, and renders the
card. Repeat requests for the same URL hit Cache API or R2 in
single-digit ms.

## URL contract

```
GET /card?url=<source-url>&p=<platform>&template=<name>&[overrides]
GET /og?...      (alias for /card)
```

| Param | Required | Default | Notes |
|---|---|---|---|
| `url` | yes | — | Source page. Must be `https://`. Must match `ALLOWED_ORIGINS`. |
| `p` | no | `og` | One of `og`, `twitter`, `square`. See platforms table. |
| `template` | no | `default` | JSX file in `src/templates/`. Add more by dropping `.tsx` files there. |
| `title` | no | extracted | Override the extracted page title. |
| `description` / `desc` | no | extracted | Override the description. |
| `accent` | no | `DEFAULT_ACCENT` env | Hex color for the accent dot. URL-encode `#` as `%23`. |
| `bg` | no | `DEFAULT_BG` env | Background color. |
| `fg` | no | `DEFAULT_FG` env | Foreground (text) color. |
| `site` | no | extracted / `SITE_NAME` env | Override the bottom-bar site name. |

### Platforms

| `p=` | dimensions | Use for |
|---|---|---|
| `og` (default) | 1200×630 | OpenGraph, Facebook, LinkedIn, Slack, Discord, iMessage, WhatsApp, Bluesky, Threads, Mastodon |
| `twitter` | 1200×675 | Twitter / X large summary card (16:9) |
| `square` | 1200×1200 | Instagram, square previews |

Output is always PNG. Resvg WASM is the rasterizer; PNG is the only format
it emits, and PNG is accepted by every social platform.

## Configuration (env vars in `wrangler.json`)

| Var | Default | Notes |
|---|---|---|
| `ALLOWED_ORIGINS` | `*` | Comma-separated list of `https://host` origins or bare hostnames. `*` allows any source URL — fine for the demo Worker, narrow this before going public. |
| `DEFAULT_ACCENT` | `#ff6600` | Hex color for the accent dot. |
| `DEFAULT_BG` | `#0a0a0a` | Background color (near-black). |
| `DEFAULT_FG` | `#fafafa` | Foreground / text color (near-white). |
| `SITE_NAME` | `edgesharp` | Bottom-bar text when the source page has no `og:site_name`. |

## Customizing the look

For colors and site name: env vars (above). No code changes needed.

For layout: edit `src/templates/default.tsx` in your fork. It's a regular
React-shaped JSX function; Satori walks the tree and builds an SVG. The
template receives `{ title, description, siteName, accent, background,
foreground }` props and returns a `<div>` tree using flexbox layout.
[Satori docs](https://github.com/vercel/satori) lists which CSS
properties are supported.

For new templates: drop a new `.tsx` file in `src/templates/` and add it
to `src/templates/registry.ts`. Users select it via `?template=<name>`.

## Bundle size

| Component | Raw |
|---|---|
| Resvg WASM | 2.48 MB |
| Worker JS (Satori + glue + parser + react/jsx-runtime) | 1.03 MB |
| Inter Bold TTF | 415 KB |
| Inter Regular TTF | 407 KB |
| **Total** | **~4.3 MB raw, ~1.6 MB gzip** |

Well within the 10 MB compressed Worker limit on Workers Paid. Cold-boot
is ~150–250 ms on first request (Resvg WASM compile + font init); cached
isolates are warm thereafter.

## Cost

[Workers Paid is $5/month per Cloudflare
account](https://developers.cloudflare.com/workers/platform/pricing/) and
covers unlimited Workers. Renders are CPU-only (no per-transform fee). R2
storage is [$0.015/GB-month](https://developers.cloudflare.com/r2/pricing/);
PNG cards are 30–80 KB so 100k unique cards = ~5 GB = 8¢/month.

After the first cold render of each unique `(url, platform, template)`,
every subsequent request — Twitter crawler, Slack, real reader — is a
free R2 read. Bills are bounded by the count of distinct cards, not the
count of fetches.

## Limits

- Source URL must be `https://`.
- Source URL hostname can't match this Worker's hostname (loop
  prevention).
- Source HTML capped at 5 MB (we only need the `<head>` but parse
  defensively).
- Output is PNG only.
- One built-in font (Inter Regular + Bold). Swap by replacing the TTF
  files in `src/fonts/` and updating `src/fonts.ts`.

## Why no npm package

Unlike [`edgesharp`](../README.md) (a Next.js custom loader), this
Worker is just a URL. Sites integrate by emitting a `<meta>` tag — no
JS dependency, no build step, no framework lock-in. Works for any
static site generator, CMS, or hand-written HTML.
