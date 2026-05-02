---
title: Backend Modes
description: Pick the engine. WASM, Cloudflare Images, or the smart default that uses both.
---

edgesharp supports three backend modes via the `IMAGE_BACKEND` environment variable.

## `auto` (default)

The recommended mode. Sends JPEG/PNG/WebP through Zig WASM and serves AVIF natively via the bundled libavif. The `DISABLED_FORMATS` env var (comma-separated; recognized values: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`) drops any of these from negotiation at runtime; the negotiator skips disabled output formats and picks the next-best one the browser accepts.

```json
{ "IMAGE_BACKEND": "auto" }
```

**How it picks a format:**

| Browser wants | When that format is enabled | When that format is disabled |
|---|---|---|
| AVIF | Native libavif via WASM | Negotiator picks WebP, then JPEG |
| WebP | WASM (libwebp) | Negotiator picks JPEG |
| PNG | WASM (miniz) | Negotiator picks JPEG |
| JPEG | WASM (hand-rolled Zig) | Worker returns 415 if no other accepted format remains |

## One bundle, libavif always included

The custom-built libavif encoder is ~1.55 MB compiled (down from 3.4 MB upstream, see below). Bundled into the single `src/worker.ts` entry, the whole Worker still ships at ~838 KB gzip. Needs Workers Paid ($5/month per Cloudflare account); Workers Free is not supported.

**Bundle size** (after `wrangler deploy --dry-run`):

| Entry | `edgesharp.wasm` | `avif_enc.wasm` | Worker JS | Total raw | Total gzip |
|---|---|---|---|---|---|
| `src/worker.ts` | 172 KB | 1.55 MB | 14 KB | ~1.73 MB | ~838 KB |

The cold-boot cost over the old JPEG/PNG/WebP-only bundle (~90 KB gzip) is small (~15–40 ms): wrangler precompiles the libavif WASM at deploy time, and the encoder is only instantiated on the first AVIF request. Workers that never serve AVIF never pay the libavif startup cost.

## `DISABLED_FORMATS` runtime kill switch

A single comma-separated env var drops formats at runtime without a
redeploy. Recognized values: `jpeg`, `png`, `webp`, `avif`, `gif`, `svg`.
Empty / unset = every format enabled.

- **Transformed outputs** (`jpeg`, `png`, `webp`, `avif`), disabling
  means the negotiator skips that format and picks the next-best one the
  browser accepts. If every format the browser accepts is disabled, the
  Worker returns 415.
- **Passthrough inputs** (`gif`, `svg`), disabling means the Worker
  rejects those source types with 415 instead of returning the bytes
  unchanged.

Typical settings:

- `DISABLED_FORMATS="avif"`: drop AVIF first when CPU costs creep. AVIF
  encode is ~3–4× more CPU than WebP; the negotiator picks WebP for
  AVIF-capable browsers, which gets you 60–80% of AVIF's compression
  savings at a fraction of the encode cost.
- `DISABLED_FORMATS="svg,gif"`: refuse SVG and animated GIF inputs.
- `DISABLED_FORMATS="avif,webp"`: JPEG-only output.
- `DISABLED_FORMATS="webp"`: useful when a downstream tool can't read
  WebP and you want JPEG output everywhere.
- `DISABLED_FORMATS="png"`: force JPEG even when only PNG is acceptable;
  loses transparency, only safe if you control the input set.

Set in the Cloudflare dashboard (Workers → your Worker → Settings →
Variables). Re-enable a format by removing it from the list. The bundled
WASM doesn't shrink, the encoder simply isn't instantiated when its
format is disabled.

### How `edgesharp.wasm` got from 309 KB → 172 KB

- `-Oz` instead of `-O2` on C deps (miniz, libwebp), **biggest single win**, ~80 KB shaved
- `-flto` for cross-translation-unit dead-code elimination, another ~20 KB raw / ~6 KB gzip
- `-fstrip` + `-fdata-sections` + `-ffunction-sections`: linker GCs unreachable symbols
- `-fno-unwind-tables` / `-fno-asynchronous-unwind-tables` / `-fmerge-all-constants`
- `-DNDEBUG`: drops `assert()` bodies
- `wasm-opt -Oz --converge --strip-debug --strip-producers` post-pass

### How `avif_enc.wasm` got from 3.4 MB → 1.5 MB

The libavif WASM in `wasm/vendor/avif_enc/` is a custom build of libavif v1.0.1 + libaom v3.7.0 instead of `@jsquash/avif`'s shipped binary. The `Makefile` in `tools/build-avif/` reproduces it. Key differences vs upstream:

- `-DCMAKE_BUILD_TYPE=MinSizeRel` (uses `-Oz`) instead of `Release` (uses `-O3`)
- `-flto -fdata-sections -ffunction-sections` everywhere
- `-DCONFIG_AV1_HIGHBITDEPTH=0`: drops 10/12-bit AV1 paths from libaom; we encode 8-bit RGBA only
- emcc link adds `-Wl,--gc-sections -s ASSERTIONS=0 -s SUPPORT_ERRNO=0`

Net: **60% smaller raw, 32% smaller after gzip** versus the stock jsquash WASM. No quality regression, it's the same encoder, just compiled smaller.

See [`wasm/build-wasm.sh`](https://github.com/teamchong/edgesharp/blob/main/wasm/build-wasm.sh) for the Zig+C side and `wasm/vendor/avif_enc/README.md` for the libavif rebuild recipe.

## Native AVIF is on by default

Nothing to opt in to: `pnpm run deploy` ships the bundle with libavif
included, and `auto` mode immediately negotiates AVIF for browsers that send
`Accept: image/avif`. Add `avif` (or any other format) to `DISABLED_FORMATS`
and that format drops from negotiation, no error, the negotiator picks
the next-best format the browser accepts.

## `wasm`

Identical to `auto` minus the CF Images fallback. Useful when you want to be sure no requests touch the `IMAGES` binding, even if it's configured.

```json
{ "IMAGE_BACKEND": "wasm" }
```

| Format | Engine | Disable with |
|---|---|---|
| JPEG | Zig WASM (baseline + progressive via stb_image) | `DISABLED_FORMATS="jpeg"` |
| PNG | Zig WASM (zlib via miniz) | `DISABLED_FORMATS="png"` |
| WebP | Zig WASM (libwebp) | `DISABLED_FORMATS="webp"` |
| AVIF | Vendored libavif WASM | `DISABLED_FORMATS="avif"` |

## `cf-images`

The graduate-up mode. Routes every request through [Cloudflare Images](https://developers.cloudflare.com/images/), the managed image service with focal-point cropping, signed URLs, format detection, and an SLA. When your project has product-market fit and you want professional-grade image transforms with someone else operating the encoders, flip this and the same `wrangler.json` keeps working.

```json
{ "IMAGE_BACKEND": "cf-images" }
```

Requires the Images binding:

```json
{
  "images": {
    "binding": "IMAGES"
  }
}
```

| Format | Engine |
|---|---|
| JPEG | CF Images |
| PNG | CF Images |
| WebP | CF Images |
| AVIF | CF Images |

[Pricing](https://developers.cloudflare.com/images/pricing/): 5,000 free transforms/month, then $0.50 per 1K unique transforms. `DISABLED_FORMATS` still applies if you want to gate which formats CF Images encodes.

## When to pick each mode

This isn't a price race, `auto` (WASM) and `cf-images` are aimed at different lifecycle stages of the same Next.js app.

**Pick `auto` (WASM) when:**
- You want off the Vercel per-transform line item without paying anything new while you find product-market fit
- Your image set is small or stable, first transforms are cached forever, repeat traffic is free egress
- You're comfortable with the [supported format list](/compatibility/) (the common Next.js cases. JPEG, PNG, WebP, AVIF, animated/SVG passthrough; no CMYK, no RAW)

**Pick `cf-images` when:**
- The project has scaled and you want a managed image service with an SLA, focal-point cropping, signed URLs, and the encoder-quality work Cloudflare Images puts into output
- You'd rather spend on the [Cloudflare Images line item](https://developers.cloudflare.com/images/pricing/) than operate the WASM build yourself
- You need formats edgesharp doesn't ship (TIFF input, CMYK, etc.)

The same `wrangler.json` and Next.js loader work for both. Switching is a single env-var flip in the dashboard, no redeploy, no URL changes.

For a comparison against [Vercel's per-transform pricing](https://vercel.com/docs/image-optimization/limits-and-pricing) (the bill people are usually trying to get out from under), see [Compatibility → Costs](/compatibility/#costs).
