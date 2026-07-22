import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@hmb/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@hmb/engine": new URL("./packages/engine/src/index.ts", import.meta.url).pathname,
      // 관전 렌더/투영 코어(#169 P4-D3) — apps/web/vite.config.ts 의 alias 와 같은 대상.
      "@hmb/viewer-core": new URL("./packages/viewer-core/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "data/**/*.test.ts"],
  },
});
