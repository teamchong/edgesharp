/**
 * HTML head metadata extractor.
 *
 * Walks the source page's <head> via htmlparser2 events and collects
 * every <title>, <meta>, and <link> tag into a flat key→value map.
 * Templates substitute {{key}} from this map, so any <meta name="X">
 * the page author declared is available as {{X}} — including custom
 * keys the template was written to expect.
 *
 * Three named convenience fields on top of the raw map:
 *
 *   {{title}}       og:title → twitter:title → <title> text
 *   {{description}} og:description → twitter:description → meta name=description
 *   {{siteName}}    og:site_name → null (caller falls back to URL hostname)
 *
 * Stops at </head> so the parser doesn't walk the body.
 */

import { Parser } from "htmlparser2";

export interface PageMetadata {
  title: string | null;
  description: string | null;
  siteName: string | null;
  /**
   * Every meta tag from the page, keyed by `property` then `name`. Custom
   * keys that the page author declared (e.g. `<meta name="author"
   * content="Jane">`) are usable as {{author}} in any template.
   */
  meta: Record<string, string>;
}

export function extractMetadata(html: string): PageMetadata {
  const meta: Record<string, string> = {};
  const titleParts: string[] = [];
  let inTitle = false;

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
          const content = attrs.content;
          if (typeof content !== "string" || content.length === 0) return;
          if (property) meta[property] = content;
          if (metaName && !(metaName in meta)) meta[metaName] = content;
          return;
        }
        if (name === "link") {
          const rel = (attrs.rel ?? "").toLowerCase();
          if (rel && typeof attrs.href === "string") {
            const key = `link:${rel}`;
            if (!(key in meta)) meta[key] = attrs.href;
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

  const titleFromTag = titleParts.join("").trim();

  const title =
    meta["og:title"] ??
    meta["twitter:title"] ??
    (titleFromTag.length > 0 ? titleFromTag : null);

  const description =
    meta["og:description"] ??
    meta["twitter:description"] ??
    meta["description"] ??
    null;

  const siteName = meta["og:site_name"] ?? null;

  // Make {{title}} resolve to the <title> text when no og:title /
  // twitter:title was set.
  if (titleFromTag.length > 0 && !("title" in meta)) {
    meta["title"] = titleFromTag;
  }

  return { title, description, siteName, meta };
}

export function emptyMetadata(): PageMetadata {
  return { title: null, description: null, siteName: null, meta: {} };
}
