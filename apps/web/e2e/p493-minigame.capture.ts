import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { skipSplash } from "./splash-mock";

/**
 * #493 W1 실화면 캡처 — 계약이 아니라 **증빙**이다(AC2 evidence_kind=screenshot).
 * 신규 유저 미니게임(/welcome)의 ①재생 중(첫 골 직후) ②종료 오버레이+CTA 를
 * 폰(390×844)·데스크탑(1280×800)에서 찍는다. 판정은 사람이 눈으로(루트 §2-2).
 *
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5287 npx playwright test --config=playwright.capture.config.ts e2e/p493-minigame.capture.ts
 */
const OUT = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type ViewerHooks = { ready?: () => boolean; seek?: (t: number) => void; play?: () => void };

async function landOnMinigame(page: Page) {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: "u493", nickname: "신규감독", tutorialDone: false },
          wallet: { points: 3000 },
          records: { wins: 0, draws: 0, losses: 0 },
        }),
      ),
  );
  await page.route(
    (url) => url.pathname === "/api/me/starter-grant",
    (route) => route.fulfill(json({ granted: false, player: null })),
  );
  await page.route(
    (url) => url.pathname === "/api/auth/register",
    (route) =>
      route.fulfill(json({ token: "tok_493", user: { id: "u493", nickname: "신규감독" }, isNew: true })),
  );
  await skipSplash(page);
  await page.goto("/login");
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-mode-toggle").click();
  await page.getByTestId("local-nickname").fill("cap493");
  await page.getByTestId("local-password").fill("sup3rs3cret");
  await page.getByTestId("local-submit").click();
  await page.getByTestId("starter-reveal-close").click();
  await expect(page).toHaveURL(/\/welcome$/);
  await page.waitForFunction(() => {
    const v = (window as unknown as { __viewer?: ViewerHooks }).__viewer;
    return Boolean(v?.ready?.());
  });
}

for (const [label, viewport] of [
  ["phone-390x844", { width: 390, height: 844 }],
  ["desktop-1280x800", { width: 1280, height: 800 }],
] as const) {
  test(`#493 미니게임 캡처 — ${label}`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize(viewport);
    await landOnMinigame(page);

    // ① 첫 골 장면 부근(tick 89 골 → 95 에서 정지 화면) — 자막·무대가 실제로 그려졌는지.
    await page.evaluate(() => {
      (window as unknown as { __viewer?: ViewerHooks }).__viewer!.seek!(95);
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}p493-minigame-playing-${label}.png` });

    // ② 끝 근처 → 자연 재생 → 종료 오버레이 + CTA.
    await page.evaluate(() => {
      const v = (window as unknown as { __viewer?: ViewerHooks }).__viewer!;
      v.seek!(340);
      v.play!();
    });
    await expect(page.getByTestId("minigame-end")).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}p493-minigame-end-${label}.png` });
  });
}
