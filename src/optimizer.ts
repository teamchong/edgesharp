/**
 * ImageOptimizer — 3-tier cache with warm DO pool fallback.
 *
 * L1: Cache API (per-datacenter, free, ~5ms)
 * L2: R2 bucket (persistent, $0.015/GB/mo, ~20ms)
 * L3: Image DO pool (Zig WASM, ~100ms, deterministic warm slots)
 */
import type { TransformOptions, TransformResult, ImageModeConfig } from "./types.js";

const OUTPUT_FORMAT = {
  jpeg: { code: 0, mime: "image/jpeg", ext: "jpg" },
  png: { code: 1, mime: "image/png", ext: "png" },
  webp: { code: 0, mime: "image/jpeg", ext: "jpg" }, // WebP maps to JPEG until libwebp is added in Phase 2
} as const;

export class ImageOptimizer {
  private config: Required<ImageModeConfig>;

  constructor(config: ImageModeConfig) {
    this.config = {
      ...config,
      poolSize: config.poolSize ?? 8,
      maxInputSize: config.maxInputSize ?? 10 * 1024 * 1024,
      defaultQuality: config.defaultQuality ?? 80,
    };
  }

  /**
   * Transform an image with 3-tier caching.
   * Returns a Response ready to send to the client.
   */
  async transform(
    sourceKey: string,
    options: Partial<TransformOptions>,
    request: Request,
  ): Promise<Response> {
    const opts = this.normalizeOptions(options, request);
    const cacheKey = this.buildCacheKey(sourceKey, opts);

    // L1: Cache API
    const cache = caches.default;
    const cacheUrl = new URL(`https://edgesharp.internal/${cacheKey}`);
    const cacheRequest = new Request(cacheUrl);
    const cached = await cache.match(cacheRequest);
    if (cached) return cached;

    // L2: R2 bucket
    const r2Object = await this.config.cacheBucket.get(cacheKey);
    if (r2Object) {
      const response = new Response(r2Object.body, {
        headers: this.responseHeaders(opts, r2Object.size),
      });
      // Populate L1 asynchronously
      const r2Clone = response.clone();
      cache.put(cacheRequest, r2Clone);
      return response;
    }

    // L3: Image DO — WASM transform
    const result = await this.transformViaPool(sourceKey, opts);
    if (!result) {
      return new Response("Image transform failed", { status: 500 });
    }

    // Store in R2 (L2)
    await this.config.cacheBucket.put(cacheKey, result.body);

    const response = new Response(result.body, {
      headers: this.responseHeaders(opts, result.body.byteLength),
    });

    // Populate L1
    cache.put(cacheRequest, response.clone());

    return response;
  }

  /**
   * Send transform work to a warm DO from the pool.
   * Deterministic slot naming keeps WASM warm via V8 TurboFan.
   */
  private async transformViaPool(
    sourceKey: string,
    opts: TransformOptions,
  ): Promise<TransformResult | null> {
    // Pick a slot based on hash of the source key for even distribution
    const slot = this.hashSlot(sourceKey);
    const doId = this.config.imageDO.idFromName(`img-slot-${slot}`);
    const doHandle = this.config.imageDO.get(doId);

    const response = await doHandle.fetch("https://edgesharp.internal/transform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceKey,
        width: opts.width,
        format: opts.format,
        quality: opts.quality,
      }),
    });

    if (!response.ok) return null;

    const body = await response.arrayBuffer();
    const formatInfo = OUTPUT_FORMAT[opts.format];

    return {
      body,
      contentType: formatInfo.mime,
      width: opts.width,
      height: 0, // Set by the DO during transform
    };
  }

  private normalizeOptions(
    opts: Partial<TransformOptions>,
    request: Request,
  ): TransformOptions {
    return {
      width: opts.width ?? 0,
      format: opts.format ?? this.negotiateFormat(request),
      quality: opts.quality ?? this.config.defaultQuality,
    };
  }

  /** Pick best output format from Accept header. */
  private negotiateFormat(request: Request): TransformOptions["format"] {
    const accept = request.headers.get("Accept") ?? "";
    // WebP is the best we can serve (AVIF encoding is too slow in WASM).
    // Once libwebp is integrated, this returns "webp" for supporting browsers.
    // Until then, prefer JPEG for photographic content.
    if (accept.includes("image/webp")) return "jpeg"; // Switch to "webp" after Phase 2
    if (accept.includes("image/png")) return "png";
    return "jpeg";
  }

  private buildCacheKey(sourceKey: string, opts: TransformOptions): string {
    return `v1/${sourceKey}/w${opts.width}_q${opts.quality}.${OUTPUT_FORMAT[opts.format].ext}`;
  }

  private responseHeaders(opts: TransformOptions, size: number): HeadersInit {
    return {
      "Content-Type": OUTPUT_FORMAT[opts.format].mime,
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Vary": "Accept",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "script-src 'none'; frame-src 'none'; sandbox;",
    };
  }

  /** Hash source key to a pool slot index for even distribution. */
  private hashSlot(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % this.config.poolSize;
  }
}
