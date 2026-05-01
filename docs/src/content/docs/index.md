---
title: edgesharp
description: Zero-cost image optimization on Cloudflare Workers via Zig WASM SIMD.
template: splash
hero:
  tagline: Drop-in image optimization for Next.js apps. Free at any scale. Powered by Zig WASM SIMD on Cloudflare Workers.
  actions:
    - text: Get Started
      link: /edgesharp/getting-started/
      icon: right-arrow
    - text: GitHub
      link: https://github.com/teamchong/edgesharp
      icon: external
      variant: minimal
---

## The problem

Image optimization is one of the most common per-transform line items on a serverless bill. If you're already on Cloudflare or moving to it, you want the same drop-in `<Image>` experience as Next.js's default loader — but billed against Workers CPU + R2 storage instead of a per-transform fee.

edgesharp is a Cloudflare-native `/_next/image` replacement that runs on Workers. It compiles JPEG/PNG/WebP transforms to Zig WASM, ships a custom-built libavif for native AVIF, caches results in R2 (free egress), and ships as a single Worker bundle. **Free plan friendly: 838 KB fits the 1 MB compressed limit.** AVIF is on by default; set `ENABLE_AVIF = "false"` in the Cloudflare dashboard if you want AVIF requests to fall back to WebP without redeploying.

## Why Cloudflare-native

[R2 egress to the internet is free](https://developers.cloudflare.com/r2/pricing/). That single line is the structural reason an image cache built on Workers + R2 doesn't pay the cache-write and bandwidth fees that pile up elsewhere. You pay only [$0.015/GB/month](https://developers.cloudflare.com/r2/pricing/) for stored output.

## Pricing comparison

All numbers from official pricing pages. Links to sources in each row.

| Solution | Cost per 1,000 transforms | Setup |
|---|---|---|
| [Vercel (new pricing)](https://vercel.com/docs/image-optimization/limits-and-pricing) | $0.05 + cache read/write fees | Zero config |
| [Cloudflare Images](https://developers.cloudflare.com/images/pricing/) | $0.50 per 1K unique transforms | Bind `IMAGES` |
| edgesharp | Workers CPU + R2 storage (free egress) — native AVIF included, no per-transform fees | One config change |

5,000 free transforms/month are included with Cloudflare Images. edgesharp has no per-transform fees at any scale — the bundle includes a custom size-first build of libavif so AVIF requests don't need the Cloudflare Images binding.

## How it works

1. Browser requests `/_next/image?url=/photo.jpg&w=640&q=75`
2. edgesharp checks Cache API, R2, then fetches from your origin
3. First request: decode, Lanczos3 resize, encode (Zig WASM with Relaxed SIMD)
4. Every subsequent request: served from edge cache in ~5ms

No image uploads. No build step. Pull-through proxy that fetches from your Next.js origin on first request.
