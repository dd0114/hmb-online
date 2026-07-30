import { expect, test } from "@playwright/test";
import { mockAll } from "./p286-mocks";

/**
 * #286 **W5** — 복수 큐 · 랭킹보드 2종 **계약**. 구현 전에 먼저 박았다(E2E-TDD, 루트 §2-3).
 *
 * ⚠️ **서버보다 web 이 먼저 나간다.** 이 화면들이 쓰는 API 5종은 아직 서버에 없다(#319 = W4).
 * 계약이 `docs/plan-v5/home-nav.md` §5 에 응답 형상까지 프리즈돼 있어 기다릴 이유가 없어서
 * 목으로 먼저 만든다 — 대신 **부재가 라이브를 깨지 않는 것**이 첫 번째 계약이다.
 *
 * ⚠️ **복수는 일부러 닫아 둔 문을 다시 여는 기능이다**(설계 §4.1 — V22 가 지목 원정을 어뷰징
 * 경로로 명시하며 닫았다). 그래서 "되는 것"보다 **"안 되는 것과 그 이유"** 를 더 많이 태운다.
 *
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5292 npx playwright test p286-w5-revenge-rankings.spec.ts
 */

const OPP = (n: number) => ({ userId: `u${n}`, nickname: `FC 상대${n}`, rating: 1200 + n });

const REVENGE = {
  entries: [
    {
      reportId: "R1", opponent: OPP(1), attackedAt: "2026-07-29T03:12:00Z",
      theirScore: 3, myScore: 1, defenceResult: "LOSS", ratingDelta: -10,
      attemptsUsed: 0, attemptsMax: 2, state: "AVAILABLE",
    },
    {
      reportId: "R2", opponent: OPP(2), attackedAt: "2026-07-29T04:00:00Z",
      theirScore: 2, myScore: 2, defenceResult: "DRAW", ratingDelta: 0,
      attemptsUsed: 2, attemptsMax: 2, state: "EXHAUSTED",
    },
    {
      reportId: "R3", opponent: OPP(3), attackedAt: "2026-07-29T05:00:00Z",
      theirScore: 0, myScore: 4, defenceResult: "WIN", ratingDelta: 8,
      attemptsUsed: 1, attemptsMax: 2, state: "AVENGED",
    },
  ],
  remainingToday: 4,
};

const AWAY_RANKINGS = {
  seasonNo: 3,
  entries: [
    { rank: 1, userId: "u3", nickname: "철벽 유나이티드", rating: 1620, streak: 9, isMe: false },
    { rank: 2, userId: "me", nickname: "감독 박", rating: 1180, streak: 2, isMe: true },
  ],
  me: { rank: 12, rating: 1180, streak: 2, total: 143 },
};

const LEAGUE_RANKINGS = {
  entries: [
    { rank: 1, userId: "u7", nickname: "감독 최", division: 1, divisionName: "다이아 리그", points: 52, played: 18, isMe: false },
  ],
  me: { rank: 38, division: 5, points: 18, total: 143 },
};

const json = (body: unknown, status = 200) => ({
  status, contentType: "application/json", body: JSON.stringify(body),
});

