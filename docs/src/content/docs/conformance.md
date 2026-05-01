---
title: Conformance
description: How edgesharp is tested against Next.js and Sharp.
---

## Test strategy

edgesharp is tested at three levels to ensure parity with Next.js image optimization.

### 1. Visual conformance (vs Sharp)

Every resize operation is compared pixel-for-pixel against Sharp (the engine Vercel/Next.js uses). Tests use PSNR (Peak Signal-to-Noise Ratio) with a threshold of 30 dB — below which differences become visible.

**What's tested:**
- JPEG decode + Lanczos3 resize at multiple widths (320, 640, 1080px)
- PNG decode + Lanczos3 resize at multiple widths (64, 256, 384px)
- Aspect ratio preservation
- Quality scaling (lower quality = smaller file)
- Edge cases: 1×1 pixel, panorama (10:1), portrait (1:10), grayscale, transparency
- PNG compression ratio within 2x of Sharp

**Alpha handling:** PSNR is weighted by alpha channel. Fully transparent pixels are skipped since their RGB values are meaningless — different renderers produce different RGB for alpha=0 pixels.

### 2. Protocol conformance (vs Next.js)

HTTP API tests verify edgesharp matches Next.js's `/_next/image` endpoint behavior:

**Parameter validation:**
- Missing/invalid `url` → 400
- Protocol-relative URLs (`//evil.com`) → 400
- Backslash URLs (`/\evil.com`) → 400
- Absolute URLs (`https://...`) → 400
- Scheme injection (`data:`, `javascript:`) → 400
- URL length > 3072 chars → 400
- Width not in allowed sizes → 400
- Width > 3840 → 400
- Quality outside 1-100 → 400

**Content negotiation:**
- Accept header parsing matches Next.js priority (AVIF > WebP > JPEG)
- Format falls back gracefully when backend doesn't support requested format

**Security headers:**
- `Cache-Control: public, max-age=31536000, immutable`
- `Vary: Accept`
- `Content-Security-Policy: script-src 'none'; frame-src 'none'; sandbox;`
- `X-Content-Type-Options: nosniff`

**Content type safety:**
- Safe types (JPEG, PNG, WebP, etc.) are accepted
- Unsafe types (SVG, HTML, JS, PDF) are rejected

### 3. Size conformance (vs Next.js defaults)

Verifies that edgesharp uses the exact same width breakpoints as Next.js:

- `deviceSizes`: [640, 750, 828, 1080, 1200, 1920, 2048, 3840]
- `imageSizes`: [16, 32, 48, 64, 96, 128, 256, 384]
- No overlap between the two sets
- BlurDataURL width = 8px

## Running tests

```bash
# Visual + sizes (no server needed)
npx vitest run tests/conformance/visual.test.ts tests/conformance/sizes.test.ts

# Protocol (requires wrangler dev running)
IMAGEMODE_TEST_URL=http://localhost:8788 npx vitest run tests/conformance/protocol.test.ts
```

## Bugs found by conformance tests

The conformance suite caught and helped fix three significant bugs during development:

1. **JPEG IDCT scaling** — custom integer IDCT had wrong constants (PSNR was 12 dB, should be >= 30). Fixed by replacing with reference floating-point IDCT.

2. **Alpha premultiplication** — resize without premultiplied alpha caused color fringing at transparent edges (PSNR 13 dB on icons). Fixed by premultiplying before resize, unpremultiplying after.

3. **PNG compression** — Zig's stdlib `flate.Compress` was incomplete when this codebase was first written. Fixed by statically linking miniz (public domain C library); kept on Zig 0.16 for consistent output and smaller binary.
