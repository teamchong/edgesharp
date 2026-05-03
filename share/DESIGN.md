# edgesharp-share — Design

## What it is

A Cloudflare Worker that generates social share images (OpenGraph, Twitter,
WhatsApp, etc.) from a URL. The user adds a meta tag pointing at the Worker;
the Worker fetches the source page, extracts metadata, renders a card via
Satori + Resvg, and caches the PNG forever in R2.

## What it isn't

- Not an npm package. Just a Worker URL.
- Not Next.js-specific. Works for any site that can emit a `<meta>` tag.
- Not a runtime template uploader. Templates live in code, edited in a fork.
- Not a transformation service for existing images (that's edgesharp).

## Why a separate Worker (not bundled into edgesharp)

- **No bundle bloat for image-only users.** edgesharp stays at ~838 KB gz.
- **Clean failure surface.** A bug in Resvg can't break image transforms.
- **Independent positioning.** edgesharp serves Next.js; share serves any
  site. Different audiences, different docs, different deploy buttons.
- **Workers Paid is per-account.** Two Workers cost the same as one on the
  $5/mo plan. No pricing penalty for the split.

## URL contract

```
GET /card?url=<source-url>&p=<platform>&template=<name>&[overrides]
```

| Param | Required | Default | Notes |
|---|---|---|---|
| `url` | yes | — | Source page to extract metadata from. Must be https. Must match `ALLOWED_ORIGINS`. |
| `p` | no | `og` | Platform preset: `og`, `twitter`, `square`, `whatsapp`. Selects (width, height, format, quality). |
| `template` | no | `default` | Layout JSX file in `src/templates/`. |
| `title` | no | extracted | Override the extracted page title. |
| `description` | no | extracted | Override the description. |
| `accent` | no | env default | Hex color, e.g. `%23ff6600`. |
| `logo` | no | env default | Logo image URL. |

**Platform presets:**

| Platform | width × height | format | quality | Use for |
|---|---|---|---|---|
| `og` | 1200×630 | png | 90 | OpenGraph: Facebook, LinkedIn, Slack, Discord, iMessage, Bluesky, Threads, Mastodon |
| `twitter` | 1200×675 | png | 90 | Twitter/X `summary_large_image` |
| `square` | 1200×1200 | png | 90 | Instagram, square thumbnails |
| `whatsapp` | 1200×630 | jpeg | 70 | WhatsApp's <300 KB constraint |

User adds multiple meta tags pointing to the same Worker with different `p`:

```html
<meta property="og:image" content="https://share.example.com/card?url=https://mysite.com/post&p=og">
<meta name="twitter:image" content="https://share.example.com/card?url=https://mysite.com/post&p=twitter">
<meta name="twitter:card" content="summary_large_image">
```

## Metadata extraction

When the cache misses, the Worker fetches the source URL with:

- `User-Agent: edgesharp-share/1 (+https://github.com/teamchong/edgesharp)`
- `Accept: text/html`
- 5 MB body cap (we only need the `<head>` but parse defensively)

Extracted in priority order (URL params override extracted values):

| Field | Sources, in order |
|---|---|
| title | `og:title` → `twitter:title` → `<title>` |
| description | `og:description` → `twitter:description` → `<meta name="description">` |
| image | `og:image` → `twitter:image` → `<link rel="icon">` |
| author | `og:article:author` → `<meta name="author">` |
| site_name | `og:site_name` → URL hostname |

If the page has its own `og:image` already, the Worker still renders a fresh
card unless the user wants to short-circuit (out of scope for v1).

## Caching

- Cache key includes a build SHA so each redeploy invalidates naturally.
  Workers Builds exposes the commit SHA at build time as `CF_PAGES_COMMIT_SHA`
  or similar; we read it once at module init.
- L1: Cache API, `max-age=31536000, immutable` for successful renders.
- L2: R2 bucket `edgesharp-share-cache`.
- ETag: deterministic from the cache key.
- Failure responses (origin 4xx, render errors): short cache (60 s) so
  transient issues self-heal.

## Tech stack

- **Satori** — JSX → SVG. Pure JS, runs natively in Workers.
- **@resvg/resvg-wasm** — SVG → PNG. WASM, statically imported via wrangler's
  `CompiledWasm` rule.
- **htmlparser2** — lightweight HTML head parser. ~30 KB gz.
- **Inter** font, two weights (regular + bold), bundled as binary imports
  via wrangler's `Data` rule.

## Bundle estimate

| Component | gzip |
|---|---|
| Satori + glue | ~150 KB |
| Resvg WASM | ~600 KB |
| Inter Regular + Bold | ~200 KB |
| htmlparser2 | ~30 KB |
| Worker JS | ~5 KB |
| **Total** | **~985 KB** |

Well under 10 MB Paid limit.

## Security

- `ALLOWED_ORIGINS` env var (same shape as edgesharp): which source
  hostnames the Worker will fetch from. Default `*` for the demo
  playground; production deployments curate.
- Loop prevention: refuse to fetch URLs matching the Worker's own
  hostname. A site embedding our Worker URL in its `og:image` then
  pointing the Worker at itself would otherwise infinite-loop.
- HTTPS-only source URLs.
- Content-Length pre-flight (5 MB cap on fetched HTML).

## File layout

```
share/
  wrangler.json
  package.json
  tsconfig.json
  src/
    worker.tsx           — entry, route handler
    metadata.ts          — HTML head parser
    render.ts            — Satori + Resvg wrapper
    platforms.ts         — platform → render config
    templates/
      default.tsx        — minimal title + description
      registry.ts        — exports a Map<name, Component>
    fonts.ts             — load + cache Inter regular + bold
    fonts/
      Inter-Regular.ttf
      Inter-Bold.ttf
      LICENSE
  README.md              — pitch, usage, customizing
  DESIGN.md              — this file
```

## Out of scope for v1

- Runtime template upload (KV-backed) — keep templates in code
- Multiple fonts beyond Inter — one default, user swaps in fork
- Image proxying inside templates beyond `og:image` extraction
- Animated PNGs / video thumbnails
- Auth / signed URLs
