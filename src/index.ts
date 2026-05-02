/**
 * edgesharp. Zero-cost image optimization on Cloudflare Workers.
 *
 * Replaces Cloudflare Images ($0.50/1K transforms) with self-hosted
 * Zig WASM SIMD processing. Same quality, ~100ms cache miss latency,
 * essentially free at any scale.
 *
 * Architecture:
 *   Worker (entry) → Cache API (L1) → R2 (L2) → Image DO pool (L3, Zig WASM)
 *
 * The Image DO pool uses deterministic naming (img-{region}-slot-{N})
 * to keep WASM instances warm. V8 TurboFan compiles SIMD after first
 * invocation, subsequent requests run at full speed.
 */

export { ImageOptimizer } from "./optimizer.js";
export { ImageDO } from "./image-do.js";
export type { TransformOptions, TransformResult, ImageModeConfig } from "./types.js";
