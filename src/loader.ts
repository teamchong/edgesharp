/**
 * Next.js custom image loader for edgesharp.
 *
 * Usage in next.config.js:
 *
 *   module.exports = {
 *     images: {
 *       loader: 'custom',
 *       loaderFile: './node_modules/edgesharp/dist/loader.js',
 *     },
 *   }
 *
 * Or create your own loader file that re-exports with a custom URL:
 *
 *   import { createLoader } from 'edgesharp/loader';
 *   export default createLoader({ url: 'https://images.example.com' });
 *
 * Environment variable NEXT_PUBLIC_IMAGEMODE_URL can also be used:
 *
 *   NEXT_PUBLIC_IMAGEMODE_URL=https://images.example.com npm run build
 */

interface ImageLoaderProps {
  src: string;
  width: number;
  quality?: number;
}

interface LoaderConfig {
  /** The URL of your edgesharp Worker. */
  url: string;
  /** Default quality if not specified by the Image component. Default: 75. */
  defaultQuality?: number;
}

/**
 * Create a Next.js image loader function for a specific edgesharp Worker URL.
 */
export function createLoader(config: LoaderConfig) {
  const baseUrl = config.url.replace(/\/$/, "");
  const defaultQuality = config.defaultQuality ?? 75;

  return function edgesharpLoader({ src, width, quality }: ImageLoaderProps): string {
    const params = new URLSearchParams({
      url: src,
      w: String(width),
      q: String(quality ?? defaultQuality),
    });
    return `${baseUrl}/_next/image?${params}`;
  };
}

/**
 * Default loader, reads the Worker URL from NEXT_PUBLIC_IMAGEMODE_URL
 * environment variable. Falls back to relative URL (same-origin deployment).
 */
export default function edgesharpLoader({ src, width, quality }: ImageLoaderProps): string {
  const baseUrl = (
    typeof process !== "undefined"
      ? process.env?.NEXT_PUBLIC_IMAGEMODE_URL
      : undefined
  ) ?? "";

  const params = new URLSearchParams({
    url: src,
    w: String(width),
    q: String(quality ?? 75),
  });

  return `${baseUrl.replace(/\/$/, "")}/_next/image?${params}`;
}
