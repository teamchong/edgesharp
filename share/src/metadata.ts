/**
 * Lightweight HTML head metadata extractor.
 *
 * Parses just enough of the source page's <head> to build a share card.
 * Doesn't construct a DOM; walks tag/attribute events from htmlparser2 and
 * collects the metadata fields we care about. Stops at </head> so we don't
 * pay to parse the body.
 */

import { Parser } from "htmlparser2";

export interface PageMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  author: string | null;
  siteName: string | null;
}

const EMPTY: PageMetadata = {
  title: null,
  description: null,
  image: null,
  author: null,
  siteName: null,
};

/**
 * Extract metadata from an HTML string. Reads `<title>`, `<meta>`, and
 * `<link rel="icon">` from the document head. Stops at `</head>` so the
 * parser doesn't walk the body.
 *
 * Priority order per field (first non-empty wins):
 *   title       — og:title → twitter:title → <title>
 *   description — og:description → twitter:description → meta name=description
 *   image       — og:image → twitter:image → link rel=icon
 *   author      — og:article:author → meta name=author
 *   site_name   — og:site_name → null (caller can fall back to URL hostname)
 */
export function extractMetadata(html: string): PageMetadata {
  const og = new Map<string, string>();
  const twitter = new Map<string, string>();
  const named = new Map<string, string>();
  const titleParts: string[] = [];
  let inTitle = false;
  let iconHref: string | null = null;

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "title") {
          inTitle = true;
          return;
        }
        if (name === "meta") {
          const property = (attrs.property ?? "").toLowerCase();
          const metaName = (attrs.name ?? "").toLowerCase();
          const content = attrs.content ?? "";
          if (!content) return;
          if (property.startsWith("og:")) {
            og.set(property, content);
          } else if (metaName.startsWith("twitter:")) {
            twitter.set(metaName, content);
          } else if (metaName) {
            named.set(metaName, content);
          }
          return;
        }
        if (name === "link") {
          const rel = (attrs.rel ?? "").toLowerCase();
          if ((rel === "icon" || rel === "apple-touch-icon") && attrs.href) {
            iconHref ??= attrs.href;
          }
        }
      },
      ontext(text) {
        if (inTitle) titleParts.push(text);
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
        if (name === "head") parser.end();
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );

  parser.write(html);
  parser.end();

  const titleFromTag = titleParts.join("").trim() || null;
  return {
    title:
      og.get("og:title") ??
      twitter.get("twitter:title") ??
      titleFromTag,
    description:
      og.get("og:description") ??
      twitter.get("twitter:description") ??
      named.get("description") ??
      null,
    image:
      og.get("og:image") ??
      twitter.get("twitter:image") ??
      iconHref ??
      null,
    author:
      og.get("og:article:author") ??
      og.get("article:author") ??
      named.get("author") ??
      null,
    siteName: og.get("og:site_name") ?? null,
  };
}

/** Empty metadata, useful when the source URL fetch fails. */
export function emptyMetadata(): PageMetadata {
  return { ...EMPTY };
}
