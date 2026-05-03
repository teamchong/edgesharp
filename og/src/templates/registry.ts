/**
 * Template registry.
 *
 * Templates are HTML files in this directory loaded as binary imports
 * via wrangler's Data rule. Each is keyed by the path segment that
 * follows the platform in the URL — e.g. for `/og/article.html`, the
 * template key is `article.html`.
 *
 * The empty key (`""`) is the default template, served when the URL has
 * only the platform segment (e.g. `/og/`, `/og`).
 *
 * Adding a template: drop a `.html` file in this folder, register it
 * here, push to git. Workers Builds redeploys automatically.
 */

// @ts-expect-error wrangler resolves .html as binary Data.
import defaultHtml from "./default.html";
// @ts-expect-error wrangler resolves .html as binary Data.
import articleHtml from "./article.html";

const decoder = new TextDecoder();
const decode = (buf: ArrayBuffer): string => decoder.decode(buf);

export const TEMPLATES: Record<string, string> = {
  "": decode(defaultHtml as ArrayBuffer),
  "default.html": decode(defaultHtml as ArrayBuffer),
  "article.html": decode(articleHtml as ArrayBuffer),
};

export function resolveTemplate(name: string): string | null {
  return TEMPLATES[name] ?? null;
}
