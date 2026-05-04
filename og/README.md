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
renders a PNG via Satori + Resvg WASM. Cards live in R2 indefinitely
and refresh only on `POST /purge` (one page) or `POST /refresh`
(everything from your origin) — total render volume is bounded by
edits, not by request volume.

## Why this exists

- `@vercel/og` runs as a Vercel Edge Function billed per invocation,
  and Vercel deploys typically invalidate the edge cache — every code
  push triggers a re-render burst as crawlers re-fetch your cards.
- Cloudflare Images is for transformation, not generation; there's no
  CF-native equivalent of `@vercel/og`.
- Building OG cards by hand in Photoshop / Figma scales linearly with
  pages.

This Worker runs on
[Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/)
($5/mo flat per Cloudflare account, covering every Worker on the
account). With the cache-forever design (cards refresh only on
`/purge` or `/refresh`), **total render volume is bounded by edits,
not by request volume or any TTL** — so cost stays predictable as
traffic scales. R2 egress is free, so served cards cost nothing per
fetch.

## URL contract

```
GET  /<platform>/[<template-name>]
POST /<platform>/[<template-name>]    body = HTML template (preview only)
POST /purge                           wipe all cached variants for the calling page
POST /refresh                         wipe every card from the calling origin
```

| Path | Renders |
|---|---|
| `/og/` | Default template at OpenGraph dimensions (1200×630) |
| `/og/article.html` | Article template at OpenGraph dimensions |
| `/x/` | Default template at Twitter / X dimensions (1200×675) |
| `/x/article.html` | Article template at Twitter / X dimensions |
| `/sq/` | Default template at square dimensions (1200×1200) |
| `/sq/article.html` | Article template at square dimensions |
| `POST /purge` | Deletes every (platform × template) cache entry for the page in `Referer` |
| `POST /refresh` | Lists R2 and deletes every card whose stored `sourceUrl` origin matches the calling `Referer` |

The first path segment is the **platform** (`og` / `x` / `sq`) and
sets the canvas size. The second segment is the **template name**
(matching a file in `src/templates/`); empty means the default.

POST requests on a platform path use the body as a one-shot template —
used by the demo playground to preview custom HTML without redeploying.
POST renders are never cached.

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

The Worker is **default-deny** until you tell it which origins may
embed its meta tags. Set `ALLOWED_ORIGINS` as a **Secret** on the
deployed Worker — secrets persist across `wrangler deploy` runs,
unlike `vars` which get overwritten by whatever is in `wrangler.json`.

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `ALLOWED_ORIGINS` | yes | unset → block everything | Comma-separated. Each entry is one of: `https://example.com` (exact origin), `example.com` (exact hostname), `*.example.com` (any subdomain). |

### Two ways to set it

**Via dashboard (recommended after Deploy-button install):**

1. Cloudflare dashboard → Workers & Pages → `edgesharp-og` → **Settings**
2. **Variables and Secrets** → **Add** → **Type: Secret**
3. Name: `ALLOWED_ORIGINS`, Value: your domain(s)
4. **Save**, then click **Redeploy** so the Worker picks up the secret

**Via CLI:**

```bash
cd og
echo 'example.com,*.example.com' | npx wrangler secret put ALLOWED_ORIGINS
```

Until this is set, every request returns `403` with a message naming
the rejected origin — that's the safety net. If you forget to
configure it, you'll see the 403 on the very first share.

## Continuous deployment

Two paths, depending on how you set the Worker up:

**Deploy-button install** — Cloudflare Workers Builds is wired to
your fork automatically. Pushes to `main` that touch `og/` redeploy
the Worker. No GitHub secrets to configure.

**Forked and pushing manually** — `.github/workflows/ci.yml` includes
a `deploy-og` job that runs `wrangler deploy` from `og/` on every
`main` push (after tests pass). Add two repository secrets in your
GitHub fork to turn it on:

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Any Worker's overview page in the dashboard, right sidebar |

Without these secrets the `deploy-og` job will fail on push to `main`.
If you don't want auto-deploy, delete the `deploy-og` block from
`.github/workflows/ci.yml` and deploy from your laptop instead with
`pnpm --filter edgesharp-og run deploy`.

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

## Refreshing cards

Cards live in R2 indefinitely — there is **no clock-driven auto-expiry**.
Total render volume scales with the count of edits you make, not with
request volume or any TTL. That's how the cost stays predictable at any
scale.

