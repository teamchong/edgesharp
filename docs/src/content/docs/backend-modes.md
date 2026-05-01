---
title: Backend Modes
description: Pick the engine — WASM, Cloudflare Images, or the smart default that uses both.
---

edgesharp supports three backend modes via the `IMAGE_BACKEND` environment variable.

## `auto` (default)

The recommended mode. Routes JPEG/PNG/WebP through Zig WASM and serves AVIF natively via the bundled libavif unless AVIF is disabled at runtime (see [`ENABLE_AVIF`](#enable_avif-runtime-kill-switch) below).

```json
{ "IMAGE_BACKEND": "auto" }
```

**How it routes requests:**

| Browser wants | `ENABLE_AVIF` | Engine used | Per-transform cost |
|---|---|---|---|
| AVIF | unset / `"true"` | Native libavif via WASM | None |
| AVIF | `"false"` | Falls back to WebP | None |
| WebP | – | WASM | None |
| JPEG | – | WASM | None |
| PNG | – | WASM | None |

## One bundle, libavif always included

The custom-built libavif encoder is ~1.55 MB compiled (down from 3.4 MB upstream — see below). Bundled into the single `src/worker.ts` entry, the whole Worker still ships at **~838 KB gzip**, so it's **Free plan friendly: 838 KB fits the 1 MB compressed limit.**

**Bundle size** (after `wrangler deploy --dry-run`):

| Entry | `edgesharp.wasm` | `avif_enc.wasm` | Worker JS | Total raw | Total gzip | Plan |
|---|---|---|---|---|---|---|
| `src/worker.ts` | 172 KB | 1.55 MB | 14 KB | ~1.73 MB | ~838 KB | Free |

The cold-boot cost over the old JPEG/PNG/WebP-only bundle (~90 KB gzip) is small (~15–40 ms): wrangler precompiles the libavif WASM at deploy time, and the encoder is only instantiated on the first AVIF request. Workers that never serve AVIF never pay the libavif startup cost.

## `ENABLE_AVIF` runtime kill switch

If you ever need AVIF off — for a cost experiment, a debugging session, or
because you're seeing an issue with a specific viewer — set the environment
variable `ENABLE_AVIF` to `"false"` in the Cloudflare dashboard (Workers →
your Worker → Settings → Variables). AVIF requests then fall back to WebP
without redeploying. Re-enable by deleting the variable or setting it back
to `"true"`. The libavif WASM stays bundled either way.

### How `edgesharp.wasm` got from 309 KB → 172 KB

- `-Oz` instead of `-O2` on C deps (miniz, libwebp) — **biggest single win**, ~80 KB shaved
- `-flto` for cross-translation-unit dead-code elimination — another ~20 KB raw / ~6 KB gzip
- `-fstrip` + `-fdata-sections` + `-ffunction-sections` — linker GCs unreachable symbols
- `-fno-unwind-tables` / `-fno-asynchronous-unwind-tables` / `-fmerge-all-constants`
- `-DNDEBUG` — drops `assert()` bodies
- `wasm-opt -Oz --converge --strip-debug --strip-producers` post-pass

### How `avif_enc.wasm` got from 3.4 MB → 1.5 MB

The libavif WASM in `wasm/vendor/avif_enc/` is a custom build of libavif v1.0.1 + libaom v3.7.0 instead of `@jsquash/avif`'s shipped binary. The `Makefile` in `tools/build-avif/` reproduces it. Key differences vs upstream:

- `-DCMAKE_BUILD_TYPE=MinSizeRel` (uses `-Oz`) instead of `Release` (uses `-O3`)
- `-flto -fdata-sections -ffunction-sections` everywhere
- `-DCONFIG_AV1_HIGHBITDEPTH=0` — drops 10/12-bit AV1 paths from libaom; we encode 8-bit RGBA only
- emcc link adds `-Wl,--gc-sections -s ASSERTIONS=0 -s SUPPORT_ERRNO=0`

Net: **60% smaller raw, 32% smaller after gzip** versus the stock jsquash WASM. No quality regression — it's the same encoder, just compiled smaller.

See [`wasm/build-wasm.sh`](https://github.com/teamchong/edgesharp/blob/main/wasm/build-wasm.sh) for the Zig+C side and `wasm/vendor/avif_enc/README.md` for the libavif rebuild recipe.

## Native AVIF is on by default

Nothing to opt in to: `pnpm run deploy` ships the bundle with libavif
included, and `auto` mode immediately negotiates AVIF for browsers that send
`Accept: image/avif`. If you flip `ENABLE_AVIF` to `"false"` in the
dashboard, AVIF requests gracefully degrade to WebP — no error, just the
next-best format.

## `wasm`

Identical to `auto` minus the CF Images fallback. Useful when you want to be sure no requests touch the `IMAGES` binding, even if it's configured.

```json
{ "IMAGE_BACKEND": "wasm" }
```

| Format | Supported | Engine |
|---|---|---|
| JPEG | Yes | Zig WASM (baseline DCT) |
| PNG | Yes | Zig WASM (zlib via miniz) |
| WebP | Yes | Zig WASM (libwebp) |
| AVIF | Yes (unless `ENABLE_AVIF=false`) | Vendored libavif WASM |

## `cf-images`

Everything goes through Cloudflare Images. Full format support including AVIF, with [CF Images' encoders](https://developers.cloudflare.com/images/transform-images/) handling the heavy lifting at $0.50 per 1,000 unique transforms.

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

| Format | Supported | Engine |
|---|---|---|
| JPEG | Yes | CF Images |
| PNG | Yes | CF Images |
| WebP | Yes | CF Images |
| AVIF | Yes | CF Images |

Best for: full format coverage, apps that want CF Images' encoder quality on every request.

## Cost at 1M unique transforms / month

Reference numbers for 1M unique transforms in a month. Storage assumes ~20 KB average output (200 GB) at $0.015/GB on R2; egress is free on R2 so it doesn't appear as a line item. All per-transform prices from official sources.

| Mode | Estimate | Notes |
|---|---|---|
| edgesharp (default — native AVIF on) | ~$3 | Workers Paid + ~200 GB on [R2](https://developers.cloudflare.com/r2/pricing/), no per-transform fees. AVIF runs through the vendored libavif WASM — no Cloudflare Images binding fee. The bundle fits Free plan, but Workers Paid covers the higher CPU usage at this scale. |
| `cf-images` | ~$497 | $0.50/1K × ~995K billable transforms via [CF Images](https://developers.cloudflare.com/images/pricing/) |
| [Vercel](https://vercel.com/docs/image-optimization/limits-and-pricing) | ~$50+ | $0.05/1K transforms plus cache read ($0.40/1M) and cache write ($4/1M) fees |

See also: [HowdyGo's case study](https://www.howdygo.com/blog/cutting-howdygos-vercel-costs-by-80-without-compromising-ux-or-dx) on cutting Vercel image costs 80% with self-hosted optimization.
