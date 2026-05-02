---
title: Production Hardening
description: How to deploy edgesharp in front of real traffic without dread.
---

The defaults in this repo's `wrangler.json` are tuned for the bundled demo —
`ALLOWED_ORIGINS = "*"`, no caller allowlist, no quality cap. Useful for "paste
any URL" exploration; **wrong for anything you'll link to publicly**.

This page is a one-stop checklist. If you skip the docs and only do these
five things, your Worker stays cheap and your bill stays predictable.

## 1. Lock down `ALLOWED_ORIGINS`

`ALLOWED_ORIGINS` controls which **upstream URLs** the Worker can fetch from.
The demo uses `"*"` so the playground works for any pasted URL — that makes
the Worker an open proxy. Replace with a curated comma-separated list:

```json
"ALLOWED_ORIGINS": "https://cdn.yoursite.com,https://images.unsplash.com"
```

Path-relative requests (`?url=/photo.jpg`) are always fetched from `ORIGIN`
and don't depend on this list — but every absolute `https://` URL must match.

## 2. Set `ALLOWED_REFERERS` (caller allowlist)

`ALLOWED_ORIGINS` controls *what we fetch*. `ALLOWED_REFERERS` controls
*who can call us*. Without it, anyone on the internet can hit your Worker
URL and you pay the CPU.

```json
"ALLOWED_REFERERS": "https://yoursite.com,https://www.yoursite.com"
```

Behavior:
- **Unset**: any caller allowed (demo behavior).
- **Set**: requests with a non-matching `Referer` (or `Origin`) header get
  `403 Forbidden referer`.
- **Same-origin** is always allowed — the Worker can serve its own bundled
  demo / static assets without you adding the Worker URL to the list.
- **Missing Referer is rejected** when this is set. Browsers typically send
  a Referer for `<img>` requests; if your traffic comes through a strict
  `Referrer-Policy: no-referrer` header, leave `ALLOWED_REFERERS` unset and
  rely on rate-limiting + spend caps instead.

## 3. Cap quality with `MAX_QUALITY`

A caller can request `?q=100` and force expensive encodes. Cap it:

```json
"MAX_QUALITY": "85"
```

Quality 85 is visually indistinguishable from 100 for typical web photos and
encodes meaningfully faster (especially for AVIF). Values above the cap are
silently clamped — the loader's emitted `srcSet` keeps working without errors.

## 4. Decide which formats you serve

[`DISABLED_FORMATS`](/configuration/) lets you trade quality for
cost without redeploying. It's a comma-separated list (recognized:
`jpeg`, `png`, `webp`, `avif`, `gif`, `svg`). The biggest CPU win is
dropping AVIF:

```json
"DISABLED_FORMATS": "avif"
```

The negotiator then picks WebP for AVIF-capable browsers — about 60–80%
of AVIF's compression gains at a fraction of the encode cost. Re-enable
later by removing it from the list in the Cloudflare dashboard. You can
also drop passthrough surfaces — `DISABLED_FORMATS="svg,gif"` rejects
SVG and animated GIF inputs with 415.

## 5. Set platform-level guardrails (Cloudflare dashboard)

These are not edgesharp settings — they're Cloudflare features you should
turn on for any public Worker:

- **[Workers spend cap alert](https://developers.cloudflare.com/workers/platform/limits/#standard-pricing)**
  — emails you when monthly Worker spend crosses a threshold. Set this **before**
  you make the URL public. The first time you'll need it is exactly the time
  you can't predict.
- **[Rate Limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/)**
  on `/_next/image` — e.g., 100 requests/min per IP. The CPU cost of a single
  cold transform is small; the cost of a thousand of them in a minute isn't.
- **[Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)**
  — Catches the obvious abuse patterns without per-rule configuration.
- **[R2 lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)**
  — bound your L2 cache size. 30-day expiration is reasonable for a CDN cache:

  ```bash
  npx wrangler r2 bucket lifecycle set edgesharp-cache \
    --rule '{"id":"expire-30d","enabled":true,"conditions":{"prefix":"v1/"},"expiration":{"days":30}}'
  ```

## Recommended production `wrangler.json`

```json
{
  "name": "edgesharp",
  "main": "src/worker.ts",
  "compatibility_date": "2026-03-28",
  "vars": {
    "ORIGIN": "https://yoursite.com",
    "ALLOWED_ORIGINS": "https://cdn.yoursite.com",
    "ALLOWED_REFERERS": "https://yoursite.com,https://www.yoursite.com",
    "MAX_QUALITY": "85"
  }
  // ...assets, durable_objects, r2_buckets, rules, migrations
}
```

That config + the platform-level items above is what stands between
"demo I shared with my team" and "Worker I forgot about that ran up a bill
when an AI crawler discovered it."

## What this doesn't protect against

- **Authenticated abuse** — if a caller can make the right `Referer` header
  (server-side requests, Postman), the allowlist doesn't stop them. Pair with
  rate-limiting on the platform layer.
- **Compromised allowed origins** — if `cdn.yoursite.com` is XSS'd or hijacked,
  the Worker will fetch whatever's there. Image content-type validation is
  enforced (no SVG, no executables) but compromised images can still cost CPU.
- **Surge billing on Paid** — beyond the 10M included requests/month, $0.30
  per million keeps charging. The spend cap alert above is what tells you a
  bad day is happening.