### Two refresh endpoints

**`POST /purge`** — single page

```bash
curl -X POST https://og.example.com/purge \
  -H 'Referer: https://yoursite.com/article'
```

Deletes every `(platform × template)` variant for that page from R2 and
the local PoP's edge cache. Use this after editing one post.

**`POST /refresh`** — everything from your origin

```bash
curl -X POST https://og.example.com/refresh \
  -H 'Referer: https://yoursite.com/'
```

Lists R2 and deletes every card whose stored `sourceUrl` origin matches
the calling Referer's origin. Returns a JSON summary:

```json
{
  "origin": "https://yoursite.com",
  "scanned": 1247,
  "purged": 1247,
  "purgedOrphan": 0,
  "skippedForeign": 0
}
```

Use this after a template change, branding update, or anything else that
should invalidate every card. Cards re-render lazily on the next access.

Both endpoints honor `ALLOWED_ORIGINS` — callers from origins you haven't
opted in get 403. `/refresh` further filters by stored `sourceUrl` so a
caller can only wipe cards they originally rendered. Other PoPs catch up
on edge-cache `max-age` expiry (24h).

### Social platforms cache cards on their side too

Even after our cache is fresh, Twitter / Facebook / LinkedIn / Slack
keep their own copy of the rendered PNG until *they* re-fetch. Use
each platform's debugger to force it:

| Platform | How to force re-fetch |
|---|---|
| Twitter / X | [Card Validator](https://cards-dev.twitter.com/validator) |
| Facebook | [Sharing Debugger](https://developers.facebook.com/tools/debug/) |
| LinkedIn | [Post Inspector](https://www.linkedin.com/post-inspector/) |
| Slack | post the link, then `/remove-link-preview` in the channel |
| Discord | edit the message — Discord re-fetches metadata on edit |
| iMessage / WhatsApp | re-fetch within 24h on their own; no manual force |

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
covering every Worker on the account (one $5 base whether you run one
Worker or twenty).

Beyond the flat base, billing is:

- **CPU**: 30M CPU-ms/month included on the Workers Standard plan,
  then [$0.02 per million CPU-ms](https://developers.cloudflare.com/workers/platform/pricing/#workers).
  A Satori + Resvg render is roughly 500–1500 ms of CPU; the included
  tier covers 20–60k cold renders/month before any per-CPU charge.
- **Requests**: 10M/month included, then $0.30 per million.
- **R2 storage**: [$0.015/GB-month](https://developers.cloudflare.com/r2/pricing/).
  PNG cards are 30–80 KB so 100k unique cards = ~5 GB = ~8¢/month.
- **R2 egress**: free, so served cards cost nothing per fetch.

The cache-forever design means every subsequent fetch of an existing
card — Twitter crawler, Slack, real reader — is a free R2 read or
edge-cache hit. Cards re-render only when you `/purge` or `/refresh`.
**Bills scale with edits, not with fetch volume**, which is the
property that breaks for per-invocation pricing models when crawler
traffic spikes.

## Local development

```bash
cp og/.dev.vars.example og/.dev.vars
pnpm run dev:og   # og Worker on :8788
pnpm run dev      # main edgesharp Worker + demo on :8787
```

`.dev.vars` is gitignored — it never ships with the repo or with
`wrangler deploy`. The example file opens `ALLOWED_ORIGINS=*` so the
local demo on `localhost:8787` can hit the local og Worker on
`localhost:8788` without 403. Production stays configured via dashboard
Secrets, untouched.

## Limits

- Source URL must be `https://` (or `http://` for local dev).
- `Referer` must match `ALLOWED_ORIGINS`; no Referer = 403.
- Loop prevention: Referer can't equal the Worker's own origin.
- Source HTML capped at 5 MB (we only need the `<head>` but parse
  defensively).
- POST body capped at 5 MB.
- Output is PNG only (Resvg's only format).
- Cards live in R2 indefinitely; refresh only via `POST /purge`
  (single page) or `POST /refresh` (origin-wide). Edge-cache `max-age`
  is 24h so downstream caches revalidate within a day.

## Why no npm package

Unlike [`edgesharp`](../README.md) (a Next.js custom loader), this
Worker is just a URL. Sites integrate by emitting a `<meta>` tag — no
JS dependency, no build step, no framework lock-in. Works for any
static site generator, CMS, or hand-written HTML.
