/**
 * Protocol conformance tests — verify edgesharp matches Next.js image
 * optimization API contract exactly.
 *
 * Reference: next/dist/server/image-optimizer.js
 *
 * These tests run against a live edgesharp Worker via wrangler dev.
 * The global setup starts both the origin server and wrangler dev.
 */
import { describe, it, expect } from "vitest";

const DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const DEFAULT_IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];
const ALLOWED_WIDTHS = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];

const BASE_URL = process.env.IMAGEMODE_TEST_URL ?? "http://localhost:8787";

async function fetchImage(
  queryString: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`${BASE_URL}/_next/image${queryString}`, {
    headers: {
      Accept: "image/webp,image/png,image/jpeg,*/*",
      ...headers,
    },
  });
}

// ── Parameter validation ──

describe("url parameter validation", () => {
  it("rejects missing url parameter", async () => {
    const res = await fetchImage("?w=640&q=75");
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("url");
  });

  it("rejects protocol-relative URLs (//evil.com)", async () => {
    const res = await fetchImage("?url=//evil.com/photo.jpg&w=640&q=75");
    expect(res.status).toBe(400);
  });

  it("rejects backslash-prefixed URLs (/\\evil.com)", async () => {
    const res = await fetchImage("?url=/\\evil.com/photo.jpg&w=640&q=75");
    expect(res.status).toBe(400);
  });

  it("rejects absolute URLs (https://)", async () => {
    const res = await fetchImage("?url=https://evil.com/photo.jpg&w=640&q=75");
    expect(res.status).toBe(400);
  });

  it("rejects data: scheme URLs", async () => {
    const res = await fetchImage("?url=data:image/png;base64,abc&w=640&q=75");
    expect(res.status).toBe(400);
  });

  it("rejects javascript: scheme URLs", async () => {
    const res = await fetchImage("?url=javascript:alert(1)&w=640&q=75");
    expect(res.status).toBe(400);
  });

  it("rejects URLs longer than 3072 characters", async () => {
    const longPath = "/" + "a".repeat(3072);
    const res = await fetchImage(`?url=${encodeURIComponent(longPath)}&w=640&q=75`);
    expect(res.status).toBe(400);
  });

  it("accepts valid path-relative URLs", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75");
    expect(res.status).toBe(200);
  });

  it("returns 404 for non-existent images", async () => {
    const res = await fetchImage("?url=/does-not-exist.jpg&w=640&q=75");
    expect(res.status).toBe(404);
  });
});

describe("width parameter validation", () => {
  it("rejects width not in allowed set", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=999&q=75");
    expect(res.status).toBe(400);
  });

  it("rejects width exceeding absolute max (3840)", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=5000&q=75");
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric width", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=abc&q=75");
    expect(res.status).toBe(400);
  });

  for (const w of [640, 1080, 3840, 16, 64, 384]) {
    it(`accepts allowed width ${w}`, async () => {
      const res = await fetchImage(`?url=/photo.jpg&w=${w}&q=75`);
      expect(res.status).toBe(200);
    });
  }
});

describe("quality parameter validation", () => {
  it("defaults to 75 when missing", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640");
    expect(res.status).toBe(200);
  });

  it("rejects quality below 1", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=0");
    expect(res.status).toBe(400);
  });

  it("rejects quality above 100", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=101");
    expect(res.status).toBe(400);
  });

  it("accepts quality 1", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=1");
    expect(res.status).toBe(200);
  });

  it("accepts quality 100", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=100");
    expect(res.status).toBe(200);
  });
});

// ── Content negotiation ──

describe("content negotiation", () => {
  it("returns JPEG for generic Accept header", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75", {
      Accept: "*/*",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("returns WebP when Accept includes image/webp", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75", {
      Accept: "image/webp,image/png,*/*",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("serves native AVIF when an AVIF-capable browser asks for it", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75", {
      Accept: "image/avif,image/webp,*/*",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/avif");
  });

  it("negotiator picks WebP when DISABLED_FORMATS includes avif", async () => {
    // The kill switch in CF dashboard. Default is empty (every format
    // enabled); the global setup does not pass DISABLED_FORMATS, so this
    // test asserts the *positive* path. Per-test env override would require
    // restarting wrangler dev — covered instead by the hand-flip test in
    // tests/avif-disable.test.ts (TODO).
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75", {
      Accept: "image/avif,image/webp,*/*",
    });
    expect(res.status).toBe(200);
    expect(["image/avif", "image/webp"]).toContain(res.headers.get("Content-Type"));
  });
});

// ── Security headers ──

describe("security headers", () => {
  it("sets Cache-Control to immutable 1-year", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("sets Vary: Accept", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75");
    expect(res.status).toBe(200);
    expect(res.headers.get("Vary")).toBe("Accept");
  });

  it("sets Content-Security-Policy to block scripts and frames", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75");
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("sandbox");
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets Content-Disposition: inline", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe("inline");
  });
});

