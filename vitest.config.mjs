import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.mjs"],
    setupFiles: ["tests/setup/foundry-globals.mjs"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["scripts/core/**"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 90 }
    }
  }
});
