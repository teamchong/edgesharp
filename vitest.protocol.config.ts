import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/conformance/protocol.test.ts"],
    globalSetup: ["tests/conformance/global-setup.ts"],
    // Cold transform on a CI runner (compile WASM, decode JPEG, encode WebP)
    // can take 30+ seconds the first time. The global setup warms the
    // Worker before tests start, but slower runners can still need slack.
    testTimeout: 180000,
  },
});
