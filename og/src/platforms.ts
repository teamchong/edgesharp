/**
 * Platform render presets.
 *
 * Encoded as the first segment of the URL path. Adding a platform = add
 * an entry here. The keys are deliberately short so meta tags stay tidy.
 */

export interface PlatformConfig {
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
  x: {
    width: 1200,
    height: 675,
    description: "Twitter / X large summary card (16:9)",
  },
  sq: {
    width: 1200,
    height: 1200,
    description: "Square thumbnail (Instagram, square previews)",
  },
} as const satisfies Record<string, PlatformConfig>;

export type PlatformKey = keyof typeof PLATFORMS;

export function isPlatformKey(key: string): key is PlatformKey {
  return key in PLATFORMS;
}
