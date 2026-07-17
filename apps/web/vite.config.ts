import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8080",
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
