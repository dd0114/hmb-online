import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { skipSplash } from "./splash-mock";

/**
 * #493 W3 실화면 캡처 — AC8 증빙(계약 아님). 행동 보상 5종이 **기존 우편함 UX**(뱃지·[받기]·
 * 잔액 반영)로 수령되는 그림. 우편 모양은 서버 `UxActionRewardService` 캠페인 행(제목·GEM 300)
 * 을 그대로 미러한다(#342 규율 — 목은 서버 형상).
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5287 npx playwright test --config=playwright.capture.config.ts e2e/p493-reward-mail.capture.ts
 */
const OUT = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** 서버 UxAction enum 의 제목 그대로. */
const TITLES = [
  "튜토리얼 완주 보상",
  "첫 경기 결과 확인 보상",
  "첫 스쿼드 저장 보상",
  "첫 뽑기 보상",
  "첫 트레이드 보상",
];

const mailOf = (i: number, claimed: boolean) => ({
  id: `M493-${i}`,
  title: TITLES[i],
  body: "행동 보상이 도착했습니다. 받아 주세요.",
  attachments: { points: 0, gems: 300, players: [] },
  sentAt: "2026-08-11T00:00:00Z",
  expiresAt: null,
  readAt: claimed ? "2026-08-11T01:00:00Z" : null,
  claimedAt: claimed ? "2026-08-11T01:00:00Z" : null,
  state: claimed ? "CLAIMED" : "UNREAD",
});

test("#493 행동 보상 우편 캡처 — 390×844", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });

  let claimedFirst = false;
  let gems = 6000;
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: "u493m", nickname: "보상감독", tutorialDone: true },
          wallet: { points: 3000, gems },
          records: { wins: 1, draws: 0, losses: 0 },
          mail: { unread: claimedFirst ? 4 : 5 },
        }),
      ),
  );
  await page.route(
    (url) => url.pathname === "/api/mails",
    (route) =>
      route.fulfill(json({ mails: TITLES.map((_, i) => mailOf(i, i === 0 && claimedFirst)), unread: claimedFirst ? 4 : 5 })),
  );
  await page.route(
    (url) => url.pathname === "/api/mails/M493-0/claim",
    (route) => {
      claimedFirst = true;
      gems += 300;
      return route.fulfill(json({ applied: true, wallet: { points: 3000, gems } }));
    },
  );
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_mail"));
  await skipSplash(page);

  // 홈 헤더 — 우편 뱃지(할 일 5)가 보이는 상태.
  await page.goto("/home");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}p493-reward-home-badge-phone.png` });

  // 우편함 — 행동 보상 5통.
  await page.getByTestId("mail-center-open").click();
  await expect(page.getByText("튜토리얼 완주 보상")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}p493-reward-mailbox-phone.png` });

  // 첫 통 [받기] → 수령 완료 + 잔액 반영.
  await page.getByText("튜토리얼 완주 보상").click();
  await page.waitForTimeout(200);
  await page.getByTestId("mail-claim").first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}p493-reward-claimed-phone.png` });
});
