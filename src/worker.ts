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
  // Caller allowlist, comma-separated list of origins/hostnames allowed to
  // call this Worker (matched against the request's Referer header). Unset =
  // anyone can call (demo behavior). Production should set this to your site's
  // origin(s) so the Worker isn't a free image CDN for anyone who guesses the URL.
  ALLOWED_REFERERS?: string;
  // Hard cap on the `?q=` parameter (1-100). Default 100 = no cap. Set to e.g.
  // 85 to silently clamp expensive q=100 requests, saves CPU and bandwidth.
  MAX_QUALITY?: string;
  IMAGE_BACKEND?: string; // "auto" | "wasm" | "cf-images"
  // Comma-separated list of formats to drop. Empty / unset = every format
  // enabled. Recognized values: jpeg, png, webp, avif, gif, svg.
  //
  // For *transformed* outputs (jpeg/png/webp/avif), disabling means the
  // negotiator falls back to the next-best format the browser accepts.
  // If every format the browser accepts is disabled, the Worker returns 415.
  //
  // For *passthrough* inputs (gif / svg), disabling means the Worker rejects
  // those source types with 415 instead of returning the bytes unchanged.
  //
  // Examples:
  //   DISABLED_FORMATS="avif"       drop AVIF (typical; AVIF encode is
  //                                  ~3-4× more CPU than WebP)
  //   DISABLED_FORMATS="svg,gif"    refuse SVG and animated GIF inputs
  //   DISABLED_FORMATS="avif,webp"  JPEG-only output
  DISABLED_FORMATS?: string;
  IMAGES?: CloudflareImagesBinding; // optional CF Images binding
  ASSETS?: Fetcher; // bundled static assets (demo HTML + sample images)
}

interface FormatsEnabled {
  jpeg: boolean;
  png: boolean;
  webp: boolean;
  avif: boolean;
  gif: boolean;
  svg: boolean;
}

