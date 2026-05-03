/**
 * Render pipeline: HTML template → SVG → PNG.
 *
 * The template HTML (after variable substitution) is parsed by
 * `satori-html` into the React-shaped node tree Satori expects. Satori
 * lays it out as SVG via flexbox; Resvg WASM rasterizes that to PNG.
 *
 * Resvg WASM is statically imported via wrangler's CompiledWasm rule
 * and instantiated once per isolate.
 */

// @ts-expect-error wrangler resolves .wasm as a CompiledWasm module.
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satori from "satori";
import { html } from "satori-html";
import type { ReactNode } from "react";
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

export async function renderHtml(
  templateHtml: string,
  options: RenderOptions,
): Promise<RenderResult> {
  await ensureResvg();

  // satori-html returns a VNode shape that satori accepts at runtime; the
  // type signatures don't quite line up so cast through ReactNode. Trim
  // whitespace so a trailing newline in the template file doesn't surface
  // as a stray text-node sibling that fails satori's flex-children rule.
  const node = html(templateHtml.trim()) as unknown as ReactNode;
  const svg = await satori(node, {
    width: options.width,
    height: options.height,
    fonts: FONTS,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: options.width },
    font: { loadSystemFonts: false },
  });
  const png = resvg.render().asPng();

  return { bytes: png, contentType: "image/png" };
}
