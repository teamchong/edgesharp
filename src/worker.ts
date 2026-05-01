/**
 * edgesharp Worker entry point.
 *
 * Pull-through image optimization proxy with configurable backend:
 *
 *   IMAGE_BACKEND = "auto" (default)
 *     WASM for JPEG/PNG/WebP. CF Images for AVIF (if IMAGES binding exists).
 *
 *   IMAGE_BACKEND = "wasm"
 *     Everything through WASM. No CF Images bill. No AVIF output.
 *
 *   IMAGE_BACKEND = "cf-images"
 *     Everything through CF Images. User pays per-transform. Full AVIF support.
 *
 * Flow:
 *   Browser → /_next/image?url=/photo.jpg&w=640&q=75
 *   Worker  → Cache API (L1) → R2 (L2) → origin fetch + transform (L3)
 */
import { ImageDO } from "./image-do.js";
import { createAvifEncoder } from "./avif.js";

export { ImageDO };

type ImageBackend = "auto" | "wasm" | "cf-images";
type OutputFormat = "jpeg" | "png" | "webp" | "avif";

interface CloudflareImagesBinding {
  input(stream: ReadableStream | ArrayBuffer | Uint8Array): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
    };
  };
}

interface Env {
  IMAGE_DO: DurableObjectNamespace;
  CACHE_BUCKET: R2Bucket;
  ORIGIN: string;
  ALLOWED_ORIGINS?: string;
  // Caller allowlist — comma-separated list of origins/hostnames allowed to
  // call this Worker (matched against the request's Referer header). Unset =
  // anyone can call (demo behavior). Production should set this to your site's
  // origin(s) so the Worker isn't a free image CDN for anyone who guesses the URL.
  ALLOWED_REFERERS?: string;
  // Hard cap on the `?q=` parameter (1-100). Default 100 = no cap. Set to e.g.
  // 85 to silently clamp expensive q=100 requests — saves CPU and bandwidth.
  MAX_QUALITY?: string;
  IMAGE_BACKEND?: string; // "auto" | "wasm" | "cf-images"
  // Per-format kill switches. Default: every format enabled. Set to "false"
  // or "0" in the Cloudflare dashboard to disable a format at runtime — the
  // negotiator falls back to the next-best supported format. JPEG is the
  // universal fallback and cannot be disabled.
  ENABLE_AVIF?: string;  // disable to drop the most expensive encode (~3-4× more CPU than WebP)
  ENABLE_WEBP?: string;  // disable to force JPEG; rare, but useful for clients with broken WebP support
  ENABLE_PNG?: string;   // disable to force JPEG even when only PNG is acceptable; loses transparency
  IMAGES?: CloudflareImagesBinding; // optional CF Images binding
  ASSETS?: Fetcher; // bundled static assets (demo HTML + sample images)
}

interface FormatsEnabled {
  avif: boolean;
  webp: boolean;
  png: boolean;
}

function readFormatsEnabled(env: Env): FormatsEnabled {
  const isOff = (v: string | undefined) => v === "false" || v === "0";
  return {
    avif: !isOff(env.ENABLE_AVIF),
    webp: !isOff(env.ENABLE_WEBP),
    png: !isOff(env.ENABLE_PNG),
  };
}

// Next.js default sizes
const DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];
const ALLOWED_WIDTHS = new Set([...DEVICE_SIZES, ...IMAGE_SIZES, 0]);
const MAX_URL_LENGTH = 3072;
const MAX_WIDTH = 3840;

const SAFE_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
  "image/x-icon", "image/vnd.microsoft.icon", "image/bmp", "image/tiff",
  "image/svg+xml",
]);

const SECURITY_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "Vary": "Accept",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "script-src 'none'; frame-src 'none'; sandbox;",
  "Content-Disposition": "inline",
} as const;

