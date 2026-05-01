# Custom libavif build

The `wasm/vendor/avif_enc/` WASM is a size-first rebuild of libavif + libaom
that ships ~60% smaller raw (32% smaller gzipped) than `@jsquash/avif`'s
upstream binary. This is what lets the single Worker bundle (Zig WASM +
libavif + Worker JS) fit Cloudflare Workers' Free plan compressed limit.

## What it costs

- Builds libavif v1.0.1 + libaom v3.7.0 + libwebp/libsharpyuv from source
- Requires `emscripten` 3.x or newer (verified working with 5.0.5)
- ~5–10 minutes on a modern machine; libaom dominates

## Reproducing the build

```bash
# from the repo root
./tools/build-avif/build.sh
```

The script clones jsquash, applies the size-first patches, runs `emmake make`,
and copies the resulting `avif_enc.wasm` + `avif_enc.js` into
`wasm/vendor/avif_enc/`.

## What changes versus jsquash's stock build

`emcc` link line:

```
+ -Oz -flto                     # was -O3 -flto
+ -s ASSERTIONS=0
+ -s SUPPORT_ERRNO=0
+ -s ALLOW_MEMORY_GROWTH=1      # required for large input frames
+ -s FILESYSTEM=0
+ -s MALLOC=emmalloc            # smaller than dlmalloc
+ -Wl,--gc-sections
+ -fmerge-all-constants
```

CMake flags for libavif and libaom:

```
+ -DCMAKE_BUILD_TYPE=MinSizeRel               # was Release (= -O3)
+ -DCMAKE_C_FLAGS_MINSIZEREL="-Oz -flto -fdata-sections -ffunction-sections -DNDEBUG -fmerge-all-constants"
+ -DCMAKE_CXX_FLAGS_MINSIZEREL="-Oz -flto -fdata-sections -ffunction-sections -DNDEBUG -fmerge-all-constants"
```

libaom feature flags:

```
+ -DCONFIG_AV1_HIGHBITDEPTH=0    # we encode 8-bit RGBA only; drops 10/12-bit AV1 code
+ -DCONFIG_AV1_DECODER=0         # we encode only — JPEG/PNG/WebP decoders live in our Zig WASM
+ -DCONFIG_MULTITHREAD=0         # Workers run single-threaded; thread/sync code is dead weight
+ -DCONFIG_INSPECTION=0          # debug-only feature
+ -DCONFIG_INTERNAL_STATS=0      # debug-only stats
+ -DCONFIG_BITSTREAM_DEBUG=0     # debug-only
+ -DCONFIG_TUNE_BUTTERAUGLI=0    # quality metric we don't use
+ -DCONFIG_TUNE_VMAF=0           # quality metric we don't use
+ -DCONFIG_WEBM_IO=0             # we don't read/write WebM
```

libavif CMake flags:

```
+ -DAVIF_CODEC_AOM=ENCODE        # encode-only build of the libavif/libaom bridge
+ -DAVIF_LIBYUV=OFF              # default sampler is fine; libyuv adds size
+ -DAVIF_LIBSHARPYUV=OFF         # we set enableSharpYUV=false at the API level
```

## What was tried and reverted

`-DCONFIG_REALTIME_ONLY=1` looks attractive — it strips libaom's "good quality"
and "all intra" encoder paths and saves ~250 KB raw — but **breaks encoding for
real images**. libavif uses `AOM_USAGE_GOOD_QUALITY` for stills, which the
realtime-only build deletes. Don't add this back without also patching libavif's
encoder usage flag (and accepting realtime mode's lower compression efficiency,
which would defeat the point of using AVIF over WebP).

## Bundle impact

| | Raw | gzip |
|---|---|---|
| `@jsquash/avif` upstream | 3.49 MB | 1.12 MB |
| custom build (this) | **1.55 MB** | **739 KB** |
| Δ | –56% | –34% |

Worker bundle (single-bundle deploy with libavif always included) lands at
**~832 KB gzip** — under the Workers Free plan's 1 MB compressed limit.

## Re-vendoring

`avif_enc.wasm` and `avif_enc.js` are committed to `wasm/vendor/avif_enc/`.
Don't edit the wasm by hand. Run `build.sh` to regenerate them when bumping
libavif/libaom versions.
