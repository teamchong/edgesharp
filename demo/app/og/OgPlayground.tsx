"use client";

import { useEffect, useMemo, useState } from "react";
import { TEMPLATE_HTML, variablesIn } from "./templates";

type Preset = "default" | "article" | "custom";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "default", label: "Default (bundled)" },
  { value: "article", label: "Article (bundled)" },
  { value: "custom", label: "Custom (editor)" },
];

const PLATFORMS = [
  { value: "og", label: "OpenGraph (1200×630)", aspect: "1.905" },
  { value: "x", label: "Twitter / X (1200×675)", aspect: "1.778" },
  { value: "sq", label: "Square (1200×1200)", aspect: "1" },
] as const;

// edgesharp-og is a separate Worker. Local dev: pnpm run dev:og runs it
// on :8788. Production: set NEXT_PUBLIC_OG_URL to the deployed URL.
const OG_BASE =
  process.env.NEXT_PUBLIC_OG_URL?.replace(/\/$/, "") ?? "http://localhost:8788";

export default function OgPlayground() {
  const [preset, setPreset] = useState<Preset>("default");
  const [platform, setPlatform] = useState<string>("og");
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pageMeta, setPageMeta] = useState<Record<string, string>>({});
  const [titleText, setTitleText] = useState<string>("");

  // Custom-template editor — only visible when preset === "custom".
  // Worker only renders HTML at runtime; if a user wants to author in
  // JSX/TSX/MDX they compile to HTML in their fork's build pipeline
  // before commit. The demo doesn't need to know about other formats.
  const [customFilename, setCustomFilename] = useState<string>("my-card.html");
  const [customBody, setCustomBody] = useState<string>(TEMPLATE_HTML.default);

  // Effective state derived from preset
  const isCustom = preset === "custom";
  const effectiveFilename = isCustom
    ? customFilename
    : preset === "article"
      ? "article.html"
      : "default.html";
  const effectiveBody = isCustom ? customBody : TEMPLATE_HTML[preset];

  const templateVars = useMemo(() => variablesIn(effectiveBody), [effectiveBody]);

  const urlFilename =
    effectiveFilename === "default.html" ? "" : effectiveFilename;
  const generatedUrl = useMemo(
    () => `${OG_BASE}/${platform}/${urlFilename}`,
    [platform, urlFilename],
  );
  const metaSnippet = useMemo(
    () => buildMetaSnippet(generatedUrl, platform),
    [generatedUrl, platform],
  );
  const aspect =
    PLATFORMS.find((p) => p.value === platform)?.aspect ?? "1.905";

  // Read this page's own metadata once, on mount. The og Worker will see
  // (roughly) the same set when it fetches this page via Referer.
  useEffect(() => {
    setTitleText(document.title);
    const map: Record<string, string> = {};
    document.querySelectorAll<HTMLMetaElement>("meta").forEach((el) => {
      const property = el.getAttribute("property")?.toLowerCase();
      const name = el.getAttribute("name")?.toLowerCase();
      const content = el.getAttribute("content");
      if (!content) return;
      if (property) map[property] = content;
      if (name && !(name in map)) map[name] = content;
    });
    if (document.title && !("title" in map)) map.title = document.title;
    setPageMeta(map);
  }, []);

  useEffect(() => {
    if (copied) {
      const t = setTimeout(() => setCopied(false), 1500);
      return () => clearTimeout(t);
    }
  }, [copied]);

  async function generate() {
    setStatus("loading");
    setErrorMsg(null);
    try {
      const res = isCustom
        ? await fetch(generatedUrl, {
            method: "POST",
            headers: { "Content-Type": "text/html" },
            body: customBody,
          })
        : await fetch(generatedUrl);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      setRenderUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return objectUrl;
      });
      setStatus("ok");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(metaSnippet);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <Field label="Template">
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value as Preset)}
              className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 text-sm focus:border-orange-400/60 focus:outline-none"
            >
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Platform">
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 text-sm focus:border-orange-400/60 focus:outline-none"
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          <button
            type="button"
            onClick={generate}
            disabled={status === "loading"}
            className="w-full px-4 py-3 rounded-md bg-orange-500/15 border border-orange-400/40 text-orange-200 font-medium hover:bg-orange-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === "loading" ? "Rendering…" : "Generate OG card"}
          </button>

          {status === "error" && errorMsg ? (
            <div className="text-sm text-red-300 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30">
              {errorMsg}
            </div>
          ) : null}
        </div>

        <div className="space-y-4">
          <div className="text-sm text-neutral-400">Preview</div>
          <div
            className="rounded-xl overflow-hidden border border-neutral-800 bg-neutral-900"
            style={{ aspectRatio: aspect }}
          >
            {renderUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={renderUrl}
                alt="Generated OG card preview"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-sm text-neutral-500">
                {status === "loading"
                  ? "Rendering…"
                  : status === "error"
                    ? "Render failed (see error above)"
                    : "Click Generate to preview"}
              </div>
            )}
          </div>
        </div>
      </div>

      {isCustom ? (
        <Panel title="Custom template editor">
          <div className="text-xs text-neutral-500 mb-3 leading-relaxed">
            Edit the filename and body below — the demo POSTs the body to
            the og Worker for a one-shot preview render. To actually
            deploy this template, commit the file at{" "}
            <code className="text-orange-300">og/src/templates/{customFilename}</code>{" "}
            in your fork; push to git, Workers Builds redeploys.
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <Field label="Filename">
              <input
                type="text"
                value={customFilename}
                onChange={(e) => setCustomFilename(e.target.value)}
                spellCheck={false}
                className="w-full px-3 py-2 rounded-md bg-neutral-950 border border-neutral-700 text-xs font-mono text-neutral-200 focus:border-orange-400/60 focus:outline-none"
              />
            </Field>
            <Field label="Seed from">
              <select
                value=""
                onChange={(e) => {
                  const seed = e.target.value;
                  if (!seed) return;
                  setCustomBody(TEMPLATE_HTML[seed] ?? "");
                  e.currentTarget.value = "";
                }}
                className="w-full px-3 py-2 rounded-md bg-neutral-950 border border-neutral-700 text-xs text-neutral-200 focus:border-orange-400/60 focus:outline-none"
              >
                <option value="">(pick a starter)</option>
                <option value="default">Default</option>
                <option value="article">Article</option>
              </select>
            </Field>
          </div>

          <Field label="HTML body">
            <textarea
              value={customBody}
              onChange={(e) => setCustomBody(e.target.value)}
              spellCheck={false}
              rows={14}
              className="w-full px-3 py-2 rounded-md bg-neutral-950 border border-neutral-700 text-xs font-mono text-neutral-200 focus:border-orange-400/60 focus:outline-none resize-y"
            />
          </Field>

          <div className="mt-3 text-xs text-neutral-500 leading-relaxed">
            Want to author in JSX / TSX / MDX? Set up a build step in your
            fork that compiles to HTML before deploy (e.g. the @vercel/og
            pipeline). The Worker itself only ever renders HTML at runtime
            — your build pipeline produces the HTML files in{" "}
            <code className="text-orange-300">og/src/templates/</code>.
          </div>
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Variables this template uses">
          <div className="text-xs text-neutral-500 mb-3 leading-relaxed">
            The selected template references these{" "}
            <code className="text-orange-300">{`{{name}}`}</code> markers.
            On render, each is filled from this page&rsquo;s extracted
            metadata (or empty string if the page doesn&rsquo;t have that
            value).
          </div>
          <ul className="text-sm space-y-1">
            {templateVars.length === 0 ? (
              <li className="text-neutral-500 italic">
                (this template has no {`{{...}}`} markers)
              </li>
            ) : (
              templateVars.map((name) => {
                const value = readVariable(name, pageMeta, titleText);
                return (
                  <li key={name} className="flex items-start gap-3">
                    <code className="text-orange-300 font-mono text-xs whitespace-nowrap">{`{{${name}}}`}</code>
                    <span className={value ? "text-neutral-200 break-all" : "text-neutral-600 italic"}>
                      {value || "(empty on this page)"}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        </Panel>

        <Panel title="All metadata extracted from this page">
          <div className="text-xs text-neutral-500 mb-3 leading-relaxed">
            Every <code className="text-orange-300">{`<meta>`}</code> tag
            on this page is available to any template as{" "}
            <code className="text-orange-300">{`{{key}}`}</code>. Add a{" "}
            <code className="text-orange-300">{`<meta name="my-thing" content="...">`}</code>{" "}
            to your page and a custom template can reference it as{" "}
            <code className="text-orange-300">{`{{my-thing}}`}</code>.
          </div>
          <details>
            <summary className="cursor-pointer text-sm text-neutral-400 hover:text-orange-200">
              {Object.keys(pageMeta).length} keys
            </summary>
            <ul className="text-xs space-y-1 mt-3 font-mono">
              {Object.entries(pageMeta).map(([k, v]) => (
                <li key={k} className="flex items-start gap-3">
                  <span className="text-orange-300 whitespace-nowrap">{k}</span>
                  <span className="text-neutral-300 break-all">{v}</span>
                </li>
              ))}
            </ul>
          </details>
        </Panel>
      </div>

      <div className="space-y-3">
        <div className="text-sm text-neutral-400">
          Drop this in your site&rsquo;s{" "}
          <code className="text-orange-300">{`<head>`}</code>:
        </div>
        <div className="relative">
          <pre className="rounded-md p-4 bg-neutral-900 border border-neutral-800 text-xs text-neutral-200 overflow-x-auto">
            <code>{metaSnippet}</code>
          </pre>
          <button
            type="button"
            onClick={copySnippet}
            className="absolute top-2 right-2 text-xs px-2 py-1 rounded bg-neutral-800 border border-neutral-700 text-neutral-300 hover:text-orange-200 hover:border-orange-400/40"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-neutral-400 mb-1.5">{label}</div>
      {children}
    </label>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-sm font-semibold text-neutral-200 mb-3">{title}</div>
      {children}
    </div>
  );
}

/**
 * Look up a template variable in the extracted metadata. Mirrors the og
 * Worker's resolution order so what the demo shows here matches what the
 * Worker will substitute.
 */
function readVariable(
  name: string,
  meta: Record<string, string>,
  titleText: string,
): string {
  if (name in meta) return meta[name];
  if (name === "title") {
    return meta["og:title"] ?? meta["twitter:title"] ?? titleText ?? "";
  }
  if (name === "description") {
    return meta["og:description"] ?? meta["twitter:description"] ?? meta["description"] ?? "";
  }
  if (name === "siteName" || name === "site") {
    return meta["og:site_name"] ?? "";
  }
  return "";
}

function buildMetaSnippet(url: string, platform: string): string {
  if (platform === "x") {
    return [
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:image" content="${escapeHtml(url)}">`,
    ].join("\n");
  }
  return `<meta property="og:image" content="${escapeHtml(url)}">`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
