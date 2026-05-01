#!/bin/bash
set -euo pipefail

# Collect libwebp C sources. Skip SIMD variants we can't reach on wasm32
# (the wasm target has its own simd128 path; we don't ship sse/neon/mips/msa).
# Other "encoder-only / decoder-only" looking files cross-reference each other
# in libwebp's source tree (e.g. quant_enc → VP8TransformWHT in dsp/dec.c),
# so they all stay and rely on -ffunction-sections + the linker GC pass to
# drop the actually-unreachable code paths.
WEBP_FILES=""
for f in $(find src/libwebp -name "*.c" -not -name "*_sse2.c" -not -name "*_sse41.c" -not -name "*_neon.c" -not -name "*_mips*" -not -name "*_msa.c" | sort); do
  WEBP_FILES="$WEBP_FILES $f"
done

# C compile flags target the smallest possible binary:
#   -Oz                                — size-first optimization (vs -O2 = speed)
#   -fno-unwind-tables / -fno-async-…  — drop exception unwind metadata; freestanding can't unwind anyway
#   -fdata-sections / -ffunction-sections — let the linker GC unreachable functions/globals
#   -fmerge-all-constants              — dedupe identical strings/constants
#   -fno-stack-protector               — no canary instrumentation
#   -fno-sanitize=undefined            — no UBSan trap calls
#   -DNDEBUG                           — drop assert() bodies in C deps
zig build-exe src/wasm.zig \
  -target wasm32-freestanding \
  -O ReleaseSmall \
  --name edgesharp \
  -fno-entry \
  -rdynamic \
  -fstrip \
  -cflags \
    -DMINIZ_NO_STDIO \
    -DMINIZ_NO_TIME \
    -DMINIZ_NO_ARCHIVE_APIS \
    -DMINIZ_NO_ARCHIVE_WRITING_APIS \
    -DWEBP_EXTERN=extern \
    -DNDEBUG \
    -I src/libwebp \
    -isystem src/libc \
    -fno-stack-protector \
    -fno-sanitize=undefined \
    -fno-unwind-tables \
    -fno-asynchronous-unwind-tables \
    -fdata-sections \
    -ffunction-sections \
    -fmerge-all-constants \
    -flto \
    -Oz \
  -- \
  src/miniz.c \
  src/webp_advanced.c \
  src/stb_jpeg_wrapper.c \
  $WEBP_FILES

raw_zig=$(stat -f%z edgesharp.wasm 2>/dev/null || stat -c%s edgesharp.wasm)

# Post-process with wasm-opt -Oz if available. Cuts another ~10% raw / ~4% gz
# by re-running peephole passes binaryen knows about that LLVM doesn't.
if command -v wasm-opt > /dev/null 2>&1; then
  wasm-opt \
    --enable-bulk-memory \
    --enable-simd \
    --enable-sign-ext \
    --enable-nontrapping-float-to-int \
    --enable-mutable-globals \
    -Oz --converge \
    --strip-debug --strip-producers \
    edgesharp.wasm -o edgesharp.opt.wasm
  mv edgesharp.opt.wasm edgesharp.wasm
  raw_opt=$(stat -f%z edgesharp.wasm 2>/dev/null || stat -c%s edgesharp.wasm)
  printf "Built edgesharp.wasm  raw %d B → %d B (wasm-opt %.1f%% smaller)\n" \
    "$raw_zig" "$raw_opt" "$(awk -v a=$raw_zig -v b=$raw_opt 'BEGIN{print (1-b/a)*100}')"
else
  echo "Built edgesharp.wasm  raw $raw_zig B  (wasm-opt not found — install binaryen for an extra ~10%)"
fi
