import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 관전 렌더/투영 코어(P4-D3 SoT, #169). 워크스페이스 소스를 그대로 번들한다 —
      // 별도 빌드 산출물이 없어 alias 로 붙인다(tsconfig paths 와 짝).
      "@hmb/viewer-core": fileURLToPath(new URL("../../packages/viewer-core/src/index.ts", import.meta.url)),
      // 서버 권위 시계 매핑(P4-E2 #170) — 시각→틱 계산의 SoT 를 서버/QA뷰어와 공유한다.
      "@hmb/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    // 프록시 대상은 기본 8080(데모). 대체 서버(예: W0 스모크 8084)는 VITE_API_TARGET 로 덮어쓴다.
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://localhost:8080",
        changeOrigin: true,
      },
      // QA 콘솔 레지스트리 API(#191). 같은 오리진으로 보이게 프록시해서 CORS 를 없앤다 —
      // `tools/qa-console.mjs start` 가 VITE_QA_API_TARGET 을 넣어 준다.
      "/qa-api": {
        target: process.env.VITE_QA_API_TARGET || "http://127.0.0.1:8301",
        changeOrigin: true,
      },
    },
  },
  // Playwright E2E(e2e/**)는 vitest 대상이 아니다 — bare `npx vitest run` 이
  // Playwright 전용 스펙을 주워 실패하지 않도록 제외한다(러너는 npx playwright test).
  test: {
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
  },
});