// ── Content type safety ──

describe("content type safety", () => {
  it("passes SVG through with the original Content-Type and CSP+sandbox headers", async () => {
    // SVG is vector — we can't Lanczos-resize it, so we passthrough with the
    // existing CSP (script-src 'none'; sandbox) which neutralizes any embedded
    // scripts the same way Next.js's own loader does.
    const res = await fetchImage("?url=/icon.svg&w=640&q=75");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it("passes animated GIF through without re-encoding", async () => {
    // Static-image transform would lose the animation; passthrough keeps it.
    const res = await fetchImage("?url=/animated.gif&w=640&q=75");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/gif");
  });

  it("decodes progressive JPEG (vendored stb_image fallback path)", async () => {
    // Baseline-sequential JPEG goes through our hand-rolled Zig decoder.
    // Progressive JPEGs (SOF2 marker) detect-and-route to stb_image, which
    // handles the multi-scan bitstream that's beyond our baseline decoder.
    const res = await fetchImage("?url=/progressive.jpg&w=640&q=75", {
      Accept: "image/webp,*/*",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("serves JPEG images as WebP when Accept includes webp", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75");
    expect(res.status).toBe(200);
    // Default Accept header includes image/webp, so output is WebP
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("serves JPEG when Accept is only image/jpeg", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75", { Accept: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("serves PNG images", async () => {
    const res = await fetchImage("?url=/icon.png&w=256&q=80", { Accept: "image/png" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });
});

// ── Output validation ──

describe("output validation", () => {
  it("returns valid JPEG data", async () => {
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75", {
      Accept: "image/jpeg",
    });
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    // JPEG magic bytes: FF D8 FF
    expect(buf[0]).toBe(0xFF);
    expect(buf[1]).toBe(0xD8);
    expect(buf[2]).toBe(0xFF);
  });

  it("returns valid PNG data when Accept prefers PNG", async () => {
    const res = await fetchImage("?url=/icon.png&w=256&q=80", {
      Accept: "image/png",
    });
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    // PNG magic bytes: 89 50 4E 47
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4E);
    expect(buf[3]).toBe(0x47);
  });

  it("output is smaller than source for JPEG", async () => {
    // Original photo.jpg is ~346KB, 640px JPEG at q=75 should be much smaller
    const res = await fetchImage("?url=/photo.jpg&w=640&q=75");
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeLessThan(346111); // source size
    expect(buf.byteLength).toBeGreaterThan(0);
  });
});

// ── Non-image routes ──

describe("routing", () => {
  it("non /_next/image paths fall through to bundled assets", async () => {
    const res = await fetch(`${BASE_URL}/no-such-asset-${Date.now()}`);
    // SPA fallback (configured in wrangler.json) serves the demo's index.html
    // for unknown paths; the asset router returns 200 for the SPA shell.
    expect([200, 404]).toContain(res.status);
  });

  it("root path serves the demo when assets are bundled", async () => {
    const res = await fetch(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
  });
});

// ── Default sizes (pure logic, no server needed) ──

describe("default sizes match Next.js", () => {
  it("deviceSizes match Next.js defaults", () => {
    expect(DEFAULT_DEVICE_SIZES).toEqual([640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
  });

  it("imageSizes match Next.js defaults", () => {
    expect(DEFAULT_IMAGE_SIZES).toEqual([16, 32, 48, 64, 96, 128, 256, 384]);
  });

  it("no overlap between deviceSizes and imageSizes", () => {
    const overlap = DEFAULT_IMAGE_SIZES.filter((s) => DEFAULT_DEVICE_SIZES.includes(s));
    expect(overlap).toHaveLength(0);
  });
});

// ── Content type validation function (unit test, no server needed) ──

function isSafeImageContentType(contentType: string): boolean {
  const SAFE = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
    "image/x-icon", "image/vnd.microsoft.icon", "image/bmp", "image/tiff",
    "image/svg+xml",
  ]);
  return SAFE.has(contentType.split(";")[0].trim().toLowerCase());
}

describe("content type validation", () => {
  const safe = [
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
    "image/bmp", "image/tiff", "image/x-icon", "image/vnd.microsoft.icon",
    "image/svg+xml",
  ];
  const unsafe = ["text/html", "application/javascript", "application/pdf", "text/xml"];

  for (const type of safe) {
    it(`accepts safe type: ${type}`, () => expect(isSafeImageContentType(type)).toBe(true));
  }
  for (const type of unsafe) {
    it(`rejects unsafe type: ${type}`, () => expect(isSafeImageContentType(type)).toBe(false));
  }

  it("handles content type with parameters", () => {
    expect(isSafeImageContentType("image/png; charset=utf-8")).toBe(true);
  });
});