const FORMAT_WASM_CODE = { jpeg: 0, png: 1, webp: 2 } as const;
const FORMAT_MIME: Record<OutputFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};
const FORMAT_EXT: Record<OutputFormat, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  avif: "avif",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/_next/image") {
      // Single-Worker deploy: every other path is served by the bundled
      // static assets (the Next.js demo export + Next.js JS chunks).
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not Found", { status: 404 });
    }

    // Caller allowlist — only enforced when ALLOWED_REFERERS is set. The
    // check happens before parsing/cache lookup so abusive callers don't
    // even get a 304-fast-path. Same-origin requests (the bundled demo
    // calling its own /_next/image) are always allowed.
    if (!isCallerAllowed(request, env, url)) {
      return new Response("Forbidden referer", { status: 403 });
    }

    const params = parseImageParams(url.searchParams, env);
    if (!params.ok) {
      return new Response(params.error, { status: 400 });
    }
    const { imageUrl, width, quality } = params;

    const allowedOrigins = getAllowedOrigins(env);
    const resolved = resolveOriginUrl(imageUrl, allowedOrigins);
    if (!resolved.ok) {
      const message =
        resolved.reason === "host-not-allowed"
          ? `Host '${resolved.host}' not in ALLOWED_ORIGINS`
          : resolved.reason === "bad-url"
            ? "Could not parse image URL"
            : "No ORIGIN configured for path-relative URLs";
      return new Response(message, { status: 400 });
    }
    const originUrl = resolved.url;

    // ── Negotiate output format + pick backend ──
    const backend = resolveBackend(env);
    const accept = request.headers.get("Accept") ?? "";
    const enabled = readFormatsEnabled(env);
    const outputFormat = negotiateFormat(accept, backend, !!env.IMAGES, enabled);

    // Strong validator: deterministic from the cache key, so a client that
    // already has bytes for this exact (image, w, q, format) can short-circuit
    // with If-None-Match → 304 and skip the response body.
    const etag = `"${buildEtag(imageUrl, width, quality, outputFormat)}"`;
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": SECURITY_HEADERS["Cache-Control"], Vary: "Accept" },
      });
    }

    // ── L1: Cache API ──
    const cacheKey = buildCacheKey(url.origin, imageUrl, width, quality, outputFormat);
    const cache = caches.default;
    const cacheRequest = new Request(cacheKey);
    const cachedResponse = await cache.match(cacheRequest);
    if (cachedResponse) return cachedResponse;

    // ── L2: R2 cache bucket ──
    const r2Key = `v1/${encodeURIComponent(imageUrl)}/w${width}_q${quality}.${FORMAT_EXT[outputFormat]}`;
    const r2Object = await env.CACHE_BUCKET.get(r2Key);
    if (r2Object) {
      const response = new Response(r2Object.body, {
        headers: {
          "Content-Type": FORMAT_MIME[outputFormat],
          ETag: etag,
          ...SECURITY_HEADERS,
        },
      });
      ctx.waitUntil(cache.put(cacheRequest, response.clone()));
      return response;
    }

    // ── L3: Fetch source bytes ──
    // Same-origin paths (/demo/*, /sample/*, anything bundled) come from
    // the ASSETS binding; remote paths fall through to ORIGIN.
    const originResponse = env.ASSETS && imageUrl.startsWith("/demo/")
      ? await env.ASSETS.fetch(new Request(`${url.origin}${imageUrl}`))
      : await fetch(originUrl);
    if (!originResponse.ok) {
      return new Response(`Origin returned ${originResponse.status}`, { status: 404 });
    }

    const contentType = (originResponse.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (!SAFE_IMAGE_TYPES.has(contentType)) {
      return new Response("Unsupported image type: " + contentType, { status: 400 });
    }

    const sourceBytes = new Uint8Array(await originResponse.arrayBuffer());

    // ── Passthrough paths (no transform) ──
    // SVG is vector and animated images would lose their animation if we
    // re-encoded a single frame. Return the source bytes with the original
    // Content-Type and the standard security headers (script-src 'none' +
    // sandbox neutralize any embedded SVG scripts the same way Next.js's
    // own loader does).
    if (contentType === "image/svg+xml" || isAnimated(sourceBytes, contentType)) {
      const response = new Response(sourceBytes, {
        headers: {
          "Content-Type": contentType,
          ETag: etag,
          ...SECURITY_HEADERS,
        },
      });
      // Cache passthrough at L1 only — the R2 key includes the negotiated
      // output format which won't match the actual passthrough Content-Type.
      ctx.waitUntil(cache.put(cacheRequest, response.clone()));
      return response;
    }

    // ── Transform: route to native WASM, jsquash AVIF, or CF Images ──
    const useCloudflareImages = backend === "cf-images" && !!env.IMAGES;
    let optimizedBody: ArrayBuffer;
    let outputMime: string;

    if (useCloudflareImages && env.IMAGES) {
      // Explicit cf-images backend: every format goes through CF Images.
      const cfFormat = outputFormat === "avif" ? "avif" : outputFormat === "png" ? "png" : outputFormat === "webp" ? "webp" : "jpeg";
      const cfQuality = outputFormat === "avif" ? Math.max(quality - 20, 1) : quality;
      const result = await env.IMAGES
        .input(sourceBytes)
        .transform(width > 0 ? { width } : {})
        .output({ format: cfFormat, quality: cfQuality });
      const cfResponse = await result.response();
      optimizedBody = await cfResponse.arrayBuffer();
      outputMime = FORMAT_MIME[outputFormat];
    } else if (outputFormat === "avif") {
      // Native AVIF: WASM decodes + resizes to RGBA, jsquash encodes the
      // tile-based AV1 bitstream. No CF Images dependency, no per-transform fee.
      const slot = hashSlot(imageUrl, 8);
      const doId = env.IMAGE_DO.idFromName(`img-slot-${slot}`);
      const doHandle = env.IMAGE_DO.get(doId);

      const rawResponse = await doHandle.fetch("https://edgesharp.internal/transform", {
        method: "POST",
        body: sourceBytes,
        headers: {
          "X-Target-Width": String(width),
          "X-Output-Mode": "rgba",
        },
      });
      if (!rawResponse.ok) {
        return new Response(sourceBytes, {
          headers: { "Content-Type": contentType, ...SECURITY_HEADERS },
        });
      }
      const rawBuf = new Uint8Array(await rawResponse.arrayBuffer());
      const rgbaWidth = parseInt(rawResponse.headers.get("X-Image-Width") ?? "0", 10);
      const rgbaHeight = parseInt(rawResponse.headers.get("X-Image-Height") ?? "0", 10);
      const rgba = rawBuf.subarray(8); // skip [w,h] header

      // libavif is statically imported but lazily instantiated — the WASM
      // module sits idle in memory until the first AVIF request hits this branch.
      const avifEncoder = createAvifEncoder(env);
      const avifBytes = await avifEncoder(rgba, rgbaWidth, rgbaHeight, quality);
      optimizedBody = avifBytes;
      outputMime = "image/avif";
    } else {
      // Default: free transform via Durable Object → WASM JPEG / PNG / WebP
      const wasmFormat = FORMAT_WASM_CODE[outputFormat] ?? 0;
      const slot = hashSlot(imageUrl, 8);
      const doId = env.IMAGE_DO.idFromName(`img-slot-${slot}`);
      const doHandle = env.IMAGE_DO.get(doId);

      const transformResponse = await doHandle.fetch("https://edgesharp.internal/transform", {
        method: "POST",
        body: sourceBytes,
        headers: {
          "X-Target-Width": String(width),
          "X-Output-Format": String(wasmFormat),
          "X-Quality": String(quality),
        },
      });

      if (!transformResponse.ok) {
        return new Response(sourceBytes, {
          headers: { "Content-Type": contentType, ...SECURITY_HEADERS },
        });
      }

      optimizedBody = await transformResponse.arrayBuffer();
      outputMime = FORMAT_MIME[outputFormat];
    }

    // ── Cache and return ──
    ctx.waitUntil(env.CACHE_BUCKET.put(r2Key, optimizedBody));

    const response = new Response(optimizedBody, {
      headers: {
        "Content-Type": outputMime,
        ETag: etag,
        ...SECURITY_HEADERS,
      },
    });

    ctx.waitUntil(cache.put(cacheRequest, response.clone()));
    return response;
  },
};

