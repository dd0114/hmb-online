import { defineConfig, devices } from "@playwright/test";

/**
 * 캡처 전용 설정 — `e2e/*.capture.ts` 만 돈다.
 *
 * 왜 별도인가: 기본 설정의 `testMatch` 는 `*.spec.ts` 라 캡처 파일이 **판정 게이트에 섞이지 않는다**
 * (캡처는 hero 컨펌 자료이지 계약이 아니다 — 루트 §2-2). 포트도 기본과 다르게 잡아 :8080 데모·
 * 다른 세션 dev 서버와 격리한다.
 *
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5287 npx playwright test --config=playwright.capture.config.ts
 */
const PORT = Number(process.env.WEB_E2E_PORT ?? 5287);
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.capture.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: BASE, headless: true, trace: "off" },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
