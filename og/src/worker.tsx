/**
 * edgesharp-og Worker entry.
 *
 * Generates social share cards from the page that embedded the meta tag.
 *
 *   <meta property="og:image" content="https://share.example.com">
 *   <meta property="og:image" content="https://share.example.com/article.html">
 *
 * Flow:
 *   1. Read the `Referer` header — that's the page that wants a card.
 *   2. Validate Referer's origin against `ALLOWED_ORIGINS` (CSV, supports
 *      `*.example.com` wildcards). Default-deny: empty / unset means the
 *      Worker rejects every request.
 *   3. Cache lookup keyed by (referer URL + platform + template path).
 *      Edge cache (caches.default) self-expires via Cache-Control max-age.
 *      R2 entries live forever — refreshed only via POST /purge (single
 *      page) or POST /refresh (everything from the caller's origin).
 *   4. Fetch the Referer page → parse <head> → build a {{var}} map.
 *   5. Look up the template by URL path (e.g. `/article.html`). Templates
 *      are bundled at build time from `src/templates/`. Path `/` defaults
 *      to the default template.
 *   6. Substitute {{key}} markers, render via Satori → Resvg → PNG.
 *   7. Cache to R2 + Cache API with provenance metadata
 *      (sourceUrl, platform, template, renderTime). Return PNG.
 *
 * Refresh model: total render volume is bounded by the count of edits the
 * user makes, not by request volume or any clock-driven TTL. Cost stays
 * predictable at any traffic scale.
 *
 * Adding a template: drop a `.html` file in `src/templates/`, register it
 * in `src/templates/registry.ts`, push to git. Workers Builds redeploys
 * automatically.
 */

import { extractMetadata, emptyMetadata, type PageMetadata } from "./metadata.js";
import { PLATFORMS, isPlatformKey } from "./platforms.js";
import { resolveTemplate, TEMPLATES } from "./templates/registry.js";
import { renderHtml } from "./render.js";

interface Env {
  CACHE_BUCKET: R2Bucket;
  /**
   * Comma-separated list of allowed Referer origins. Each entry is one of:
   *   `https://example.com`         exact origin (protocol + host)
   *   `example.com`                 exact hostname (any protocol)
   *   `*.example.com`               any subdomain of example.com
   * Default: empty / unset → all requests rejected with 403. Operators
   * must explicitly opt their site(s) in.
   */
  ALLOWED_ORIGINS?: string;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FETCH_USER_AGENT =
  "edgesharp-og/1 (+https://github.com/teamchong/edgesharp)";

// Downstream-facing cache window. Sets the response's Cache-Control
// max-age; controls how long browsers / social-platform crawlers may
// hold the card before revalidating with us. Our own R2 storage no
// longer auto-expires — refresh happens only via POST /purge or
// POST /refresh, so total render volume is bounded by edits, not by
// this TTL.
const CACHE_MAX_AGE_SECONDS = 86400;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "script-src 'none'; frame-src 'none'; sandbox;",
  "Access-Control-Allow-Origin": "*",
} as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight for the demo's POST-with-custom-template editor.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...SECURITY_HEADERS,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "POST"
    ) {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD, POST, OPTIONS" },
      });
    }

    return handleCard(request, env, ctx, url);
  },
};

