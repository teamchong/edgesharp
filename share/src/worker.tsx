/**
 * edgesharp-share Worker entry.
 *
 * Generates social share cards (OpenGraph, Twitter, etc.) from a source URL.
 *
 *   GET /card?url=<source>&p=<platform>&template=<name>&[overrides]
 *
 * Flow:
 *   1. Validate the source URL against ALLOWED_ORIGINS, reject loops back to
 *      this Worker.
 *   2. Cache lookup (Cache API → R2). Hit returns immediately.
 *   3. Fetch the source URL, parse <head> metadata.
 *   4. Render JSX template via Satori, rasterize to PNG via Resvg.
 *   5. Write to R2 + Cache API, return the PNG.
 */

import { extractMetadata, emptyMetadata, type PageMetadata } from "./metadata.js";
import { resolvePlatform } from "./platforms.js";
import { resolveTemplate } from "./templates/registry.js";
import { renderCard } from "./render.js";

interface Env {
  CACHE_BUCKET: R2Bucket;
  ALLOWED_ORIGINS?: string;
  DEFAULT_ACCENT?: string;
  DEFAULT_BG?: string;
  DEFAULT_FG?: string;
  SITE_NAME?: string;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const FETCH_USER_AGENT =
  "edgesharp-share/1 (+https://github.com/teamchong/edgesharp)";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "script-src 'none'; frame-src 'none'; sandbox;",
  // Allow the playground demo (and any other site) to fetch the rendered
  // PNG via JavaScript. The output is identical to what an `<img>` tag
  // would receive, so opening it to JS adds no attack surface.
  "Access-Control-Allow-Origin": "*",
} as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/card" || url.pathname === "/og") {
      return handleCard(request, env, ctx, url);
    }
    return new Response("Not Found", { status: 404 });
  },
};

async function handleCard(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const sourceUrlParam = url.searchParams.get("url");
  if (!sourceUrlParam) {
    return new Response("Missing 'url' parameter", { status: 400 });
  }
  if (sourceUrlParam.length > MAX_URL_LENGTH) {
    return new Response("URL too long", { status: 400 });
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceUrlParam);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }
  if (sourceUrl.protocol !== "https:") {
    return new Response("Only https:// source URLs allowed", { status: 400 });
  }
  if (sourceUrl.hostname === url.hostname) {
    return new Response("Cannot fetch from this Worker's own hostname", { status: 400 });
  }
  if (!isOriginAllowed(env, sourceUrl)) {
    return new Response(
      `Host '${sourceUrl.hostname}' not in ALLOWED_ORIGINS`,
      { status: 403 },
    );
  }

  const platform = resolvePlatform(url.searchParams.get("p"));
  const templateFn = resolveTemplate(url.searchParams.get("template"));
  const overrides = readOverrides(url.searchParams);

  const cacheKey = buildCacheKey(
    url.origin,
    sourceUrlParam,
    url.searchParams.get("p") ?? "og",
    url.searchParams.get("template") ?? "default",
    overrides,
  );
  const etag = `"${fnv1a(cacheKey)}"`;

  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "public, max-age=31536000, immutable" },
    });
  }

  const cache = caches.default;
  const cacheRequest = new Request(cacheKey);
  const cached = await cache.match(cacheRequest);
  if (cached) return cached;

  const r2Key = `v1/${encodeURIComponent(cacheKey)}.png`;
  const r2Object = await env.CACHE_BUCKET.get(r2Key);
  if (r2Object) {
    const response = new Response(r2Object.body, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: etag,
        ...SECURITY_HEADERS,
      },
    });
    ctx.waitUntil(cache.put(cacheRequest, response.clone()));
    return response;
  }

  const metadata = await fetchPageMetadata(sourceUrl);
  const props = mergeProps(metadata, sourceUrl, overrides, env);

  const result = await renderCard(templateFn(props), {
    width: platform.width,
    height: platform.height,
  });

  ctx.waitUntil(env.CACHE_BUCKET.put(r2Key, result.bytes));

  const response = new Response(result.bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
      ...SECURITY_HEADERS,
    },
  });
  ctx.waitUntil(cache.put(cacheRequest, response.clone()));
  return response;
}

interface Overrides {
  title: string | null;
  description: string | null;
  accent: string | null;
  background: string | null;
  foreground: string | null;
  siteName: string | null;
}

function readOverrides(params: URLSearchParams): Overrides {
  return {
    title: params.get("title"),
    description: params.get("description") ?? params.get("desc"),
    accent: params.get("accent"),
    background: params.get("bg"),
    foreground: params.get("fg"),
    siteName: params.get("site"),
  };
}

function mergeProps(
  metadata: PageMetadata,
  sourceUrl: URL,
  overrides: Overrides,
  env: Env,
) {
  const title = overrides.title ?? metadata.title ?? sourceUrl.hostname;
  const description = overrides.description ?? metadata.description ?? "";
  const siteName =
    overrides.siteName ?? metadata.siteName ?? env.SITE_NAME ?? sourceUrl.hostname;
  const accent = overrides.accent ?? env.DEFAULT_ACCENT ?? "#ff6600";
  const background = overrides.background ?? env.DEFAULT_BG ?? "#0a0a0a";
  const foreground = overrides.foreground ?? env.DEFAULT_FG ?? "#fafafa";
  return { title, description, siteName, accent, background, foreground };
}

async function fetchPageMetadata(sourceUrl: URL): Promise<PageMetadata> {
  try {
    const response = await fetch(sourceUrl.toString(), {
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        Accept: "text/html",
      },
    });
    if (!response.ok) {
      console.error(
        `edgesharp-share fetch-fail url=${JSON.stringify(sourceUrl.toString())} status=${response.status}`,
      );
      return emptyMetadata();
    }
    const sizeHeader = response.headers.get("Content-Length");
    if (sizeHeader && parseInt(sizeHeader, 10) > MAX_HTML_BYTES) {
      console.error(
        `edgesharp-share fetch-too-large url=${JSON.stringify(sourceUrl.toString())} size=${sizeHeader}`,
      );
      return emptyMetadata();
    }
    const html = await response.text();
    if (html.length > MAX_HTML_BYTES) {
      console.error(
        `edgesharp-share parse-too-large url=${JSON.stringify(sourceUrl.toString())} size=${html.length}`,
      );
      return emptyMetadata();
    }
    return extractMetadata(html);
  } catch (err) {
    console.error(
      `edgesharp-share fetch-throw url=${JSON.stringify(sourceUrl.toString())} err=${err instanceof Error ? err.message : String(err)}`,
    );
    return emptyMetadata();
  }
}

function isOriginAllowed(env: Env, sourceUrl: URL): boolean {
  const allowed = (env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0 || allowed.includes("*")) return true;
  for (const entry of allowed) {
    try {
      const allowedUrl = new URL(entry);
      if (allowedUrl.origin === sourceUrl.origin) return true;
    } catch {
      if (sourceUrl.hostname === entry) return true;
    }
  }
  return false;
}

function buildCacheKey(
  workerOrigin: string,
  sourceUrl: string,
  platform: string,
  template: string,
  overrides: Overrides,
): string {
  const parts = [
    sourceUrl,
    platform,
    template,
    overrides.title ?? "",
    overrides.description ?? "",
    overrides.accent ?? "",
    overrides.background ?? "",
    overrides.foreground ?? "",
    overrides.siteName ?? "",
  ].join("|");
  return `${workerOrigin}/cache/${fnv1a(parts)}`;
}

function fnv1a(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
