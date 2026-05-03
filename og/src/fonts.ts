/**
 * Font loader.
 *
 * Inter Regular + Bold are statically imported as ArrayBuffers via wrangler's
 * `Data` rule (configured in `wrangler.json`). Satori accepts an array of
 * `{ name, data, weight, style }` entries, so we pre-build that once at
 * module load and reuse it for every render.
 *
 * Swapping fonts: replace the TTFs in `./fonts/` and update the imports
 * here. Satori accepts TTF and OTF, not WOFF2.
 */

// @ts-expect-error wrangler resolves .ttf as ArrayBuffer via the Data rule.
import interRegular from "./fonts/Inter-Regular.ttf";
// @ts-expect-error same.
import interBold from "./fonts/Inter-Bold.ttf";

export interface SatoriFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: "normal";
}

export const FONTS: SatoriFont[] = [
  {
    name: "Inter",
    data: interRegular as ArrayBuffer,
    weight: 400,
    style: "normal",
  },
  {
    name: "Inter",
    data: interBold as ArrayBuffer,
    weight: 700,
    style: "normal",
  },
];
