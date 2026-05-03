/**
 * Render pipeline: JSX → SVG → PNG.
 *
 * Satori (pure JS) walks the React-shaped JSX tree and lays out flexbox
 * nodes into an SVG string. Resvg (WASM) rasterizes that SVG into PNG.
 * The Resvg WASM module is statically imported via wrangler's CompiledWasm
 * rule and instantiated once per isolate.
 */

// @ts-expect-error wrangler resolves .wasm as a CompiledWasm module.
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satori from "satori";
import type { ReactElement } from "react";
import { FONTS } from "./fonts.js";

let resvgReady: Promise<void> | null = null;
function ensureResvg(): Promise<void> {
  resvgReady ??= initWasm(resvgWasm as WebAssembly.Module);
  return resvgReady;
}

export interface RenderOptions {
  width: number;
  height: number;
}

export interface RenderResult {
  bytes: Uint8Array;
  contentType: string;
}

export async function renderCard(
  jsx: ReactElement,
  options: RenderOptions,
): Promise<RenderResult> {
  await ensureResvg();

  const svg = await satori(jsx, {
    width: options.width,
    height: options.height,
    fonts: FONTS,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: options.width },
    font: { loadSystemFonts: false },
  });
  const png = resvg.render().asPng();

  return {
    bytes: png,
    contentType: "image/png",
  };
}