// ── Backend resolution ──

function resolveBackend(env: Env): ImageBackend {
  const val = (env.IMAGE_BACKEND ?? "auto").toLowerCase();
  if (val === "wasm" || val === "cf-images") return val;
  return "auto";
}

/**
 * Negotiate output format based on Accept header, backend, and CF Images availability.
 *
 * Priority: AVIF > WebP > JPEG (matching Next.js behavior).
 * AVIF is only offered when CF Images is available to encode it.
 * WebP maps to JPEG until libwebp is integrated into the WASM engine.
 */
function negotiateFormat(
  accept: string,
  backend: ImageBackend,
  hasCfImages: boolean,
  enabled: FormatsEnabled,
): OutputFormat {
  if (backend === "cf-images" && hasCfImages) {
    // Explicit cf-images backend: route through CF Images, still honoring
    // the per-format kill switches so users can keep CF Images on for
    // some formats while disabling others.
    if (enabled.avif && accept.includes("image/avif")) return "avif";
    if (enabled.webp && accept.includes("image/webp")) return "webp";
    if (enabled.png && accept.includes("image/png") && !accept.includes("image/jpeg")) return "png";
    return "jpeg";
  }

  // auto / wasm: AVIF > WebP > PNG > JPEG, dropping any format the user
  // disabled via ENABLE_* env var.
  if (backend === "auto" && enabled.avif && accept.includes("image/avif")) return "avif";
  if (enabled.webp && accept.includes("image/webp")) return "webp";
  if (enabled.png && accept.includes("image/png") && !accept.includes("image/jpeg")) return "png";
  return "jpeg";
}

// ── Parameter validation (matches Next.js behavior) ──

