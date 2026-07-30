import { expect, test } from "@playwright/test";
import { mockAll, LEAGUE } from "./p286-mocks";

/**
 * #286 **W5a** — 리그 페이지의 **API 무의존분** 계약. 구현 전에 먼저 박았다(E2E-TDD, 루트 §2-3).
 *
 * W5 본편(리그·원정 랭킹보드, 복수 큐, 모드별 전적)은 서버 신규 API 5종(#319 = W4)에 물려 있다.
 * 그런데 설계 §3.2 가 요구하는 것 중 **기존 `/api/league` 만으로 되는 것 두 개**가 있다:
 *
 *   (A) 시즌 없음 — `리그란?` 설명 + **하는 방법 3스텝**. 지금은 한 줄 설명뿐이라 처음 온 유저가
 *       "18라운드"가 무슨 뜻인지, 뭘 하면 되는지 알 수 없다. 원정 페이지엔 이미 있는 형식이다.
 *   (B) 진행 중 — **라운드 진행바(`N / 18`)**. 게임 탭 카드는 이미 `10 / 18 라운드` 를 보여주는데
 *       정작 리그 화면에 없어서, 들어오면 내가 시즌 어디쯤인지가 사라진다.
 *
 * ⚠️ **둘 다 서버 값만 쓴다.** 라운드를 일정표에서 세어 추정하지 않는다 — 서버가 안 주면 그 줄을
 * 그리지 않는다(#262 BL-1: 클라가 추측한 순간 화면이 서버와 반대 사실을 말한다).
 *
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5292 npx playwright test p286-w5a-league.spec.ts
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

// ── (A) 시즌 없음 — 무엇이고 뭘 하면 되나 ────────────────────────────────
test("시즌이 없으면 [리그란?] 설명과 하는 방법 3스텝이 있다", async ({ page }) => {
  await mockAll(page, { league: "none" });
  await page.goto("/league");
  await page.getByTestId("league-start-cta").waitFor();

  const guide = page.getByTestId("league-guide");
  await expect(guide).toBeVisible();
  // 원정 페이지와 같은 형식(설명 + 3스텝) — 두 모드의 안내가 갈라지면 유저가 매번 다시 배운다.
  await expect(guide.locator("li")).toHaveCount(3);

  // 시작 버튼은 그대로 살아 있어야 한다(설명이 CTA 를 밀어내면 안 된다).
  await expect(page.getByTestId("start-league")).toBeVisible();
});

// ── (B) 진행 중 — 내가 시즌 어디쯤인가 ──────────────────────────────────
test("시즌 진행 중이면 라운드 진행바가 서버 값으로 뜬다", async ({ page }) => {
  await mockAll(page); // LEAGUE = currentRound 10 / totalRounds 18
  await page.goto("/league");
  await page.getByTestId("league-dashboard").waitFor();

  const progress = page.getByTestId("league-round-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("10");
  await expect(progress).toContainText("18");

  /**
   * 값이 아니라 **비율**이 서버를 따라오는지 본다 — 숫자만 맞고 막대가 고정이면 의미가 없다.
   * ⚠️ 문자열로 단언하지 마라: 브라우저가 `style.width` 를 반올림해 돌려준다(`55.5556%`).
   * 계산식이 옳은지를 보는 것이지 브라우저의 출력 형식을 보는 게 아니다.
   */
  const filled = await page
    .getByTestId("league-round-bar")
    .evaluate((el) => parseFloat((el as HTMLElement).style.width));
  expect(filled, `막대 폭이 10/18 을 반영해야 한다 (실제=${filled}%)`).toBeCloseTo((10 / 18) * 100, 2);
});

test("서버가 라운드를 주지 않으면 진행바를 그리지 않는다", async ({ page }) => {
  /**
   * ⚠️ 구 서버·부분 응답 대비. 여기서 일정표를 세어 추정하면 **화면이 서버와 다른 말을 한다**
   * (#262 BL-1 과 같은 부류). 모르면 그 줄을 안 그리는 것이 정답이고, 순위표·다음 경기는 그대로다.
   */
  const noRound = {
    ...LEAGUE,
    season: { ...LEAGUE.season, currentRound: undefined, totalRounds: undefined },
  };
  await mockAll(page, { leagueOverride: noRound });
  await page.goto("/league");
  await page.getByTestId("league-dashboard").waitFor();

  await expect(page.getByTestId("league-round-progress")).toHaveCount(0);
  // 화면이 죽지는 않는다 — 순위표는 그대로다(#262 의 "필드 부재 → 그 UI 만 소멸" 규율).
  await expect(page.getByTestId("standings")).toBeVisible();
  await expect(page.getByTestId("standings").locator("tbody tr")).toHaveCount(10);
});