async function handleCard(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  // ── Referer is the source page ──────────────────────────────────────────
  const refererHeader = request.headers.get("Referer");
  if (!refererHeader) {
    return new Response(
      "Missing Referer header. This Worker uses the Referer to know which page to render a card for; requests without a Referer are blocked.",
      { status: 403 },
    );
  }

  let referer: URL;
  try {
    referer = new URL(refererHeader);
  } catch {
    return new Response("Invalid Referer header", { status: 403 });
  }

  if (referer.protocol !== "http:" && referer.protocol !== "https:") {
    return new Response("Referer must be http or https", { status: 403 });
  }

  if (referer.origin === url.origin) {
    // Loop prevention: refuse to render a card for ourselves. Compare
    // origins (includes port) rather than hostname so local dev with the
    // demo on :8787 calling share on :8788 still works.
    return new Response("Referer cannot be this Worker's own origin", {
      status: 403,
    });
  }

  if (!isOriginAllowed(env, referer)) {
    return new Response(
      `Referer origin '${referer.origin}' not in ALLOWED_ORIGINS`,
      { status: 403 },
    );
  }

  // ── /purge : wipe every (platform × template) variant for this Referer ──
  if (url.pathname === "/purge" || url.pathname === "/purge/") {
    if (request.method !== "POST") {
      return new Response("POST required for /purge", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }
    return handlePurge(env, url, referer);
  }

  // ── /refresh : list R2, purge every card whose source URL matches the ───
  // calling Referer's origin. Bulk equivalent of /purge across the whole
  // bucket. Legacy cards (no customMetadata) are also cleaned up since
  // they're un-targetable orphans after this change shipped.
  if (url.pathname === "/refresh" || url.pathname === "/refresh/") {
    if (request.method !== "POST") {
      return new Response("POST required for /refresh", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }
    return handleRefresh(env, url, referer);
  }

  // ── Parse path: /<platform>/[template-name] ─────────────────────────────
  // /og/                  → platform=og, template=default
  // /og/article.html      → platform=og, template=article.html
  // /x/                   → platform=x (Twitter), template=default
  // /sq/article.html      → platform=sq (square), template=article.html
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    const known = Object.keys(PLATFORMS).map((k) => `/${k}/`).join(", ");
    return new Response(
      `Specify a platform as the first path segment. Known platforms: ${known}`,
      { status: 400 },
    );
  }
  const platformKey = segments[0];
  if (!isPlatformKey(platformKey)) {
    const known = Object.keys(PLATFORMS).map((k) => `/${k}/`).join(", ");
    return new Response(
      `Unknown platform '/${platformKey}/'. Known: ${known}`,
      { status: 404 },
    );
  }
  const platform = PLATFORMS[platformKey];
  const templateName = segments.slice(1).join("/");

  // POST mode: caller supplies the template HTML in the request body.
  // Used by the demo editor for previewing custom templates without
  // committing them to the fork. Same Referer + ALLOWED_ORIGINS check
  // applies. POST renders never cache (each preview is one-shot, the
  // user is iterating).
  let templateHtml: string | null = null;
  let isCustomTemplate = false;
  if (request.method === "POST") {
    const body = await request.text();
    if (body.length === 0) {
      return new Response("POST body must contain template HTML", { status: 400 });
    }
    if (body.length > MAX_HTML_BYTES) {
      return new Response("Template body too large", { status: 413 });
    }
    templateHtml = body;
    isCustomTemplate = true;
  } else {
    templateHtml = resolveTemplate(templateName);
    if (templateHtml === null) {
      return new Response(
        `Unknown template '${templateName || "(default)"}' for /${platformKey}/`,
        { status: 404 },
      );
    }
  }

  // ── Cache lookup ────────────────────────────────────────────────────────
  // Custom (POST) templates skip the cache entirely — each preview is
  // a one-shot render against a body the user is actively iterating on.
  const cacheId = fnv1a(`${referer.toString()}|${platformKey}|${templateName}`);
  const cacheKey = `${url.origin}/cache/${cacheId}`;

  // R2 entries live forever — no auto-expiry. Cards refresh only on
  // explicit POST /purge or POST /refresh. ETag includes the render
  // timestamp from R2 customMetadata so the same input-hash with new
  // content (after purge → re-render) gets a fresh ETag — no stale
  // 304 served via downstream caches.
  if (!isCustomTemplate) {
    const cache = caches.default;
    const cacheRequest = new Request(cacheKey);
    const cached = await cache.match(cacheRequest);
    if (cached) return cached;

    const r2Key = `cards/${cacheId}.png`;
    const r2Object = await env.CACHE_BUCKET.get(r2Key);
    if (r2Object) {
      const renderTime =
        parseInt(r2Object.customMetadata?.renderTime ?? "", 10) ||
        r2Object.uploaded.getTime();
      const etag = `"${cacheId}-${renderTime.toString(36)}"`;
      const response = new Response(r2Object.body, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
          ETag: etag,
          ...SECURITY_HEADERS,
        },
      });
      ctx.waitUntil(cache.put(cacheRequest, response.clone()));
      return response;
    }
  }

  // ── Fetch Referer page metadata, render, cache ──────────────────────────
  const metadata = await fetchPageMetadata(referer);
  const variables = buildVariables(metadata, referer);
  const populatedHtml = substituteVariables(templateHtml, variables);

  let result;
  try {
    result = await renderHtml(populatedHtml, {
      width: platform.width,
      height: platform.height,
    });
  } catch (err) {
    console.error(
      `edgesharp-og render-fail referer=${JSON.stringify(referer.toString())} platform=${platformKey} template=${templateName || "(default)"} err=${err instanceof Error ? err.message : String(err)}`,
    );
    return new Response("Render failed", { status: 500 });
  }

  if (isCustomTemplate) {
    // Preview render — never cache, never store. Each preview is a one-shot.
    return new Response(result.bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Cache-Control": "no-store, max-age=0",
        ...SECURITY_HEADERS,
      },
    });
  }

  // Stamp render time + provenance so /refresh can target by origin and
  // ETag changes on each re-render (closes the stale-304 gap).
  const renderTime = Date.now();
  const r2Key = `cards/${cacheId}.png`;
  ctx.waitUntil(
    env.CACHE_BUCKET.put(r2Key, result.bytes, {
      customMetadata: {
        sourceUrl: referer.toString(),
        platform: platformKey,
        template: templateName,
        renderTime: String(renderTime),
      },
    }),
  );

  const etag = `"${cacheId}-${renderTime.toString(36)}"`;
  const response = new Response(result.bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
      ETag: etag,
      ...SECURITY_HEADERS,
    },
  });
  const cache = caches.default;
  const cacheRequest = new Request(cacheKey);
  ctx.waitUntil(cache.put(cacheRequest, response.clone()));
  return response;
}

