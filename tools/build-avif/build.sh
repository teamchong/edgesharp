#!/usr/bin/env bash
set -euo pipefail
#
# Reproducible size-first build of libavif + libaom for the Worker.
# See ./README.md for the rationale and what each patch changes.
#
# Output: wasm/vendor/avif_enc/{avif_enc.wasm,avif_enc.js}
#
# Requirements: emscripten (emcc, emmake, emcmake), git, cmake, make, curl.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Cloning jsquash into $WORK"
git clone --depth 1 https://github.com/jamsinclair/jSquash.git "$WORK/jsquash" >/dev/null 2>&1

CODEC="$WORK/jsquash/packages/avif/codec"

echo "==> Patching emcc link line: -Oz -flto, drop assertions, gc unused symbols"
python3 - "$CODEC/helper.Makefile" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
# CMake → MinSizeRel + size flags
s = s.replace(
    "-DCMAKE_BUILD_TYPE=Release",
    '-DCMAKE_BUILD_TYPE=MinSizeRel '
    '-DCMAKE_C_FLAGS_MINSIZEREL="-Oz -flto -fdata-sections -ffunction-sections -DNDEBUG -fmerge-all-constants" '
    '-DCMAKE_CXX_FLAGS_MINSIZEREL="-Oz -flto -fdata-sections -ffunction-sections -DNDEBUG -fmerge-all-constants"',
)
# Tighten the emcc final link
s = s.replace(
    "-s INITIAL_MEMORY=$(INITIAL_MEMORY_SIZE) \\",
    "-s INITIAL_MEMORY=$(INITIAL_MEMORY_SIZE) \\\n"
    "\t\t-Oz -flto \\\n"
    "\t\t-s ASSERTIONS=0 -s SUPPORT_ERRNO=0 \\\n"
    "\t\t-s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \\\n"
    "\t\t-s MALLOC=emmalloc \\\n"
    "\t\t-Wl,--gc-sections \\",
)
p.write_text(s)
PY

echo "==> Patching libaom: drop high-bit-depth, decoder, threads, debug paths"
# Strip features we never use:
#   AV1_DECODER=0     — we encode only; the JPEG/PNG/WebP decoders are in our
#                       Zig WASM, AVIF inputs are decoded by the browser
#   MULTITHREAD=0     — Workers run single-threaded; thread/sync code is dead weight
#   AV1_HIGHBITDEPTH=0 — 8-bit RGBA inputs only
#   INSPECTION/INTERNAL_STATS/BITSTREAM_DEBUG/TUNE_*/WEBM_IO=0 — debug + unused IO paths
#
# Note: REALTIME_ONLY=1 was tried and reverted. libavif uses AOM_USAGE_GOOD_QUALITY
# for stills, which requires the non-realtime encoder paths. Keeping them in.
python3 - "$CODEC/Makefile" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
s = s.replace(
    "-DCONFIG_AV1_HIGHBITDEPTH=1",
    "-DCONFIG_AV1_HIGHBITDEPTH=0 "
    "-DCONFIG_AV1_DECODER=0 "
    "-DCONFIG_MULTITHREAD=0 "
    "-DCONFIG_INSPECTION=0 "
    "-DCONFIG_INTERNAL_STATS=0 "
    "-DCONFIG_BITSTREAM_DEBUG=0 "
    "-DCONFIG_TUNE_BUTTERAUGLI=0 "
    "-DCONFIG_TUNE_VMAF=0 "
    "-DCONFIG_WEBM_IO=0",
)
p.write_text(s)
PY

echo "==> Patching libavif: encode-only, no SharpYUV/libyuv"
# libavif by default builds both encode and decode; we only encode. Disabling
# decode saves ~150-300 KB raw. SharpYUV + libyuv are optional dependencies for
# higher-quality 4:2:0 chroma — we're fine with the default sampler.
python3 - "$CODEC/helper.Makefile" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
s = s.replace(
    "-DAVIF_CODEC_AOM=ON",
    "-DAVIF_CODEC_AOM=ENCODE "
    "-DAVIF_LIBYUV=OFF "
    "-DAVIF_LIBSHARPYUV=OFF",
)
p.write_text(s)
PY

echo "==> Building (libaom + libavif + emcc link, ~5-15 min)"
cd "$CODEC"
emmake make enc/avif_enc.js

DST="$REPO_ROOT/wasm/vendor/avif_enc"
mkdir -p "$DST"
cp "$CODEC/enc/avif_enc.wasm" "$DST/"
cp "$CODEC/enc/avif_enc.js"   "$DST/"
RAW_BYTES="$(stat -f%z "$DST/avif_enc.wasm" 2>/dev/null || stat -c%s "$DST/avif_enc.wasm")"
GZ_BYTES="$(gzip -c9 "$DST/avif_enc.wasm" | wc -c | tr -d ' ')"
echo "==> Wrote $DST/avif_enc.wasm — raw $RAW_BYTES B / gzip $GZ_BYTES B"
