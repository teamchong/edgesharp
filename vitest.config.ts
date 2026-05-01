import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/conformance/protocol.test.ts"], // protocol tests need wrangler dev — run via vitest.protocol.config.ts
    testTimeout: 30000,
  },
});
