# edgesharp-og

Social share image generation on Cloudflare Workers. Point a meta tag at
the Worker URL, get a rendered PNG card. Templates ship as HTML files
bundled in your fork — Workers Builds redeploys when you push template
edits.

```html
<meta property="og:image" content="https://og.example.com/og/">
```

The Worker reads the `Referer` header to know which page is being
shared, fetches that page, extracts every `<meta>` tag from its
`<head>`, substitutes those values into a bundled HTML template, and
renders a PNG via Satori + Resvg WASM. Result is cached in R2 forever.

## Why this exists

- Vercel charges per OG render, plus crawler traffic from Twitter /
  Slack / Discord re-fetching meta tags multiplies the bill.
- Cloudflare Images is for transformation, not generation; there's no
  CF-native equivalent of `@vercel/og`.
- Building OG cards by hand in Photoshop / Figma scales linearly with
  pages.

This Worker plus a flat $5/mo
[Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/)
account renders unlimited cards. R2 egress is free, so once a card is
cached the per-render cost is zero.

## URL contract

```
GET  /<platform>/[<template-name>]
POST /<platform>/[<template-name>]    body = HTML template (preview only)
```

| Path | Renders |
|---|---|
| `/og/` | Default template at OpenGraph dimensions (1200×630) |
| `/og/article.html` | Article template at OpenGraph dimensions |
| `/x/` | Default template at Twitter / X dimensions (1200×675) |
| `/x/article.html` | Article template at Twitter / X dimensions |
| `/sq/` | Default template at square dimensions (1200×1200) |
| `/sq/article.html` | Article template at square dimensions |

The first path segment is the **platform** (`og` / `x` / `sq`) and
sets the canvas size. The second segment is the **template name**
(matching a file in `src/templates/`); empty means the default.

POST requests use the body as a one-shot template — used by the demo
playground to preview custom HTML without redeploying. POST renders
are never cached.

### What the meta tag looks like

```html
<!-- OpenGraph (Facebook, LinkedIn, Slack, Discord, iMessage, WhatsApp,
     Bluesky, Threads, Mastodon) -->
<meta property="og:image" content="https://og.example.com/og/">

<!-- Twitter / X large summary card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://og.example.com/x/">

<!-- Square thumbnail -->
<meta name="thumbnail" content="https://og.example.com/sq/">
```

That's the whole integration. No SDK, no build step on the consumer's
side, no Next.js requirement. Any site that can put a `<meta>` tag in
its `<head>` works.

## Security model

- **Default-deny:** `ALLOWED_ORIGINS` is empty out of the box. Every
  request returns 403 until you explicitly opt your sites in.
- **Referer-gated:** the Worker only renders for pages whose `Referer`
  matches the allowlist. No `?url=` query param means there's no way
  for a caller to spoof an arbitrary source.
- **Loop prevention:** Referer can't equal the Worker's own origin.
- **No SSRF surface:** the Worker only fetches the URL provided by the
  Referer (the page that put the meta tag there). It never fetches an
  attacker-controlled URL.
- **HTML escape on substitute:** `{{var}}` substitution HTML-encodes
  values from the source page so user-controlled content can't inject
  tags into your template.

## Configure (after deploy)

| Env var | Required? | Default | Notes |
|---|---|---|---|
| `ALLOWED_ORIGINS` | yes | `""` (empty = block everything) | Comma-separated. Each entry is one of: `https://example.com` (exact origin), `example.com` (exact hostname), `*.example.com` (any subdomain). |

Set in `wrangler.json` at deploy time, or in the CF dashboard under the
deployed Worker's Settings → Variables.

## Templates

Templates are HTML files in `src/templates/`, bundled at build time.
Two ship with the repo:

- `src/templates/default.html` — title + description, dark background,
  accent dot
- `src/templates/article.html` — same fields plus author byline

Add a template:

1. Drop `src/templates/my-template.html` into your fork.
2. Add it to `src/templates/registry.ts`:
   ```ts
   import myTemplateHtml from "./my-template.html";
   // ...
   "my-template.html": decode(myTemplateHtml as ArrayBuffer),
   ```
3. Push to git. Workers Builds redeploys.
4. Use it via `<meta property="og:image" content="https://og.example.com/og/my-template.html">`.

### Template format

Plain HTML with `{{name}}` substitution markers, parsed by Satori's
flexbox CSS subset. See [Satori docs](https://github.com/vercel/satori)
for what's supported. Every parent containing more than one child must
have explicit `display: flex` (or `display: contents` / `display: none`).

Authoring in JSX / TSX / MDX? Set up a build step in your fork that
compiles those to HTML before commit (e.g. the @vercel/og pipeline,
which is what powers Satori upstream). The Worker itself only ever
renders HTML at runtime — the source format is your build pipeline's
choice.

### Variables available

Every `<meta>` tag from the source page is exposed as `{{key}}` in the
template, keyed by `property` then `name`:

```html
<!-- on the source page -->
<meta property="og:title" content="My Post">
<meta name="author" content="Jane">

<!-- in the template -->
<div>{{og:title}} by {{author}}</div>
```

Plus three named convenience fields:

| Variable | Resolution chain |
|---|---|
| `{{title}}` | `og:title` → `twitter:title` → `<title>` |
| `{{description}}` | `og:description` → `twitter:description` → `<meta name="description">` |
| `{{siteName}}` (also `{{site}}`) | `og:site_name` → URL hostname |

And custom keys: any `<meta name="my-thing" content="...">` becomes
`{{my-thing}}`. Templates can reference whatever variables their
markup needs.

## Bundle size

| Component | Raw |
|---|---|
| Resvg WASM | 2.48 MB |
| Worker JS (Satori + satori-html + parser + react/jsx-runtime) | ~1.1 MB |
| Inter Bold + Regular TTF | ~820 KB |
| **Total** | **~4.4 MB raw, ~1.6 MB gzip** |

Comfortably under the 10 MB compressed Worker limit. Cold-boot
~150–250 ms (Resvg WASM compile + font load); warm thereafter.

## Cost

[Workers Paid is $5/month per Cloudflare
account](https://developers.cloudflare.com/workers/platform/pricing/),
covering unlimited Workers. Renders are CPU-only (no per-transform
fee). R2 storage is
[$0.015/GB-month](https://developers.cloudflare.com/r2/pricing/);
PNG cards are 30–80 KB so 100k unique cards = ~5 GB = ~8¢/month.

After the first cold render of each unique `(referer, platform,
template)`, every subsequent request — Twitter crawler, Slack, real
reader — is a free R2 read. Bills are bounded by the count of
distinct cards, not the count of fetches.

## Limits

- Source URL must be `https://` (or `http://` for local dev).
- `Referer` must match `ALLOWED_ORIGINS`; no Referer = 403.
- Loop prevention: Referer can't equal the Worker's own origin.
- Source HTML capped at 5 MB (we only need the `<head>` but parse
  defensively).
- POST body capped at 5 MB.
- Output is PNG only (Resvg's only format).

## Why no npm package

Unlike [`edgesharp`](../README.md) (a Next.js custom loader), this
Worker is just a URL. Sites integrate by emitting a `<meta>` tag — no
JS dependency, no build step, no framework lock-in. Works for any
static site generator, CMS, or hand-written HTML.
