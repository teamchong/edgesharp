"use client";

import { useEffect, useMemo, useState } from "react";

const PLATFORMS = [
  { value: "og", label: "OpenGraph (1200×630)", aspect: "1.905" },
  { value: "twitter", label: "Twitter (1200×675)", aspect: "1.778" },
  { value: "square", label: "Square (1200×1200)", aspect: "1" },
] as const;

const SAMPLE_URLS = [
  "https://blog.cloudflare.com/",
  "https://developers.cloudflare.com/workers/",
  "https://en.wikipedia.org/wiki/Cloudflare",
  "https://github.com/teamchong/edgesharp",
];

const SHARE_BASE =
  process.env.NEXT_PUBLIC_SHARE_URL?.replace(/\/$/, "") ?? "http://localhost:8788";

interface FormState {
  url: string;
  platform: "og" | "twitter" | "square";
  title: string;
  description: string;
  accent: string;
}

export default function SharePlayground() {
  const [form, setForm] = useState<FormState>({
    url: SAMPLE_URLS[0],
    platform: "og",
    title: "",
    description: "",
    accent: "#ff6600",
  });
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generatedUrl = useMemo(() => buildUrl(form), [form]);
  const metaSnippet = useMemo(() => buildMetaSnippet(form), [form]);
  const aspect = PLATFORMS.find((p) => p.value === form.platform)?.aspect ?? "1.905";

  useEffect(() => {
    if (copied) {
      const t = setTimeout(() => setCopied(false), 1500);
      return () => clearTimeout(t);
    }
  }, [copied]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function generate() {
    setStatus("loading");
    setErrorMsg(null);
    try {
      const res = await fetch(generatedUrl);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${body || res.statusText}`);
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
          <Field label="Source URL">
            <input
              type="url"
              value={form.url}
              onChange={(e) => update("url", e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 text-sm focus:border-orange-400/60 focus:outline-none"
            />
            <div className="flex gap-2 flex-wrap mt-2">
              {SAMPLE_URLS.map((sample) => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => update("url", sample)}
                  className="text-xs px-2 py-1 rounded bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-orange-200 hover:border-orange-400/40"
                >
                  {hostnameOf(sample)}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Platform">
            <select
              value={form.platform}
              onChange={(e) => update("platform", e.target.value as FormState["platform"])}
              className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 text-sm focus:border-orange-400/60 focus:outline-none"
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Title (optional override)"
            hint="Leave blank to extract from the page's <title> or og:title"
          >
            <input
              type="text"
              value={form.title}
              onChange={(e) => update("title", e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 text-sm focus:border-orange-400/60 focus:outline-none"
            />
          </Field>

          <Field
            label="Description (optional override)"
            hint="Leave blank to extract from <meta name=description> or og:description"
          >
            <input
              type="text"
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 text-sm focus:border-orange-400/60 focus:outline-none"
            />
          </Field>

          <Field label="Accent color">
            <div className="flex gap-3 items-center">
              <input
                type="color"
                value={form.accent}
                onChange={(e) => update("accent", e.target.value)}
                className="h-10 w-16 rounded cursor-pointer border border-neutral-700 bg-neutral-900"
              />
              <input
                type="text"
                value={form.accent}
                onChange={(e) => update("accent", e.target.value)}
                className="flex-1 px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 text-sm font-mono focus:border-orange-400/60 focus:outline-none"
              />
            </div>
          </Field>

          <button
            type="button"
            onClick={generate}
            disabled={status === "loading" || !form.url}
            className="w-full px-4 py-3 rounded-md bg-orange-500/15 border border-orange-400/40 text-orange-200 font-medium hover:bg-orange-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === "loading" ? "Rendering…" : "Generate share card"}
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
              <img src={renderUrl} alt="Generated share card preview" className="w-full h-full object-contain" />
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

      <div className="space-y-3">
        <div className="text-sm text-neutral-400">
          Drop this in your site&rsquo;s <code className="text-orange-300">{`<head>`}</code>:
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
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-neutral-400 mb-1.5">{label}</div>
      {children}
      {hint ? <div className="text-xs text-neutral-500 mt-1">{hint}</div> : null}
    </label>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function buildUrl(form: FormState): string {
  const params = new URLSearchParams({ url: form.url, p: form.platform });
  if (form.title) params.set("title", form.title);
  if (form.description) params.set("desc", form.description);
  if (form.accent && form.accent !== "#ff6600") params.set("accent", form.accent);
  return `${SHARE_BASE}/card?${params.toString()}`;
}

function buildMetaSnippet(form: FormState): string {
  const url = buildUrl(form);
  if (form.platform === "twitter") {
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