/** W5 신규 API 를 목킹한다. `null` 을 주면 그 엔드포인트는 **없는 것처럼**(404) 둔다. */
async function mockW5(
  page: import("@playwright/test").Page,
  opts: { revenge?: unknown; awayRankings?: unknown; leagueRankings?: unknown } = {},
) {
  const route = async (path: string, body: unknown) => {
    await page.route(
      (url) => url.pathname === path,
      (r) => (body === null ? r.fulfill(json({ code: "NOT_FOUND", message: "no" }, 404)) : r.fulfill(json(body))),
    );
  };
  await route("/api/away/revenge", opts.revenge ?? null);
  await route("/api/away/rankings", opts.awayRankings ?? null);
  await route("/api/league/rankings", opts.leagueRankings ?? null);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

// ── 부재가 라이브를 깨지 않는다 (W4 전 배포 안전) ────────────────────────
test("서버에 API 가 없어도 원정·리그 화면이 멀쩡하다 — 구역만 사라진다", async ({ page }) => {
  /**
   * ⚠️ **이 계약이 이 파일에서 제일 중요하다.** web 이 서버보다 먼저 나가므로, 실패한 조회가
   * 스켈레톤·에러 토스트로 새 나가면 **유저는 앱이 고장 났다고 읽는다**. 아직 없는 기능은
   * 조용히 없는 편이 정직하다.
   */
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await mockAll(page);
  await mockW5(page); // 전부 404

  await page.goto("/away");
  await page.getByTestId("away-page").waitFor();
  await expect(page.getByTestId("revenge-queue")).toHaveCount(0);
  await expect(page.getByTestId("ranking-away")).toHaveCount(0);
  // 원래 있던 것은 그대로다.
  await expect(page.getByTestId("away-start")).toBeVisible();

  await page.goto("/league");
  await page.getByTestId("league-dashboard").waitFor();
  await expect(page.getByTestId("ranking-league")).toHaveCount(0);
  await expect(page.getByTestId("standings")).toBeVisible();

  expect(errors, `JS 에러가 났다: ${errors.join(" / ")}`).toEqual([]);
});

test("200 인데 모양이 아닌 응답(구 서버 {})도 흰 화면을 만들지 않는다", async ({ page }) => {
  // #245·#251 전례 — `data.entries.map` 을 바로 부르면 그 순간 화면이 통째로 죽는다.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await mockAll(page);
  await mockW5(page, { revenge: {}, awayRankings: {}, leagueRankings: {} });

  await page.goto("/away");
  await page.getByTestId("away-page").waitFor();
  await expect(page.getByTestId("revenge-queue")).toHaveCount(0);

  await page.goto("/league");
  await page.getByTestId("standings").waitFor();
  expect(errors).toEqual([]);
});

// ── 복수 큐 — 규칙이 화면에 보인다 ──────────────────────────────────────
test("복수 큐가 상태별로 갈리고, 막힌 이유를 말한다", async ({ page }) => {
  await mockAll(page);
  await mockW5(page, { revenge: REVENGE });
  await page.goto("/away");

  const rows = page.getByTestId("revenge-row");
  await expect(rows).toHaveCount(3);

  // ① 도전 가능
  await expect(rows.nth(0).getByTestId("revenge-start")).toBeEnabled();
  // ② 2회 소진 — **왜 막혔는지**가 화면에 있어야 한다(비활성 버튼만 두면 유저가 이유를 못 찾는다)
  await expect(rows.nth(1).getByTestId("revenge-start")).toBeDisabled();
  await expect(rows.nth(1).getByTestId("revenge-reason")).toContainText("2회");
  // ③ 이미 복수함 — hero 확정 "복수의 복수는 없다"
  await expect(rows.nth(2).getByTestId("revenge-start")).toBeDisabled();
  await expect(rows.nth(2).getByTestId("revenge-reason")).toContainText("복수 완료");

  // 남은 횟수는 **원정과 공유**다(hero Q3-②) — 따로 세면 복수로 무한 재도전이 열린다.
  await expect(page.getByTestId("revenge-remaining")).toContainText("4");
});

test("그때 점수는 **내 관점**으로 그린다 — 뒤집으면 이긴 경기를 진 것으로 읽는다", async ({ page }) => {
  await mockAll(page);
  await mockW5(page, { revenge: REVENGE });
  await page.goto("/away");

  const rows = page.getByTestId("revenge-row");
  // R1: myScore 1 : theirScore 3, 내가 막지 못했다.
  await expect(rows.nth(0).getByTestId("revenge-summary")).toContainText("1 : 3");
  // R3: 내가 4:0 으로 막아냈다 — 무승부·승리도 침공으로 치는 것이 hero 확정이라 큐에 남는다.
  await expect(rows.nth(2).getByTestId("revenge-summary")).toContainText("4 : 0");
  await expect(rows.nth(1).getByTestId("revenge-summary")).toContainText("무승부");
});

test("일일 횟수를 다 쓰면 도전 가능한 건도 잠기고 이유를 말한다", async ({ page }) => {
  await mockAll(page);
  await mockW5(page, { revenge: { ...REVENGE, remainingToday: 0 } });
  await page.goto("/away");

  const first = page.getByTestId("revenge-row").nth(0);
  await expect(first.getByTestId("revenge-start")).toBeDisabled();
  await expect(first.getByTestId("revenge-reason")).toContainText("오늘");
});

test("복수 실패는 서버 코드마다 다른 말을 한다", async ({ page }) => {
  // ⚠️ 전부 같은 문구로 뭉개면 유저가 다음 행동을 고를 수 없다(2회 소진 vs 일일 한도는 다른 일이다).
  await mockAll(page);
  await mockW5(page, { revenge: REVENGE });
  await page.route(
    (url) => url.pathname === "/api/away/revenge/R1/matches",
    (r) => r.fulfill(json({ code: "REVENGE_NOT_OWNED", message: "not yours" }, 403)),
  );
  await page.goto("/away");
  await page.getByTestId("revenge-row").nth(0).getByTestId("revenge-start").click();

  // ErrorToast 는 testid 대신 `role="alert"` 로 잡는다(공용 컴포넌트가 그렇게 생겼다).
  await expect(page.getByRole("alert")).toContainText("나를 상대로 한 원정이 아닙니다");
});

// ── 랭킹보드 — 두 랭킹이 한 컴포넌트를 쓴다 ─────────────────────────────
test("원정 랭킹은 레이팅·연승을, 리그 랭킹은 승점·경기수를 그린다", async ({ page }) => {
  await mockAll(page);
  await mockW5(page, { awayRankings: AWAY_RANKINGS, leagueRankings: LEAGUE_RANKINGS });

  await page.goto("/away");
  const away = page.getByTestId("ranking-away");
  await expect(away).toBeVisible();
  await expect(away).toContainText("1620");
  await expect(away).toContainText("9연승");
  await expect(page.getByTestId("ranking-away-me")).toContainText("12위");
  await expect(page.getByTestId("ranking-away-me")).toContainText("143명");
  // 내 행은 색 하나가 아니라 별도 표식으로도 잡힌다(적록색약 — #262 규율).
  await expect(page.getByTestId("ranking-away-row-me")).toBeVisible();

  await page.goto("/league");
  const league = page.getByTestId("ranking-league");
  await expect(league).toBeVisible();
  await expect(league).toContainText("52점");
  await expect(league).toContainText("18경기");
  await expect(league).toContainText("다이아 리그");
});

test("순위가 없으면 지어내지 않는다 — 그 사실을 말한다", async ({ page }) => {
  await mockAll(page);
  await mockW5(page, { awayRankings: { entries: [], me: { total: 143 } } });
  await page.goto("/away");

  await expect(page.getByTestId("ranking-away-me")).toContainText("아직 순위에 오르지 않았습니다");
});
