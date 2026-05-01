/**
 * Image Durable Object — holds a warm Zig WASM instance for image transforms.
 *
 * Deterministically named (img-slot-{N}) so V8 TurboFan has time to
 * optimize the WASM SIMD code after first invocation. Subsequent
 * requests to the same slot run at full TurboFan speed.
 *
 * Two output paths:
 *   X-Output-Format: 0|1|2  → JPEG / PNG / WebP encoded bytes
 *   X-Output-Mode: rgba     → resized RGBA bytes for the AVIF encoder upstream
 */
// @ts-expect-error — .wasm import resolved by wrangler bundler
import wasmModule from "./wasm/edgesharp.wasm";

interface WasmExports {
  memory: WebAssembly.Memory;
  wasm_alloc: (len: number) => number;
  wasm_free: (ptr: number, len: number) => void;
  image_transform: (
    srcPtr: number,
    srcLen: number,
    dstWidth: number,
    outputFormat: number,
    quality: number,
  ) => number;
  image_decode_resize: (srcPtr: number, srcLen: number, dstWidth: number) => number;
}

export class ImageDO implements DurableObject {
  private wasm: WasmExports | null = null;

  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const width = parseInt(request.headers.get("X-Target-Width") ?? "0", 10);
    const format = parseInt(request.headers.get("X-Output-Format") ?? "0", 10);
    const quality = parseInt(request.headers.get("X-Quality") ?? "80", 10);
    const outputMode = request.headers.get("X-Output-Mode") ?? "encoded";

    const sourceBytes = new Uint8Array(await request.arrayBuffer());
    if (sourceBytes.byteLength === 0) {
      return new Response("Empty request body", { status: 400 });
    }

    const wasm = this.getWasm();

    const srcPtr = wasm.wasm_alloc(sourceBytes.byteLength);
    if (srcPtr === 0) {
      return new Response("WASM allocation failed", { status: 500 });
    }
    new Uint8Array(wasm.memory.buffer).set(sourceBytes, srcPtr);

    if (outputMode === "rgba") {
      const resultPtr = wasm.image_decode_resize(srcPtr, sourceBytes.byteLength, width);
      wasm.wasm_free(srcPtr, sourceBytes.byteLength);
      if (resultPtr === 0) {
        return new Response("Image decode failed", { status: 500 });
      }

      // Layout: [4 bytes width LE][4 bytes height LE][rgba pixels]
      const view = new DataView(wasm.memory.buffer);
      const w = view.getUint32(resultPtr, true);
      const h = view.getUint32(resultPtr + 4, true);
      const totalLen = 8 + w * h * 4;

      const output = new Uint8Array(totalLen);
      output.set(new Uint8Array(wasm.memory.buffer, resultPtr, totalLen));
      wasm.wasm_free(resultPtr, totalLen);

      return new Response(output, {
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Image-Width": String(w),
          "X-Image-Height": String(h),
        },
      });
    }

    const resultPtr = wasm.image_transform(
      srcPtr,
      sourceBytes.byteLength,
      width,
      format,
      quality,
    );
    wasm.wasm_free(srcPtr, sourceBytes.byteLength);

    if (resultPtr === 0) {
      return new Response("Image transform failed", { status: 500 });
    }

    const resultView = new DataView(wasm.memory.buffer);
    const encodedLen = resultView.getUint32(resultPtr, true);
    const encoded = new Uint8Array(wasm.memory.buffer, resultPtr + 4, encodedLen);
    const output = new Uint8Array(encodedLen);
    output.set(encoded);
    wasm.wasm_free(resultPtr, 4 + encodedLen);

    const mime = format === 1 ? "image/png" : format === 2 ? "image/webp" : "image/jpeg";
    return new Response(output, { headers: { "Content-Type": mime } });
  }

  /** Instantiate the WASM module once. Stays warm across requests via TurboFan. */
  private getWasm(): WasmExports {
    if (this.wasm) return this.wasm;
    const instance = new WebAssembly.Instance(wasmModule);
    this.wasm = instance.exports as unknown as WasmExports;
    return this.wasm;
  }
}
