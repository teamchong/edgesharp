---
title: edgesharp
description: Zero-cost image optimization on Cloudflare Workers via Zig WASM SIMD.
template: splash
hero:
  tagline: Drop-in image optimization for Next.js apps. Free at any scale. Powered by Zig WASM SIMD on Cloudflare Workers.
  actions:
    - text: Get Started
      link: /getting-started/
      icon: right-arrow
    - text: GitHub
      link: https://github.com/teamchong/edgesharp
      icon: external
      variant: minimal
---

## Who this is for

You shipped a Next.js project on Vercel, the demo went well, and now you're staring at the [Vercel image-optimization line item](https://vercel.com/docs/image-optimization/limits-and-pricing) for the first time. Maybe it's $20, maybe more — small in absolute terms, but it's a commitment you didn't plan for while you were still figuring out whether the project has legs.

edgesharp is for that moment. It's a drop-in `/_next/image` replacement that runs on Cloudflare Workers, with the same `<Image>` API you already use. One line in `next.config.mjs` and the loader switches from Vercel's optimizer to your Worker. JPEG/PNG/WebP transforms are compiled to Zig WASM; native AVIF ships via a custom-built libavif; results cache in R2 ([egress is free](https://developers.cloudflare.com/r2/pricing/)). **Free plan friendly: 838 KB fits the 1 MB compressed limit.**

When the project actually takes off and you want professional-grade image transforms with a managed SLA, [Cloudflare Images](https://developers.cloudflare.com/images/) is one config flip away — set `IMAGE_BACKEND: "cf-images"` and the same Worker routes through CF Images instead of WASM. edgesharp doesn't lock you in; it just gives you a runway while you're still on a hobby budget.

A single `DISABLED_FORMATS` env var (comma-separated; recognized values: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`) drops any format at runtime — set it in the Cloudflare dashboard, no redeploy needed. For transformed outputs (jpeg/png/webp/avif), the negotiator skips disabled formats and picks the next-best one the browser accepts; for passthrough inputs (animated gif / svg), the Worker rejects with 415. AVIF is the most expensive to encode, so it's the headline knob: `DISABLED_FORMATS="avif"` is the typical setting when CPU costs creep.

## Why Cloudflare-native

[R2 egress to the internet is free](https://developers.cloudflare.com/r2/pricing/). That single line is the structural reason an image cache built on Workers + R2 doesn't pay the cache-write and bandwidth fees that pile up elsewhere. You pay only [$0.015/GB/month](https://developers.cloudflare.com/r2/pricing/) for stored output.

## Where edgesharp fits

edgesharp isn't trying to compete with [Cloudflare Images](https://developers.cloudflare.com/images/). They solve different parts of the lifecycle:

| Stage | What you want | Tool |
|---|---|---|
| You just shipped a side project, traffic is small, you want off the [Vercel image bill](https://vercel.com/docs/image-optimization/limits-and-pricing) without committing to anything | A drop-in `<Image>` loader that runs on Workers + R2 you already pay for | **edgesharp** |
| The project has product-market fit, you want managed quality, polish, an SLA, and don't want to operate WASM yourself | A first-class image-optimization service with focal-point cropping, signed URLs, format detection | **[Cloudflare Images](https://developers.cloudflare.com/images/)** — flip `IMAGE_BACKEND: "cf-images"` |

The same `wrangler.json` works for both modes. You can start on edgesharp's WASM path and graduate to CF Images without changing your Next.js config or rewriting URLs. 5,000 free transforms/month are included with Cloudflare Images, so the upgrade is also gentle from a cost perspective.

## How it works

1. Browser requests `/_next/image?url=/photo.jpg&w=640&q=75`
2. edgesharp checks Cache API, R2, then fetches from your origin
3. First request: decode, Lanczos3 resize, encode (Zig WASM with Relaxed SIMD)
4. Every subsequent request: served from edge cache in ~5ms

No image uploads. No build step. Pull-through proxy that fetches from your Next.js origin on first request.
