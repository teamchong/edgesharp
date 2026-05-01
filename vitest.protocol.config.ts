import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/conformance/protocol.test.ts"],
    globalSetup: ["tests/conformance/global-setup.ts"],
    testTimeout: 30000,
  },
});
