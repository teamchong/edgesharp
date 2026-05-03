/**
 * Platform render presets.
 *
 * Each platform maps to a (width, height, format, quality) tuple. The site
 * embeds multiple meta tags pointing at the same Worker with different `p`
 * params, so one Worker covers OpenGraph, Twitter, WhatsApp, etc. without
 * duplicating template logic.
 */

export interface PlatformConfig {
  /** Output canvas dimensions. */
  width: number;
  height: number;
  /** Brief description for documentation. */
  description: string;
}

export const PLATFORMS = {
  og: {
    width: 1200,
    height: 630,
    description:
      "OpenGraph: Facebook, LinkedIn, Slack, Discord, iMessage, Bluesky, Threads, Mastodon, WhatsApp",
  },
  twitter: {
    width: 1200,
    height: 675,
    description: "Twitter / X large summary card (16:9)",
  },
  square: {
    width: 1200,
    height: 1200,
    description: "Square thumbnail (Instagram, square previews)",
  },
} as const satisfies Record<string, PlatformConfig>;

export type PlatformName = keyof typeof PLATFORMS;

export function isPlatformName(name: string): name is PlatformName {
  return name in PLATFORMS;
}

export function resolvePlatform(name: string | null): PlatformConfig {
  if (name && isPlatformName(name)) return PLATFORMS[name];
  return PLATFORMS.og;
}
