/**
 * Template HTML strings, bundled into the demo so the playground UI can
 * show what's about to be rendered without needing a separate fetch to
 * the og Worker. These strings are the same files the og Worker bundles
 * at `og/src/templates/*.html`. Keep in sync if either side changes —
 * it's just two short HTML files.
 */

export const TEMPLATE_HTML: Record<string, string> = {
  default: `<div style="display: flex; flex-direction: column; justify-content: space-between; width: 100%; height: 100%; padding: 72px 80px; background: #0a0a0a; color: #fafafa; font-family: Inter, sans-serif;"><div style="display: flex; flex-direction: column; gap: 32px; max-width: 85%;"><div style="font-size: 80px; font-weight: 700; line-height: 1.05; letter-spacing: -0.02em;">{{title}}</div><div style="font-size: 32px; font-weight: 400; line-height: 1.4; color: rgba(250, 250, 250, 0.65);">{{description}}</div></div><div style="display: flex; align-items: center; gap: 16px;"><div style="display: flex; width: 12px; height: 12px; border-radius: 12px; background: #ff6600;"></div><div style="font-size: 24px; font-weight: 500; color: rgba(250, 250, 250, 0.65);">{{siteName}}</div></div></div>`,
  article: `<div style="display: flex; flex-direction: column; width: 100%; height: 100%; padding: 80px; background: #1a1a2e; color: #fafafa; font-family: Inter, sans-serif;"><div style="display: flex; align-items: center; margin-bottom: 48px;"><div style="display: flex; width: 8px; height: 8px; border-radius: 8px; background: #ff6600; margin-right: 12px;"></div><div style="font-size: 22px; font-weight: 500; color: rgba(250, 250, 250, 0.6);">{{siteName}}</div></div><div style="display: flex; flex-direction: column;"><div style="font-size: 76px; font-weight: 700; line-height: 1.06; margin-bottom: 28px;">{{title}}</div><div style="font-size: 30px; font-weight: 400; line-height: 1.45; color: rgba(250, 250, 250, 0.7); max-width: 920px;">{{description}}</div></div><div style="display: flex; margin-top: 40px; font-size: 22px; font-weight: 500; color: rgba(250, 250, 250, 0.55);">{{author}}</div></div>`,
};

/**
 * Extract every `{{name}}` marker from a template HTML string. Used to
 * show the user which metadata keys this template references.
 */
export function variablesIn(html: string): string[] {
  const found = new Set<string>();
  const re = /\{\{\s*([a-zA-Z0-9_.:\/-]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) found.add(m[1]);
  return [...found];
}
