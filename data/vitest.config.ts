import { defineConfig } from "vitest/config";

/**
 * data 워크스페이스 전용 vitest 설정 — `cd data && npx vitest run` 또는
 * `npx vitest run --root data` 로 data 도메인만 독립 실행할 때 쓴다.
 * 참고: 루트 vitest.config.ts 의 test.include 에도 data/**\/*.test.ts 가 포함되어 있어
 * 루트 `npm test` 로도 함께 돈다(그쪽은 루트 설정·alias 사용).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@hmb/shared": new URL("../packages/shared/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["players/**/*.test.ts"],
  },
});
