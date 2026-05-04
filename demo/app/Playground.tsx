"use client";

import { useEffect, useMemo, useState } from "react";

const WIDTHS = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const FORMATS = [
  { value: "auto", label: "auto", accept: "image/avif,image/webp,image/*" },
  { value: "image/avif", label: "avif", accept: "image/avif,*/*" },
  { value: "image/webp", label: "webp", accept: "image/webp,*/*" },
  { value: "image/jpeg", label: "jpeg", accept: "image/jpeg,*/*" },
  { value: "image/png", label: "png", accept: "image/png,*/*" },
];

const SAMPLES = [
  { label: "Bundled photo (2K)", url: "/demo/photo.jpg" },
  { label: "Bundled photo (4K)", url: "/demo/photo-4k.jpg" },
  { label: "Bundled UI mock", url: "/demo/ui.png" },
  { label: "Bundled EXIF portrait", url: "/demo/portrait.jpg" },
  { label: "Unsplash · landscape", url: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=2400" },
  { label: "Picsum · random 1200×800", url: "https://picsum.photos/1200/800" },
];

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// Picsum's `/W/H` URL 302s to a different random image on every fetch, so
// the browser-side <img> and the Worker's server-side fetch resolve to
// unrelated images. Solution: pin the URL to `/seed/<rand>/W/H` (Picsum
// returns the same image for a given seed) right before each Optimize
// click — both panels then fetch the same seeded URL. We re-roll on every
// click so "random Picsum" stays random across clicks; users wanting a
// fixed image can paste a `/id/<n>/W/H` URL, which is left untouched.
function rerollPicsum(input: string): string {
  try {
    const u = new URL(input);
    if (u.hostname !== "picsum.photos") return input;
    if (u.pathname.startsWith("/id/")) return input;
    // Strip any prior `/seed/<X>` prefix so the new seed replaces it.
    const path = u.pathname.replace(/^\/seed\/[^/]+/, "");
    const seed = Math.random().toString(36).slice(2, 10);
    u.pathname = `/seed/${seed}${path}`;
    return u.toString();
  } catch {
    return input;
  }
}

export default function Playground() {
  // `url` is what the textbox shows (the user's intent — e.g. the bare
  // `picsum.photos/1200/800`). `effectiveUrl` is what we actually fetch
  // from in both panels — for Picsum that gets a fresh seed on each
  // Optimize click so the comparison is consistent without hiding the
  // user's URL behind seed gunk.
  const [url, setUrl] = useState(SAMPLES[0]!.url);
  const [effectiveUrl, setEffectiveUrl] = useState(SAMPLES[0]!.url);
  const [width, setWidth] = useState<number>(640);
  const [quality, setQuality] = useState<number>(75);
  const [format, setFormat] = useState<string>("auto");
  const [result, setResult] = useState<{
    blobUrl: string;
    size: number;
    mime: string;
    ms: number;
    dim: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [originalSize, setOriginalSize] = useState<number | null>(null);

  const requestUrl = useMemo(() => {
    const params = new URLSearchParams({
      url: effectiveUrl,
      w: String(width),
      q: String(quality),
    });
    return `/_next/image?${params}`;
  }, [effectiveUrl, width, quality]);

  // When the user-facing URL changes, derive a fresh effective URL.
  useEffect(() => {
    setEffectiveUrl(rerollPicsum(url));
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    setOriginalSize(null);
    fetch(effectiveUrl)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (cancelled || !b) return;
        setOriginalSize(b.size);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [effectiveUrl]);

  async function run() {
    setError(null);
    setLoading(true);

    // Re-roll Picsum's seed on every click so each Optimize gets a fresh
    // random image while both panels see the same one. Textbox URL stays
    // as-is; only the internal effectiveUrl changes.
    const fresh = rerollPicsum(url);
    setEffectiveUrl(fresh);
    const params = new URLSearchParams({
      url: fresh,
      w: String(width),
      q: String(quality),
    });
    const freshRequestUrl = `/_next/image?${params}`;

    const accept = FORMATS.find((f) => f.value === format)?.accept ?? "*/*";
    const t0 = performance.now();
    try {
      const res = await fetch(freshRequestUrl, { headers: { Accept: accept } });
      if (!res.ok) {
        const text = await res.text();
        setError(`${res.status} · ${text.slice(0, 200)}`);
        setResult(null);
        return;
      }
      const blob = await res.blob();
      const ms = performance.now() - t0;
      const blobUrl = URL.createObjectURL(blob);
      const dim = await new Promise<string>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(`${img.naturalWidth}×${img.naturalHeight}`);
        img.onerror = () => resolve("?×?");
        img.src = blobUrl;
      });
      setResult({
        blobUrl,
        size: blob.size,
        mime: (blob.type || res.headers.get("content-type") || "")
          .replace("image/", "")
          .toUpperCase(),
        ms,
        dim,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-neutral-900 rounded-xl border border-neutral-800 p-5 md:p-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wide mb-2 block">
            Source URL
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Image source URL"
            className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-md text-sm font-mono text-neutral-200 focus:outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-400/30"
          />
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) setUrl(e.target.value);
            }}
            className="mt-2 w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-md text-sm text-neutral-300 focus:outline-none"
          >
            <option value="">— pick a sample to populate the field —</option>
            {SAMPLES.map((s) => (
              <option key={s.url} value={s.url}>
                {s.label} · {s.url.length > 50 ? s.url.slice(0, 50) + "…" : s.url}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-neutral-500 mt-2 leading-snug">
            Path-relative URLs (
            <code className="text-orange-300">/demo/&hellip;</code>) come from
            this Worker&apos;s bundled assets. This demo&apos;s{" "}
            <code className="text-orange-300">ALLOWED_ORIGINS</code> is set to{" "}
            <code className="text-orange-300">*</code> so any{" "}
            <code className="text-orange-300">https://</code> URL works — your
            production deployment should narrow that to a curated list.
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wide">
                Width
              </label>
              <span className="text-sm font-mono text-orange-300">{width} px</span>
            </div>
            <select
              value={width}
              onChange={(e) => setWidth(parseInt(e.target.value, 10))}
              className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-md text-sm font-mono text-neutral-200"
            >
              {WIDTHS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wide">
                Quality
              </label>
              <span className="text-sm font-mono text-orange-300">{quality}</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={quality}
              onChange={(e) => setQuality(parseInt(e.target.value, 10))}
              className="w-full accent-orange-400"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wide mb-1 block">
              Output format
            </label>
            <div className="grid grid-cols-5 gap-1.5 text-sm font-mono">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFormat(f.value)}
                  className={
                    "rounded-md py-1.5 border transition " +
                    (format === f.value
                      ? "bg-orange-500/20 text-orange-200 border-orange-400/40"
                      : "bg-neutral-800 text-neutral-300 border-neutral-700 hover:bg-neutral-700")
                  }
                >
                  {f.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-neutral-500 mt-1.5 leading-snug">
              <span className="text-orange-300">auto</span> negotiates via the
              Accept header. AVIF is served natively by default; set{" "}
              <code className="text-orange-300">ENABLE_AVIF=false</code> in the
              Cloudflare dashboard to fall back to WebP.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={run}
          disabled={loading || !url}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-400 disabled:opacity-50 disabled:cursor-not-allowed text-neutral-950 font-medium rounded-md transition"
        >
          {loading ? "Transforming…" : "Optimize"}
        </button>
        <code className="text-xs font-mono text-neutral-500 break-all">
          {requestUrl}
        </code>
      </div>

      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-neutral-950 rounded-lg border border-neutral-800 overflow-hidden">
          <div className="px-4 py-2 border-b border-neutral-800 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-neutral-300">Original</h3>
            <span className="text-[11px] font-mono text-neutral-500">
              {originalSize !== null ? fmtBytes(originalSize) : "…"}
            </span>
          </div>
          <div className="aspect-[4/3] flex items-center justify-center overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={effectiveUrl}
              alt="original"
              className="max-w-full max-h-full object-contain"
            />
          </div>
        </div>
        <div className="bg-neutral-950 rounded-lg border border-neutral-800 overflow-hidden">
          <div className="px-4 py-2 border-b border-neutral-800 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-orange-300">edgesharp</h3>
            <span className="text-[11px] font-mono text-neutral-500">
              {result
                ? `${result.mime} · ${fmtBytes(result.size)} · ${result.dim} · ${result.ms.toFixed(0)} ms`
                : "—"}
            </span>
          </div>
          <div className="aspect-[4/3] flex items-center justify-center overflow-hidden">
            {result ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={result.blobUrl}
                alt="optimized"
                className="max-w-full max-h-full object-contain"
              />
            ) : error ? (
              <div className="px-4 py-6 text-center text-xs font-mono text-red-400 break-all">
                {error}
              </div>
            ) : (
              <div className="text-xs text-neutral-500">
                Click Optimize to run the pipeline
              </div>
            )}
          </div>
        </div>
      </div>

      {result && originalSize !== null && originalSize > 0 ? (
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Stat
            label="Saved"
            value={
              originalSize > result.size
                ? `${((1 - result.size / originalSize) * 100).toFixed(1)}%`
                : "—"
            }
            highlight
          />
          <Stat label="Output size" value={fmtBytes(result.size)} />
          <Stat label="Round trip" value={`${result.ms.toFixed(0)} ms`} />
          <Stat label="Format" value={result.mime || "—"} />
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="bg-neutral-950 rounded-lg border border-neutral-800 p-3">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div
        className={
          "mt-0.5 font-mono text-base font-semibold " +
          (highlight ? "text-orange-300" : "text-neutral-200")
        }
      >
        {value}
      </div>
    </div>
  );
}
