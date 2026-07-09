import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@hmb/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@hmb/engine": new URL("./packages/engine/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
  },
});
