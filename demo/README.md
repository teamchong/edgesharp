# edgesharp · Next.js demo

A real Next.js 15 app showing the entire edgesharp integration — one config
change — and what happens when you swap in a custom loader. The whole site
ships **as bundled assets inside the same Worker** that does the image
transforms, so one URL serves both the demo and the API.

## The integration

One file. That's it.

```
demo/
  next.config.mjs        — points images.loaderFile at edgesharp's loader
  app/page.tsx           — uses next/image as you already do (no change)
```

Why a `node_modules` path? Next.js bundles the loader into the **client** at
build time, while `next.config.mjs` runs in **Node** — so `loaderFile` has to
be a path the build process can resolve and bundle separately. You can't
`import` the loader into your config.

## One bundle

| Entry point | Raw size | gzip size | Plan | Formats |
|---|---|---|---|---|
| `src/worker.ts` | ~1.73 MB | **~838 KB** | Free | JPEG, PNG, WebP, native AVIF |

Free plan friendly: 838 KB fits the 1 MB compressed limit. AVIF is on by
default; flip `env.ENABLE_AVIF = "false"` in the Cloudflare dashboard to make
AVIF requests fall back to WebP without a redeploy.

The cold-boot cost over the old 90 KB JPEG/PNG/WebP-only bundle is small
(~15–40 ms): wrangler precompiles the libavif WASM at deploy time, and the
encoder module is only instantiated on the first AVIF request. Workers that
never serve AVIF never pay the libavif startup cost.

The libavif WASM was rebuilt from source with size-first emcc flags (`-Oz -flto`, `MinSizeRel`, `CONFIG_AV1_HIGHBITDEPTH=0`) — 1.5 MB instead of jsquash's stock 3.4 MB.

## Local development

```bash
# Build the Zig WASM, the loader, and the demo
cd ..
pnpm install
pnpm run build:wasm
pnpm run build:loader
pnpm run build:demo

# Single bundle (libavif always included)
npx wrangler dev
```

Open <http://localhost:8787>. The page, the source images, and the
`/_next/image` API are all served by the local Worker.

## Deploy

```bash
# Single bundle — Free plan friendly (~838 KB gzip, libavif included)
pnpm run deploy
```

Builds the WASM, the loader, and the static demo, then ships via
`wrangler deploy`.

## Demo source images

`public/demo/` contains four sources used by the page:

| File | Size | Purpose |
|---|---|---|
| `photo.jpg` | 2000×1500, ~960 KB | typical web photo |
| `photo-4k.jpg` | 4000×3000, ~3.7 MB | 4K source |
| `ui.png` | 1280×800, ~29 KB | flat UI mock for PNG output |
| `portrait.jpg` | stored 2000×1500 with EXIF orientation=6 | exercises auto-rotate |
| `icon.png` | 512×512 | favicon |

Regenerate them deterministically with `node ../scripts/gen-demo-images.mjs`.
