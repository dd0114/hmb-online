import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 프록시 대상은 기본 8080(데모). 대체 서버(예: W0 스모크 8084)는 VITE_API_TARGET 로 덮어쓴다.
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://localhost:8080",
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