function readFormatsEnabled(env: Env): FormatsEnabled {
  const disabled = new Set(
    (env.DISABLED_FORMATS ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return {
    jpeg: !disabled.has("jpeg"),
    png: !disabled.has("png"),
    webp: !disabled.has("webp"),
    avif: !disabled.has("avif"),
    gif: !disabled.has("gif"),
    svg: !disabled.has("svg"),
  };
}

// Next.js default sizes
const DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];
const ALLOWED_WIDTHS = new Set([...DEVICE_SIZES, ...IMAGE_SIZES, 0]);
const MAX_URL_LENGTH = 3072;
const MAX_WIDTH = 3840;
// Reject sources larger than this BEFORE reading the body. Worker isolate
// memory is 128 MB; a 4000×4000 RGBA buffer alone is 64 MB, so anything
// above ~25 MB compressed is almost certainly going to OOM during decode.
// Picked 25 MB to comfortably cover real 4K photos at high quality (~10 MB
// is typical) while rejecting 50 MB+ DSLR exports that would crash decode.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

// Fallback target width when the requested width can't be resized inside the
// WASM heap budget. Lanczos3 holds the decoded source RGBA AND the resize
// destination simultaneously — for a 4000×3000 source resizing to 3840×2880,
// peak is ~92 MB which collides with libavif's working set. Retrying at
// 2048 keeps peak under ~60 MB and almost always succeeds. Picked to match
// Next.js's default deviceSizes (2048 is the second-largest emitted width).
const SAFE_RESIZE_WIDTH = 2048;

// 67-byte 1×1 transparent PNG. Used as the fallback response when a transform
// fails or a source is rejected pre-flight. Browsers render it as an empty
// box, the page layout doesn't shift, and we don't ship multi-MB source bytes
// just because we couldn't optimize them. We log via console.error so the
// failure shows up in Workers Logs for investigation.
const TRANSPARENT_PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

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

    // Caller allowlist, only enforced when ALLOWED_REFERERS is set. The
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
    if (outputFormat === null) {
      return new Response(
        "No supported output format, every format the client accepts is in DISABLED_FORMATS",
        { status: 415 },
      );
    }

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
    //
    // Set a real User-Agent and an Accept: image/* header. Wikimedia
    // Commons, some Cloudinary buckets, and a few CDN-style hosts return
    // 4xx for empty/unrecognized UAs. Without these, perfectly valid image
    // URLs fail with origin-level 404/403 even though they work in any
    // browser.
    const originResponse = env.ASSETS && imageUrl.startsWith("/demo/")
      ? await env.ASSETS.fetch(new Request(`${url.origin}${imageUrl}`))
      : await fetch(originUrl, {
          headers: {
            "User-Agent": "edgesharp/1 (+https://github.com/teamchong/edgesharp)",
            Accept: "image/*",
          },
        });
    if (!originResponse.ok) {
      return new Response(`Origin returned ${originResponse.status}`, { status: 404 });
    }

    const contentType = (originResponse.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (!SAFE_IMAGE_TYPES.has(contentType)) {
      return new Response("Unsupported image type: " + contentType, { status: 400 });
    }

    // Pre-flight size check. Content-Length is advisory (origin can lie or
    // omit it) but when it's present we can reject obvious abuse cases without
    // reading the body. Saves the OOM failure mode for sources we know upfront
    // are too large to decode safely.
    const sizeHeader = originResponse.headers.get("Content-Length");
    if (sizeHeader) {
      const sizeBytes = parseInt(sizeHeader, 10);
      if (Number.isFinite(sizeBytes) && sizeBytes > MAX_SOURCE_BYTES) {
        return fallbackPixel(`source-too-large:${sizeBytes}`, imageUrl, etag);
      }
    }

    const sourceBytes = new Uint8Array(await originResponse.arrayBuffer());

    // Some origins serve binary files without Content-Length; catch those here
    // after the body's already in memory but before we hand multi-MB buffers
    // to the WASM decoder.
    if (sourceBytes.byteLength > MAX_SOURCE_BYTES) {
      return fallbackPixel(`source-too-large:${sourceBytes.byteLength}`, imageUrl, etag);
    }

    // ── Passthrough paths (no transform) ──
    // SVG is vector and animated images would lose their animation if we
    // re-encoded a single frame. Return the source bytes with the original
    // Content-Type and the standard security headers (script-src 'none' +
    // sandbox neutralize any embedded SVG scripts the same way Next.js's
    // own loader does).
    const isSvg = contentType === "image/svg+xml";
    const animated = isAnimated(sourceBytes, contentType);
    const animatedKind = animated ? (contentType === "image/gif" ? "gif" : "webp") : null;

    if (isSvg && !enabled.svg) {
      return new Response("SVG passthrough disabled", { status: 415 });
    }
    if (animatedKind === "gif" && !enabled.gif) {
      return new Response("Animated GIF passthrough disabled", { status: 415 });
    }
    if (animatedKind === "webp" && !enabled.webp) {
      return new Response("Animated WebP passthrough disabled", { status: 415 });
    }

    if (isSvg || animated) {
      const response = new Response(sourceBytes, {
        headers: {
          "Content-Type": contentType,
          ETag: etag,
          ...SECURITY_HEADERS,
        },
      });
      // Cache passthrough at L1 only, the R2 key includes the negotiated
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
      //
      // Failure chain:
      //   1) requested width
      //   2) SAFE_RESIZE_WIDTH retry if the WASM heap couldn't hold the resize
      //      destination (a 4000×3000 source at w=3840 peaks ~92 MB)
      //   3) source passthrough (the original bytes) — page renders, slow load,
      //      better than a blank tile.
      // Each step wrapped in try/catch because the DO can throw (not just
      // return 500) when a WASM allocation fails hard, and an uncaught throw
      // bubbles up as a Cloudflare-level Internal Error — which the user sees
      // as a broken page with no diagnostic.
      const slot = hashSlot(imageUrl, 16);
      const doId = env.IMAGE_DO.idFromName(`img-slot-${slot}`);
      const doHandle = env.IMAGE_DO.get(doId);

      const tryDoRgba = async (w: number): Promise<Response | null> => {
        try {
          return await doHandle.fetch("https://edgesharp.internal/transform", {
            method: "POST",
            body: sourceBytes,
            headers: { "X-Target-Width": String(w), "X-Output-Mode": "rgba" },
          });
        } catch (err) {
          console.error(`edgesharp avif do-throw url=${JSON.stringify(imageUrl)} w=${w} err=${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      };

      let rawResponse = await tryDoRgba(width);
      if ((!rawResponse || !rawResponse.ok) && width > SAFE_RESIZE_WIDTH) {
        const reason = rawResponse ? `${rawResponse.status}` : "throw";
        console.error(`edgesharp avif retry url=${JSON.stringify(imageUrl)} from=${width} to=${SAFE_RESIZE_WIDTH} reason=${reason}`);
        rawResponse = await tryDoRgba(SAFE_RESIZE_WIDTH);
      }
      if (!rawResponse || !rawResponse.ok) {
        const reason = rawResponse ? `${rawResponse.status}` : "throw";
        return passthroughOnFailure(sourceBytes, contentType, etag, ctx, cache, cacheRequest, `avif-decode:${reason}`, imageUrl);
      }

      const rawBuf = new Uint8Array(await rawResponse.arrayBuffer());
      const rgbaWidth = parseInt(rawResponse.headers.get("X-Image-Width") ?? "0", 10);
      const rgbaHeight = parseInt(rawResponse.headers.get("X-Image-Height") ?? "0", 10);
      const rgba = rawBuf.subarray(8); // skip [w,h] header

      // libavif is statically imported but lazily instantiated, the WASM
      // module sits idle in memory until the first AVIF request hits this branch.
      try {
        const avifEncoder = createAvifEncoder(env);
        const avifBytes = await avifEncoder(rgba, rgbaWidth, rgbaHeight, quality);
        optimizedBody = avifBytes;
        outputMime = "image/avif";
      } catch (err) {
        console.error(`edgesharp avif encode-throw url=${JSON.stringify(imageUrl)} err=${err instanceof Error ? err.message : String(err)}`);
        return passthroughOnFailure(sourceBytes, contentType, etag, ctx, cache, cacheRequest, `avif-encode:throw`, imageUrl);
      }
    } else {
      // Default: free transform via Durable Object → WASM JPEG / PNG / WebP
      const wasmFormat = FORMAT_WASM_CODE[outputFormat] ?? 0;
      const slot = hashSlot(imageUrl, 16);
      const doId = env.IMAGE_DO.idFromName(`img-slot-${slot}`);
      const doHandle = env.IMAGE_DO.get(doId);

      const tryDoEncoded = async (w: number): Promise<Response | null> => {
        try {
          return await doHandle.fetch("https://edgesharp.internal/transform", {
            method: "POST",
            body: sourceBytes,
            headers: {
              "X-Target-Width": String(w),
              "X-Output-Format": String(wasmFormat),
              "X-Quality": String(quality),
            },
          });
        } catch (err) {
          console.error(`edgesharp wasm do-throw url=${JSON.stringify(imageUrl)} format=${outputFormat} w=${w} err=${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      };

      let transformResponse = await tryDoEncoded(width);
      if ((!transformResponse || !transformResponse.ok) && width > SAFE_RESIZE_WIDTH) {
        const reason = transformResponse ? `${transformResponse.status}` : "throw";
        console.error(`edgesharp wasm retry url=${JSON.stringify(imageUrl)} format=${outputFormat} from=${width} to=${SAFE_RESIZE_WIDTH} reason=${reason}`);
        transformResponse = await tryDoEncoded(SAFE_RESIZE_WIDTH);
      }

      if (!transformResponse || !transformResponse.ok) {
        const reason = transformResponse ? `${transformResponse.status}` : "throw";
        return passthroughOnFailure(sourceBytes, contentType, etag, ctx, cache, cacheRequest, `wasm-transform:${reason}`, imageUrl);
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
 * Negotiate output format based on Accept header, backend, and the operator's
 * DISABLED_FORMATS list. Returns null if every format the browser accepts is
 * disabled (caller should respond 415).
 *
 * Preference order: AVIF > WebP > PNG > JPEG. Each candidate is skipped if the
 * operator disabled it; the negotiator falls back to the next-best.
 */
function negotiateFormat(
  accept: string,
  backend: ImageBackend,
  hasCfImages: boolean,
  enabled: FormatsEnabled,
): OutputFormat | null {
  if (backend === "cf-images" && hasCfImages) {
    if (enabled.avif && accept.includes("image/avif")) return "avif";
    if (enabled.webp && accept.includes("image/webp")) return "webp";
    if (enabled.png && accept.includes("image/png") && !accept.includes("image/jpeg")) return "png";
    if (enabled.jpeg) return "jpeg";
    return null;
  }

  if (backend === "auto" && enabled.avif && accept.includes("image/avif")) return "avif";
  if (enabled.webp && accept.includes("image/webp")) return "webp";
  if (enabled.png && accept.includes("image/png") && !accept.includes("image/jpeg")) return "png";
  if (enabled.jpeg) return "jpeg";
  return null;
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

  // DPR multiplier (1, 2, 3), lets HiDPI clients request density-correct variants
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

  // Silently cap to MAX_QUALITY if set. We don't reject, the loader's
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
 * Caller allowlist, checks the request's Referer (and falls back to Origin)
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
 * one, if present, the file has multiple frames.
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
      // Image descriptor, counts as a frame.
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
      // Extension, skip label + sub-blocks.
      i += 2;
      while (i < bytes.length) {
        const subSize = bytes[i] ?? 0;
        i += 1 + subSize;
        if (subSize === 0) break;
      }
    } else if (b === 0x3B) {
      // Trailer, end of file.
      break;
    } else {
      // Unrecognized byte, bail rather than parse forever.
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

/**
 * Fallback response when a transform fails or a source is rejected pre-flight.
 * Returns a 1×1 transparent PNG. Used only when we don't have source bytes to
 * fall back to (e.g., the pre-flight Content-Length check rejects a source
 * before we read its body). Browsers render it as an empty box, page layout
 * doesn't shift, and the failure shows up in Workers Logs via console.error.
 *
 * Short Cache-Control (60s) so transient failures retry on the next cold
 * request rather than getting baked into R2 forever.
 */
function fallbackPixel(reason: string, sourceUrl: string, etag: string): Response {
  console.error(`edgesharp transform-fail url=${JSON.stringify(sourceUrl)} reason=${reason}`);
  return new Response(TRANSPARENT_PNG_1X1, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=60",
      ETag: etag,
      "X-Edgesharp-Fallback": reason,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Last-resort fallback for transform failures: serve the original source bytes
 * with the original Content-Type. Slower page load than an optimized output,
 * but the image renders. Strictly better UX than a 1×1 pixel for users who
 * can see a broken playground but can't tell why. Logged as an edgesharp
 * fault so the failure stays visible in Workers Logs.
 *
 * Cache the passthrough at L1 (Cache API) only, with short TTL: the R2 key
 * encodes the negotiated output format, which won't match the source's
 * actual Content-Type, and we want failed transforms to be retried later.
 */
function passthroughOnFailure(
  sourceBytes: Uint8Array,
  contentType: string,
  etag: string,
  ctx: ExecutionContext,
  cache: Cache,
  cacheRequest: Request,
  reason: string,
  sourceUrl: string,
): Response {
  console.error(`edgesharp transform-fail url=${JSON.stringify(sourceUrl)} reason=${reason} fallback=passthrough bytes=${sourceBytes.byteLength}`);
  const response = new Response(sourceBytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=60",
      ETag: etag,
      "X-Edgesharp-Fallback": reason,
      "X-Content-Type-Options": "nosniff",
    },
  });
  ctx.waitUntil(cache.put(cacheRequest, response.clone()));
  return response;
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
 * key, same params always yield the same etag, so 304 Not Modified can
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
