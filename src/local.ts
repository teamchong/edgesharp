/**
 * edgesharp/local — Sharp-based image optimization for Node.js / local dev.
 *
 * Uses native libvips via Sharp (same engine as Vercel).
 * Identical API surface to the Workers optimizer, but runs locally
 * without Durable Objects or R2.
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

interface TransformOptions {
  width: number;
  format: "jpeg" | "png" | "webp";
  quality: number;
}

interface LocalConfig {
  /** Directory to cache transformed images. Default: .edgesharp-cache */
  cacheDir?: string;
  /** Default quality 1-100. Default: 80 */
  defaultQuality?: number;
}

export class LocalImageOptimizer {
  private cacheDir: string;
  private defaultQuality: number;
  private sharpModule: typeof import("sharp") | null = null;

  constructor(config?: LocalConfig) {
    this.cacheDir = config?.cacheDir ?? ".edgesharp-cache";
    this.defaultQuality = config?.defaultQuality ?? 80;
  }

  /**
   * Transform an image file on disk.
   * Returns the path to the cached, transformed file.
   */
  async transformFile(
    sourcePath: string,
    options: Partial<TransformOptions>,
  ): Promise<{ path: string; contentType: string }> {
    const opts = this.normalizeOptions(options);
    const cacheKey = this.buildCacheKey(sourcePath, opts);
    const cachePath = join(this.cacheDir, cacheKey);

    // Check disk cache
    try {
      await stat(cachePath);
      return { path: cachePath, contentType: MIME[opts.format] };
    } catch {
      // Cache miss — transform below
    }

    const sharp = await this.getSharp();
    const input = await readFile(sourcePath);

    let pipeline = sharp(input);

    // Resize with Lanczos3 (Sharp's default kernel)
    if (opts.width > 0) {
      pipeline = pipeline.resize(opts.width, undefined, {
        withoutEnlargement: true,
      });
    }

    // Encode
    switch (opts.format) {
      case "webp":
        pipeline = pipeline.webp({ quality: opts.quality });
        break;
      case "png":
        pipeline = pipeline.png({ quality: opts.quality });
        break;
      case "jpeg":
        pipeline = pipeline.jpeg({ quality: opts.quality, mozjpeg: true });
        break;
    }

    const encoded = await pipeline.toBuffer();

    // Write to disk cache
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, encoded);

    return { path: cachePath, contentType: MIME[opts.format] };
  }

  /**
   * Transform raw bytes (e.g., from an HTTP fetch).
   * Returns the encoded image buffer.
   */
  async transformBuffer(
    input: Buffer | Uint8Array,
    options: Partial<TransformOptions>,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const opts = this.normalizeOptions(options);
    const sharp = await this.getSharp();

    let pipeline = sharp(input);

    if (opts.width > 0) {
      pipeline = pipeline.resize(opts.width, undefined, {
        withoutEnlargement: true,
      });
    }

    switch (opts.format) {
      case "webp":
        pipeline = pipeline.webp({ quality: opts.quality });
        break;
      case "png":
        pipeline = pipeline.png({ quality: opts.quality });
        break;
      case "jpeg":
        pipeline = pipeline.jpeg({ quality: opts.quality, mozjpeg: true });
        break;
    }

    const buffer = await pipeline.toBuffer();
    return { buffer, contentType: MIME[opts.format] };
  }

  private normalizeOptions(opts: Partial<TransformOptions>): TransformOptions {
    return {
      width: opts.width ?? 0,
      format: opts.format ?? "webp",
      quality: opts.quality ?? this.defaultQuality,
    };
  }

  private buildCacheKey(sourcePath: string, opts: TransformOptions): string {
    const hash = createHash("sha256")
      .update(sourcePath)
      .digest("hex")
      .slice(0, 16);
    return `${hash}/w${opts.width}_q${opts.quality}.${EXT[opts.format]}`;
  }

  /** Lazily load sharp — it's an optional peer dependency. */
  private async getSharp(): Promise<typeof import("sharp")> {
    if (this.sharpModule) return this.sharpModule;
    const require = createRequire(import.meta.url);
    this.sharpModule = require("sharp");
    return this.sharpModule!;
  }
}

const MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

const EXT = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
} as const;
