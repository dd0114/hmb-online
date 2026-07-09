import { defineConfig } from "@playwright/test";

// HMB 뷰어 이벤트↔연출 계약 E2E. 대상 = e2e/viewer-test.html(globalSetup 이 조립).
// file:// 로 로드하므로 webServer 불필요. chromium 은 ~/Library/Caches/ms-playwright 캐시 사용.
export default defineConfig({
  testDir: "./packages/engine/dev-viewer/e2e",
  // *.spec.ts 만 e2e. gen-fixtures.test.ts(vitest 생성기)는 제외.
  testMatch: "**/*.spec.ts",
  globalSetup: "./packages/engine/dev-viewer/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: { headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
