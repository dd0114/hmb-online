import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * #498 실화면 캡처 하네스 (계약 아님 — **눈으로 보기 위한 것**).
 *
 * 이 웨이브는 화면 **구조**를 바꾼다(하단탭 8칸 → 7칸 + 운영 화면 상단 서브탭). 루트 §2-2 가
 * *"인지 갭 버그는 좌표 추론 금지 — 실화면 캡처로 확인"* 이라고 못 박은 부류다: 폭·활성 속성은
 * DOM 이 말해 주지만 **"서브탭이 아래 섹션 탭과 같은 줄로 보이나"** 는 말해 주지 않는다.
 *
 *   CI=1 WEB_E2E_PORT=5236 npx playwright test e2e/p498-subnav.capture.ts
 *   → .p498/
 */

const OUT = ".p498/";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function boot(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: "u9", nickname: "관리자", isAdmin: true },
          wallet: { points: 100 },
          records: { wins: 0, draws: 0, losses: 0 },
        }),
      ),
  );
  await page.route(
    (url) => url.pathname === "/api/admin/events/funnel",
    (route) => route.fulfill(json({ generatedAt: "2026-08-13T12:00:00Z", users: [] })),
  );
  await page.route(
    (url) => url.pathname === "/api/admin/events",
    (route) => route.fulfill(json({ items: [], total: 0, limit: 50, offset: 0 })),
  );
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
}

test("#498 캡처 — 320/390 × (운영 액션 / 이벤트 보드)", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await boot(page);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 780 });

    await page.goto("/admin");
    await expect(page.getByTestId("admin-page")).toBeVisible();
    await page.screenshot({ path: `${OUT}admin-${width}.png` });

    await page.goto("/event-board");
    await expect(page.getByTestId("event-board-page")).toBeVisible();
    await page.screenshot({ path: `${OUT}event-board-${width}.png` });
  }
});