// ─── Purge: delete every cached variant for a given Referer ──────────────

async function handlePurge(
  env: Env,
  url: URL,
  referer: URL,
): Promise<Response> {
  const cache = caches.default;
  const purged: string[] = [];
  const promises: Promise<unknown>[] = [];

  for (const platformKey of Object.keys(PLATFORMS)) {
    for (const templateName of Object.keys(TEMPLATES)) {
      const cacheId = fnv1a(
        `${referer.toString()}|${platformKey}|${templateName}`,
      );
      const r2Key = `cards/${cacheId}.png`;
      const cacheKey = `${url.origin}/cache/${cacheId}`;

      promises.push(env.CACHE_BUCKET.delete(r2Key));
      promises.push(cache.delete(new Request(cacheKey)));

      const path = templateName
        ? `/${platformKey}/${templateName}`
        : `/${platformKey}/`;
      purged.push(path);
    }
  }

  await Promise.all(promises);

  return new Response(
    JSON.stringify(
      {
        purged,
        referer: referer.toString(),
        // caches.default.delete only purges this PoP. R2 is global so the
        // next request anywhere re-renders; other PoPs serve stale from
        // edge cache for up to max-age (24h) then catch up.
        note:
          "R2 entries deleted globally; edge cache deleted at this PoP only — other PoPs catch up within 24h.",
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      },
    },
  );
}

// ─── Refresh: bulk-purge every card matching caller's origin ─────────────

