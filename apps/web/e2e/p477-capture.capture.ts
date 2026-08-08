import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * #477 실화면 캡처 — **판정이 아니라 눈으로 볼 증빙**이다(루트 CLAUDE §2-2 "좌표 추론 금지").
 * 계약은 `p477-maintenance.spec.ts` 가 진다.
 *
 *   cd apps/web && CI=1 WEB_E2E_PORT=5477 npx playwright test p477-capture --config=playwright.capture.config.ts
 */
const SHOTS = new URL("../.smoke/", import.meta.url).pathname;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

async function killBackend(page: Page) {
  // pathname 매칭 — 오리진 없는 글롭은 vite 에셋까지 삼킨다(CLAUDE.md).
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.abort("connectionrefused"));
}

/**
 * 화면에 실제로 실려야 하는 글자. **캡처를 눈으로 읽어 판정하지 않기 위해** 여기 박는다 —
 * 독립 검증에서 "PNG 의 한글이 깨졌다"(실제로는 정상)는 관측자 오류가 한 번 나왔고, 그 논쟁은
 * 이미지 판독에 기대는 한 계속 재발한다. 이제 답은 DOM 이 준다.
 */
const MUST_RENDER = [
  "점검 중입니다",
  "다시 시도",
  "카카오톡 오픈채팅으로 문의하기",
  "오픈채팅 코드",
] as const;

test("캡처: 점검 안내 화면 (모바일·데스크탑)", async ({ page }) => {
  await killBackend(page);

  for (const [label, vp] of [["390", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(vp);
    await page.goto("/login");
    const screen = page.getByTestId("maintenance-screen");
    await expect(screen).toBeVisible({ timeout: 30_000 });

    // 찍기 전에 "찍히는 내용"을 확정한다 — 캡처는 이 단언의 그림 버전일 뿐이다.
    const text = (await screen.innerText()).replace(/\s+/g, " ");
    for (const phrase of MUST_RENDER) expect(text, `[${label}] 누락: ${phrase}`).toContain(phrase);

    await page.screenshot({ path: `${SHOTS}p477-maintenance-${label}.png`, fullPage: false });
  }
});
