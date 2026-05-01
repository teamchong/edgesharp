import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/conformance/protocol.test.ts"],
    globalSetup: ["tests/conformance/global-setup.ts"],
    // Cold transform on a CI runner (compile WASM, decode JPEG, encode WebP)
    // can take 30+ seconds the first time. Warm-path requests then drop to
    // single-digit ms. Local dev hits ~5s on the slowest cold transform.
    testTimeout: 90000,
  },
});
