import { defineConfig, devices } from "@playwright/test";

/**
 * apps/web E2E (AC-W1 브라우저 풀 시나리오). 루트 playwright.config.ts(엔진 뷰어 계약)와
 * 별개 — 이 설정은 web 도메인 전용이며 vite dev(/api→:8080 프록시)를 띄운다.
 *
 * 실행: cd apps/web && npx playwright test
 * 서버(server-java + ts-servants stub)가 안 떠 있으면 스펙이 스스로 test.skip 한다(graceful).
 */
const PORT = Number(process.env.WEB_E2E_PORT ?? 5199);
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // 라이브 단일 SQLite 서버 공유 — 파일 간 병렬 금지(W6 검증 m1)
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: BASE, headless: true, trace: "off" },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
