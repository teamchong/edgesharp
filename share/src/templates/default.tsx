/**
 * Default share card template.
 *
 * Plain layout that works at any aspect ratio (Satori uses flexbox so the
 * same JSX renders cleanly at 1200×630, 1200×675, 1200×1200, etc.). Title
 * dominates, description sits beneath, site name and accent bar at the
 * bottom. No custom branding — users wanting their logo or different
 * typography fork the template.
 */

import type { ReactElement } from "react";

export interface TemplateProps {
  title: string;
  description: string;
  siteName: string;
  accent: string;
  background: string;
  foreground: string;
}

export default function DefaultTemplate(props: TemplateProps): ReactElement {
  const { title, description, siteName, accent, background, foreground } = props;
  const muted = withAlpha(foreground, 0.65);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        background,
        color: foreground,
        fontFamily: "Inter, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "32px",
          maxWidth: "85%",
        }}
      >
        <div
          style={{
            fontSize: 80,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
          }}
        >
          {title}
        </div>
        {description ? (
          <div
            style={{
              fontSize: 32,
              fontWeight: 400,
              lineHeight: 1.4,
              color: muted,
            }}
          >
            {description}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 12,
            background: accent,
          }}
        />
        <div
          style={{
            fontSize: 24,
            fontWeight: 500,
            color: muted,
          }}
        >
          {siteName}
        </div>
      </div>
    </div>
  );
}

/** Convert a hex `#rrggbb` color into `rgba(r,g,b,a)` so opacity works. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