async function handleRefresh(
  env: Env,
  url: URL,
  referer: URL,
): Promise<Response> {
  const cache = caches.default;
  const callingOrigin = referer.origin;
  let cursor: string | undefined;
  let scanned = 0;
  let purgedOwn = 0;
  let purgedOrphan = 0;
  let skippedForeign = 0;

  do {
    const list = await env.CACHE_BUCKET.list({
      prefix: "cards/",
      cursor,
      limit: 1000,
      // R2 list omits customMetadata by default — opt in so we can
      // filter by sourceUrl origin. The `include` field is in the R2
      // runtime API but missing from this version of workers-types.
      include: ["customMetadata"],
    } as R2ListOptions & { include: string[] });

    const promises: Promise<unknown>[] = [];
    for (const obj of list.objects) {
      scanned++;
      const sourceUrl = obj.customMetadata?.sourceUrl;
      const hash = obj.key.replace(/^cards\//, "").replace(/\.png$/, "");
      const cacheKey = `${url.origin}/cache/${hash}`;

      // Legacy cards without metadata: orphans we can't track. Clean up.
      if (!sourceUrl) {
        promises.push(env.CACHE_BUCKET.delete(obj.key));
        promises.push(cache.delete(new Request(cacheKey)));
        purgedOrphan++;
        continue;
      }

      // Origin filter: only delete cards from the caller's own site.
      let matches = false;
      try {
        matches = new URL(sourceUrl).origin === callingOrigin;
      } catch {
        // Garbled metadata — treat as orphan.
        promises.push(env.CACHE_BUCKET.delete(obj.key));
        promises.push(cache.delete(new Request(cacheKey)));
        purgedOrphan++;
        continue;
      }

      if (matches) {
        promises.push(env.CACHE_BUCKET.delete(obj.key));
        promises.push(cache.delete(new Request(cacheKey)));
        purgedOwn++;
      } else {
        skippedForeign++;
      }
    }
    await Promise.all(promises);

    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  return new Response(
    JSON.stringify(
      {
        origin: callingOrigin,
        scanned,
        purged: purgedOwn,
        purgedOrphan,
        skippedForeign,
        note:
          "Cards re-render lazily on next access. R2 is global; edge caches at other PoPs serve stale until max-age expires.",
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      },
    },
  );
}

// ─── Variable substitution ────────────────────────────────────────────────

function substituteVariables(template: string, vars: Record<string, string>): string {
  // Variable keys allow letters, digits, dot, colon, slash, dash, underscore —
  // covers og:title, twitter:title, link:icon, my-key, my_key, etc.
  return template.replace(/\{\{\s*([a-zA-Z0-9_.:\/-]+)\s*\}\}/g, (_, key: string) => {
    return key in vars ? escapeHtml(vars[key]) : "";
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildVariables(
  metadata: PageMetadata,
  referer: URL,
): Record<string, string> {
  const vars: Record<string, string> = { ...metadata.meta };

  // Named convenience fields filled from the canonical resolution chain
  // (og:* → twitter:* → <title>/<meta name=description>).
  if (metadata.title !== null) vars["title"] = metadata.title;
  if (metadata.description !== null) vars["description"] = metadata.description;
  vars["siteName"] = metadata.siteName ?? referer.hostname;
  vars["site"] = vars["siteName"];
  vars["url"] = referer.toString();
  vars["hostname"] = referer.hostname;

  return vars;
}

// ─── Source page fetch ────────────────────────────────────────────────────

async function fetchPageMetadata(referer: URL): Promise<PageMetadata> {
  try {
    const response = await fetch(referer.toString(), {
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        Accept: "text/html",
      },
    });
    if (!response.ok) {
      console.error(
        `edgesharp-og fetch-fail url=${JSON.stringify(referer.toString())} status=${response.status}`,
      );
      return emptyMetadata();
    }
    const sizeHeader = response.headers.get("Content-Length");
    if (sizeHeader && parseInt(sizeHeader, 10) > MAX_HTML_BYTES) {
      return emptyMetadata();
    }
    const html = await response.text();
    if (html.length > MAX_HTML_BYTES) return emptyMetadata();
    return extractMetadata(html);
  } catch (err) {
    console.error(
      `edgesharp-og fetch-throw url=${JSON.stringify(referer.toString())} err=${err instanceof Error ? err.message : String(err)}`,
    );
    return emptyMetadata();
  }
}

// ─── Origin allowlist (CSV with wildcard subdomain support) ──────────────

function isOriginAllowed(env: Env, referer: URL): boolean {
  const raw = (env.ALLOWED_ORIGINS ?? "").trim();
  if (raw.length === 0) return false; // default-deny

  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    if (matchesEntry(entry, referer)) return true;
  }
  return false;
}

function matchesEntry(entry: string, referer: URL): boolean {
  // `*.example.com`: subdomain wildcard. Matches any host whose
  // suffix (after the leftmost label) equals `example.com`.
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(2).toLowerCase();
    const host = referer.hostname.toLowerCase();
    return host !== suffix && host.endsWith("." + suffix);
  }
  // Full origin (https://example.com[:port]).
  if (entry.includes("://")) {
    try {
      const parsed = new URL(entry);
      return parsed.origin === referer.origin;
    } catch {
      return false;
    }
  }
  // Bare hostname.
  return referer.hostname.toLowerCase() === entry.toLowerCase();
}

// ─── Hashing ──────────────────────────────────────────────────────────────

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