type ParseResult =
  | { ok: true; imageUrl: string; width: number; quality: number }
  | { ok: false; error: string };

function parseImageParams(params: URLSearchParams, env: Env): ParseResult {
  const urlParam = params.get("url");
  if (!urlParam) return { ok: false, error: "Missing 'url' parameter" };
  if (urlParam.length > MAX_URL_LENGTH) return { ok: false, error: "URL too long" };

  if (urlParam.startsWith("//") || urlParam.startsWith("/\\")) {
    return { ok: false, error: "Protocol-relative URLs not allowed" };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(urlParam)) {
    let parsed: URL;
    try {
      parsed = new URL(urlParam);
    } catch {
      return { ok: false, error: "Invalid URL" };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, error: "Only https:// absolute URLs allowed" };
    }
  } else if (!urlParam.startsWith("/")) {
    return { ok: false, error: "URL must be path-relative or an https:// URL" };
  }

  const wParam = params.get("w") ?? "0";
  if (!/^\d+$/.test(wParam)) return { ok: false, error: "Width must be numeric" };
  const baseWidth = parseInt(wParam, 10);
  if (baseWidth > 0 && !ALLOWED_WIDTHS.has(baseWidth)) {
    return { ok: false, error: `Width ${baseWidth} not in allowed sizes` };
  }

  // DPR multiplier (1, 2, 3) — lets HiDPI clients request density-correct variants
  // without changing loader logic. The post-DPR width still has to fit MAX_WIDTH.
  const dprParam = params.get("dpr") ?? "1";
  if (!/^[1-3]$/.test(dprParam)) return { ok: false, error: "DPR must be 1, 2, or 3" };
  const dpr = parseInt(dprParam, 10);
  const width = Math.min(baseWidth * dpr, MAX_WIDTH);
  if (width > MAX_WIDTH) return { ok: false, error: `Width exceeds maximum (${MAX_WIDTH})` };

  const qParam = params.get("q") ?? "75";
  if (!/^\d+$/.test(qParam)) return { ok: false, error: "Quality must be numeric" };
  const requestedQuality = parseInt(qParam, 10);
  if (requestedQuality < 1 || requestedQuality > 100) return { ok: false, error: "Quality must be 1-100" };

  // Silently cap to MAX_QUALITY if set. We don't reject — the loader's
  // emitted srcSet is generated client-side, and rejecting valid q values
  // would make production deployments fragile. Capping is the friendly path.
  const maxQ = parseMaxQuality(env);
  const quality = Math.min(requestedQuality, maxQ);

  return { ok: true, imageUrl: urlParam, width, quality };
}

function parseMaxQuality(env: Env): number {
  if (!env.MAX_QUALITY) return 100;
  const n = parseInt(env.MAX_QUALITY, 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) return 100;
  return n;
}

/**
 * Caller allowlist — checks the request's Referer (and falls back to Origin)
 * against ALLOWED_REFERERS. Returns true when the caller is allowed.
 *
 * Behaviour:
 *   - ALLOWED_REFERERS unset → always allowed (demo / open Worker)
 *   - Same-origin request (the demo calling its own /_next/image) → allowed
 *   - Referer/Origin host matches an entry → allowed
 *   - No usable Referer/Origin → rejected (strict; sites with strict
 *     Referrer-Policy can either set Referrer-Policy: same-origin, or leave
 *     ALLOWED_REFERERS unset)
 */
function isCallerAllowed(request: Request, env: Env, workerUrl: URL): boolean {
  if (!env.ALLOWED_REFERERS) return true;

  const allowed = env.ALLOWED_REFERERS.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;

  const referer = request.headers.get("Referer") ?? request.headers.get("Origin");
  if (!referer) return false;

  let parsed: URL;
  try {
    parsed = new URL(referer);
  } catch {
    return false;
  }

  // Same-origin: the bundled demo's <Image> components call /_next/image on
  // this very Worker. Always allow that path so the demo isn't broken by a
  // strict ALLOWED_REFERERS on the production deploy.
  if (parsed.origin === workerUrl.origin) return true;

  for (const a of allowed) {
    let allowedUrl: URL;
    try {
      allowedUrl = new URL(a);
      if (parsed.origin === allowedUrl.origin) return true;
    } catch {
      if (parsed.hostname === a) return true;
    }
  }
  return false;
}

function getAllowedOrigins(env: Env): string[] {
  const origins: string[] = [];
  if (env.ORIGIN) origins.push(env.ORIGIN);
  if (env.ALLOWED_ORIGINS) {
    origins.push(...env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()));
  }
  return origins.filter(Boolean);
}

