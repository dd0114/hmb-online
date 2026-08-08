import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loginGuestAndSettleStarter } from "./starter-login";
import { passFlowBridge } from "./flow-bridge";

/**
 * AC-F / W6 리그 시즌 브라우저 E2E — 리그 시작 → 순위표(10팀) → 다음 경기 → **풀 매치 완주**
 * (stub 서번트) → 픽스처 정산·순위 갱신 → 로그 탭 반영까지 한 바퀴를 검증한다.
 *
 * 시즌 18경기 전부는 과하므로 1경기 완주 + 정산 검증까지만 본다(완주는 통합 게이트 옵션).
 * stub AI(ts-servants) + server-java 가 떠 있을 때만 실행되고, 없으면 test.skip 한다(graceful).
 */

// 기본 데모 8080. 격리 스모크(대체 포트)는 HMB_E2E_API_ORIGIN 로 덮어쓴다(8080 무접촉).
const API_ORIGIN = process.env.HMB_E2E_API_ORIGIN ?? "http://localhost:8080";

async function apiLive(request: APIRequestContext): Promise<boolean> {
  try {
    await request.get(`${API_ORIGIN}/internal/health`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** 브라우저 컨텍스트(토큰+프록시)로 owned 선수 11선발+벤치 덱을 저장(리그 next-match 는 활성 덱 요구). */
async function seedDeck(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const token = localStorage.getItem("hmb.auth.token");
    if (!token) return false;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const players: Array<{ id: string; position: string; owned: boolean }> = await (
      await fetch("/api/players", { headers })
    ).json();
    const owned = players.filter((p) => p.owned);
    const gk = owned.find((p) => p.position === "GK");
    if (!gk || owned.length < 11) return false;
    const ordered = [gk, ...owned.filter((p) => p.id !== gk.id)];
    const starters = ordered.slice(0, 11).map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i }));
    const bench = ordered.slice(11, 18).map((p, i) => ({ playerId: p.id, role: "bench", slotIndex: i }));
    const res = await fetch("/api/deck", {
      method: "PUT",
      headers,
      body: JSON.stringify({ formation: "4-4-2", slots: [...starters, ...bench] }),
    });
    return res.ok;
  });
}

/** 유저 순위 행의 '경기(played)' 값. 컬럼: rank, team, played, 승, 무, 패, 득실, 승점. */
async function userPlayed(page: Page): Promise<number> {
  const cell = page.locator('[data-testid="standings"] tr[data-user="true"] td').nth(2);
  await expect(cell).toBeVisible();
  return Number((await cell.textContent())?.trim() ?? "0");
}

/** BRIEFING → 킥오프 → H1_BREAK → (교체 없이) 후반 → FINISHED 결과 화면까지 완주. */
async function completeMatch(page: Page): Promise<void> {
  await expect(page.getByTestId("briefing-panel")).toBeVisible();
  await page.getByTestId("editor-team-prompt").fill("리그 개막전 — 안정적으로 운영");
  await page.getByTestId("kickoff-button").click();

  await expect(page.getByTestId("halftime-panel")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("h1-score")).toBeVisible();
  // 교체 없이 후반 시작(교체는 선택 — 리그 정산 경로 검증에 불필요).
  await page.getByTestId("resume-button").click();

  await expect(page.getByTestId("result-page")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("final-score")).toBeVisible();
}

test("AC-F: 리그 시작 → 순위표 → 다음 경기 완주 → 정산·순위 갱신 → 로그 반영", async ({ page, request }) => {
  test.skip(!(await apiLive(request)), "server-java/ts-servants 미기동 — 통합 게이트에서 실행");
  test.setTimeout(300_000);

  const nickname = `lg_${Date.now().toString(36)}`;

  // 1) 신규 게스트 로그인 + 덱 시드
  await loginGuestAndSettleStarter(page, nickname);
  expect(await seedDeck(page)).toBe(true);

  // 2) 리그 진입 → 시작 CTA(신규 유저 = 시즌 없음)
  await page.goto("/league");
  const startCta = page.getByTestId("start-league");
  if (await startCta.isVisible().catch(() => false)) {
    await startCta.click();
  }

  // 3) 대시보드 — 순위표 10팀 + 유저 행 + 다음 경기 버튼
  await expect(page.getByTestId("league-dashboard")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("standings")).toBeVisible();
  await expect(page.locator('[data-testid="standings"] tbody tr')).toHaveCount(10);
  await expect(page.locator('[data-testid="standings"] tr[data-user="true"]')).toBeVisible();
  await expect(page.getByTestId("season-tag")).toBeVisible();

  const playedBefore = await userPlayed(page);

  // 4) 다음 경기 → 매치 진입 → 완주
  await page.getByTestId("next-match").click();
  await expect(page).toHaveURL(/\/match\//);
  await completeMatch(page);

  // 5) 결과 → 로비 → 다시 리그: 유저 경기 +1 정산 + 유저 픽스처 스코어 확정
  await passFlowBridge(page); // #424 브릿지가 로비 버튼을 덮는다
  await page.getByTestId("to-lobby").click();
  await expect(page).toHaveURL(/\/home$/);

  await page.goto("/league");
  await expect(page.getByTestId("league-dashboard").or(page.getByTestId("season-end"))).toBeVisible({
    timeout: 15_000,
  });
  const playedAfter = await userPlayed(page);
  expect(playedAfter, "유저 경기 수가 정산으로 +1 되어야 함").toBe(playedBefore + 1);

  // 유저 픽스처 중 최소 하나가 스코어("N - N")로 확정됐는지(일정 정산 반영 — fixtureScore 포맷).
  const settled = page
    .locator('[data-testid^="fixture-"][data-user="true"]')
    .filter({ hasText: /\d+\s*-\s*\d+/ });
  await expect(settled.first()).toBeVisible();

  // 6) 로그 탭 — 리그 경기 로그가 반영됐는지(라운드 태그 + 내 스코어)
  await page.goto("/logs");
  await page.getByTestId("logs-tab-matches").click();
  await page.getByTestId("filter-mode-league").click();
  const leagueRow = page.locator('[data-testid^="match-log-"]');
  await expect(leagueRow.first()).toBeVisible({ timeout: 15_000 });
});