/**
 * Detect animation in GIF and WebP source bytes. Animated content can't be
 * re-encoded without losing the animation, so we passthrough the source bytes
 * and skip the transform.
 *
 * GIF: an animated GIF has at least one Graphics Control Extension (0x21
 * 0xF9) with a Delay Time field in addition to the first frame. Cheaper
 * detection: scan past the first image-descriptor block (0x2C) for a second
 * one — if present, the file has multiple frames.
 *
 * WebP: an animated WebP has a VP8X chunk (offset 12-15 = "VP8X") with the
 * animation flag set in the feature byte (offset 20, bit 1).
 */
function isAnimated(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/gif") return isAnimatedGif(bytes);
  if (contentType === "image/webp") return isAnimatedWebp(bytes);
  return false;
}

function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13) return false;
  // GIF87a / GIF89a header check
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return false;

  // Skip 13-byte header. If a Global Color Table is present, skip its bytes.
  let i = 13;
  const packed = bytes[10] ?? 0;
  if (packed & 0x80) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    i += gctSize;
  }

  let frameCount = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x2C) {
      // Image descriptor — counts as a frame.
      frameCount++;
      if (frameCount > 1) return true;
      // Skip the 9-byte descriptor + optional local color table + image data.
      i += 10;
      const localPacked = bytes[i - 1] ?? 0;
      if (localPacked & 0x80) {
        i += 3 * (1 << ((localPacked & 0x07) + 1));
      }
      // Image data is a series of sub-blocks; skip the LZW min-code-size byte.
      i += 1;
      while (i < bytes.length) {
        const subSize = bytes[i] ?? 0;
        i += 1 + subSize;
        if (subSize === 0) break;
      }
    } else if (b === 0x21) {
      // Extension — skip label + sub-blocks.
      i += 2;
      while (i < bytes.length) {
        const subSize = bytes[i] ?? 0;
        i += 1 + subSize;
        if (subSize === 0) break;
      }
    } else if (b === 0x3B) {
      // Trailer — end of file.
      break;
    } else {
      // Unrecognized byte — bail rather than parse forever.
      break;
    }
  }
  return false;
}

function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 21) return false;
  // RIFF....WEBP
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return false;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) return false;
  // Look for VP8X chunk at offset 12 with animation flag.
  if (bytes[12] !== 0x56 || bytes[13] !== 0x50 || bytes[14] !== 0x38 || bytes[15] !== 0x58) return false;
  // Feature byte at offset 20, animation flag = bit 1 (0x02).
  return ((bytes[20] ?? 0) & 0x02) !== 0;
}

/**
 * Resolve an image URL to fetch from.
 *   - Path-relative ("/foo.jpg") → prepend the configured ORIGIN
 *   - Absolute https URL → must match an entry in ALLOWED_ORIGINS by full
 *     origin (https://host[:port]) or by hostname alone
 * Returns null if no allowlist match.
 */
type ResolvedOrigin =
  | { ok: true; url: string }
  | { ok: false; reason: "no-origin" | "bad-url" | "host-not-allowed"; host?: string };

function resolveOriginUrl(imageUrl: string, origins: string[]): ResolvedOrigin {
  if (imageUrl.startsWith("/")) {
    if (origins.length === 0) return { ok: false, reason: "no-origin" };
    return { ok: true, url: origins[0].replace(/\/$/, "") + imageUrl };
  }

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return { ok: false, reason: "bad-url" };
  }

  for (const o of origins) {
    if (o === "*") return { ok: true, url: imageUrl };
    let allowed: URL;
    try {
      allowed = new URL(o);
      if (parsed.origin === allowed.origin) return { ok: true, url: imageUrl };
    } catch {
      if (parsed.hostname === o) return { ok: true, url: imageUrl };
    }
  }
  return { ok: false, reason: "host-not-allowed", host: parsed.hostname };
}

function buildCacheKey(
  workerOrigin: string,
  imagePath: string,
  width: number,
  quality: number,
  format: string,
): string {
  return `${workerOrigin}/cache/${encodeURIComponent(imagePath)}/w${width}_q${quality}.${format}`;
}

function hashSlot(key: string, poolSize: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % poolSize;
}

/**
 * Strong validator for the rendered output. Deterministic from the cache
 * key — same params always yield the same etag, so 304 Not Modified can
 * skip the body on revalidation.
 */
function buildEtag(
  imagePath: string,
  width: number,
  quality: number,
  format: string,
): string {
  let h1 = 0x811c9dc5; // 32-bit FNV-1a, two-channel for better dispersion
  let h2 = 0x01000193;
  const s = `${imagePath}|${width}|${quality}|${format}`;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
