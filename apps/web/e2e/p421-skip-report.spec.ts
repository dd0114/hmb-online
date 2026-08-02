import { expect, test, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #421 W2 — **경기 스킵 → 하프 리포트 → 닫으면 다음 단계**를 백엔드 없이 route-mock 으로 박제한다.
 *
 * 계약(hero 요구):
 *  1. 경기 화면에 스킵 버튼이 있고, 누르면 경기 장면을 건너뛴다.
 *  2. 스킵하면 **결과 중 중요 내용 리포트가 공지사항처럼** 뜬다(골·카드 타임라인 1장 + 최고 평점 1장).
 *  3. **닫으면 바로 다음** — 전반이면 감독시간(기존 [후반 시작]), 후반이면 결과 화면.
 *
 * 서버 계약(W1, `POST /api/matches/{id}/skip`)에서 이 스펙이 지키는 것:
 *  · 바디 `phase` 는 **필수이고 CAS 키다** — 화면이 지금 보고 있는 단계를 그대로 보내야 한다.
 *    (안 보내거나 틀리게 보내면 서버가 400/409 로 막지만, 그 전에 화면이 옳아야 한다.)
 *  · **409 는 에러가 아니다** — "이미 넘어갔다"이므로 토스트가 아니라 재조회로 따라간다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면.
 */

const MATCH_ID = "m-p421";
const LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
) as { events: { tick: number; minute: number; type: string; team?: string; playerId?: string; detail?: string }[] };

const GOALS = LOG.events.filter((e) => e.type === "goal");
const CARDS = LOG.events.filter((e) => e.type === "card");
/** 리포트에 실려야 할 줄 수 = 골 + 카드(이 픽스처엔 경고 누적 퇴장이 없어 병합 대상이 없다). */
const ROW_COUNT = GOALS.length + CARDS.length;
/** 이 로그 한 하프의 골 수. 목 서버의 확정 스코어를 **여기서 파생**해 두 축이 어긋나지 않게 한다. */
const HALF = {
  home: GOALS.filter((g) => g.team === "home").length,
  away: GOALS.filter((g) => g.team === "away").length,
};

/** 카탈로그는 로그의 선수 id 를 그대로 덮는다 — 이름이 안 붙으면 그 자리가 빈다. */
const PLAYERS = [...new Set(LOG.events.map((e) => e.playerId).filter(Boolean))].map((id, i) => ({
  id,
  name: `선수${i + 1}`,
  position: "MF",
  grade: "B",
}));
const DECK = {
  formation: "4-3-3",
  slots: PLAYERS.slice(0, 11).map((p, i) => ({ slotIndex: i, playerId: p.id, role: "starter" as const })),
};

interface Harness {
  /** 서버가 들고 있는 현재 매치 상태(스킵 응답으로 바뀐다). */
  state: string;
  /** 스킵 요청 바디 기록 — `phase` 계약의 증거. */
  skips: unknown[];
  /** 다음 스킵 요청에 409 를 돌려준다(스위퍼가 먼저 경계를 밟은 경합). */
  skipConflict: boolean;
  /** 409 뒤 서버가 실제로 가 있는 상태. */
  conflictState: string;
}

function detailOf(h: Harness) {
  const finished = h.state === "FINISHED";
  return {
    id: MATCH_ID,
    state: h.state,
    // 전반이 끝나기 전에는 서버가 확정 스코어를 내려주지 않는다(스포일러 금지 계약).
    scoreH1Home: h.state === "FIRST_HALF" ? null : HALF.home,
    scoreH1Away: h.state === "FIRST_HALF" ? null : HALF.away,
    scoreHome: finished ? HALF.home * 2 : null,
    scoreAway: finished ? HALF.away * 2 : null,
    result: finished ? "WIN" : null,
    auto: false,
    createdAt: "2026-08-02T09:00:00Z",
    opponent: { name: "봇 FC" },
  };
}

async function mockApi(page: Page, h: Harness) {
  await page.route("**/*", async (route) => {
    const req: Request = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();

    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/skip`) {
      h.skips.push(req.postDataJSON());
      if (h.skipConflict) {
        // 서버는 이미 다음 단계로 가 있다 — 화면이 재조회로 따라가야 한다.
        h.state = h.conflictState;
        return route.fulfill({
          status: 409,
          json: { code: "INVALID_STATE", message: "이미 다음 단계입니다" },
        });
      }
      h.state = h.state === "FIRST_HALF" ? "HALFTIME" : "FINISHED";
      return route.fulfill({ json: detailOf(h) });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill({ json: detailOf(h) });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: { matchId: MATCH_ID, result: "WIN", scoreHome: 4, scoreAway: 2, rewardPoints: 500 },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: LOG });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    if (url.pathname === "/api/me/active-match") {
      return route.fulfill({ json: { match: detailOf(h), locked: true, abandonable: false } });
    }
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, state: string, over: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = { state, skips: [], skipConflict: false, conflictState: "HALFTIME", ...over };
  await mockApi(page, h);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
  await page.locator(`[data-testid="viewer-canvas-half${state === "SECOND_HALF" ? 2 : 1}"]`).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  return h;
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe("#421 스킵 버튼 · 하프 리포트", () => {
  test("픽스처 신선도 — 골·카드가 없으면 이 스펙은 아무것도 증명하지 못한다", () => {
    expect(GOALS.length, "데모 로그에 골이 있어야 타임라인 카드가 의미를 갖는다").toBeGreaterThanOrEqual(2);
    expect(CARDS.length, "카드 기록도 리포트의 요구(골·카드 타임라인)다").toBeGreaterThanOrEqual(1);
  });

  test("a. 전반 재생 중 스킵 버튼이 무대에 있다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    const skip = page.getByTestId("match-skip");
    await expect(skip).toBeVisible();
    await expect(skip).toHaveAttribute("data-phase", "FIRST_HALF");
    // 유저 주 액션이다 — 무대 오버레이의 QA 칩 크기(11px)로 줄어들면 폰에서 못 누른다.
    const box = await skip.boundingBox();
    expect(box?.height ?? 0, "터치 타깃 높이").toBeGreaterThanOrEqual(32);

    // ⚠️ **#216 계약을 내가 깨지 않는다**: 플레이 모드 *재생 컨트롤 바*는 여전히 버튼 0개다.
    // 스킵은 재생 조작이 아니라 경기 흐름 액션이라 바 **밖**(같은 오버레이 층)에 선다.
    const barButtons = await page.getByTestId("viewer-controls-half1").locator("button").count();
    expect(barButtons, "재생 컨트롤 바에는 여전히 버튼이 없다(matchui-controls-mock 계약)").toBe(0);
  });

  test("b. 누르면 `phase` 를 실어 스킵을 요청하고 리포트가 뜬다", async ({ page }) => {
    const h = await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();

    await expect(page.getByTestId("half-report")).toBeVisible();
    expect(h.skips, "스킵 요청은 정확히 1회").toHaveLength(1);
    expect(h.skips[0], "phase 는 CAS 키다 — 지금 보고 있는 단계를 그대로 보낸다").toEqual({
      phase: "FIRST_HALF",
    });

    // 공지 팝업과 같은 다이얼로그 셸(role/aria) — 접근성을 새로 만들지 않았다는 증거.
    const dialog = page.getByTestId("half-report");
    await expect(dialog).toHaveAttribute("role", "dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(page.getByTestId("half-report-title")).toHaveText("전반 리포트");
  });

  test("c. 리포트는 골·카드 타임라인이다 — 표기 분·라벨·팀이 붙는다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();

    const rows = page.locator('[data-testid="half-report-timeline"] li[data-kind]');
    await expect(rows).toHaveCount(ROW_COUNT);

    const firstGoal = GOALS[0]!;
    const row = page.getByTestId(`half-report-row-${firstGoal.tick}`);
    // 시각은 **로그가 구운 minute** 이다(틱 직독이면 정확히 절반이 나온다, #388).
    await expect(row).toContainText(`${firstGoal.minute}'`);
    await expect(row).toContainText("골!");
    await expect(row).toContainText(firstGoal.team === "home" ? "테스터" : "봇 FC");

    const firstCard = CARDS[0]!;
    await expect(page.getByTestId(`half-report-row-${firstCard.tick}`)).toContainText("옐로카드");

    // 전반 리포트는 앞에 끝난 하프가 없으므로 이 하프의 골이 곧 스코어다.
    await expect(page.getByTestId("half-report-score")).toHaveText(
      `테스터 ${HALF.home} : ${HALF.away} 봇 FC`,
    );
  });

  /**
   * ⚠️ **이 계약은 후반에서만 실효가 있다.** 전반 스킵은 응답이 `HALFTIME` 이라 무대가 어차피
   * 탭으로 내려가고(#244 `managing`), 그래서 전반만 단언하면 **셸의 리포트 가드를 지워도 통과한다**
   * (변이체 검증에서 실제로 살아남았다). 후반 스킵은 `FINISHED` = 무대가 상시인 상태라, 가드가
   * 없으면 팝업 **뒤에서 캔버스가 계속 돈다**. 두 하프를 다 태운다.
   */
  test("d. 리포트 뒤에서 경기 장면이 계속 돌지 않는다(후반 = 무대 상시 상태 포함)", async ({ page }) => {
    await openMatch(page, "SECOND_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();
    // 무대가 아예 마운트돼 있지 않다(정지 플래그가 아니라 구조적 보장 — cleanup 이 v.stop() 을 부른다).
    await expect(page.getByTestId("stage-canvas")).toHaveCount(0);
    await expect(page.locator('[data-testid="viewer-canvas-half2"]')).toHaveCount(0);

    // 닫으면 무대가 돌아온다(가드가 화면을 영구히 뺏지 않는다).
    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("stage-canvas")).toBeVisible();
  });

  test("d2. 전반 스킵에서도 리포트 뒤에 캔버스가 없다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();
    await expect(page.locator('[data-testid="viewer-canvas-half1"]')).toHaveCount(0);
  });

  test("e. 평점 모듈(#403) 머지 전에는 스택이 1장이다 — 빈 카드·유령 페이저가 없다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();

    await expect(page.getByTestId("half-report-pager")).toHaveCount(0);
    await expect(page.getByTestId("half-report-dots")).toHaveCount(0);
    await expect(page.getByTestId("half-report-behind-1")).toHaveCount(0);
    await expect(page.getByTestId("half-report-next")).toHaveText("닫기");
  });

  test("f. 닫으면 바로 감독시간 — 기존 [후반 시작] 동선으로 이어진다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();
    await page.getByTestId("half-report-next").click();

    await expect(page.getByTestId("half-report")).toHaveCount(0);
    await expect(page.getByTestId("resume-button")).toBeVisible();
    // 감독시간에는 스킵할 재생이 없다 — 버튼이 남아 있으면 409 를 부르는 손잡이가 된다.
    await expect(page.getByTestId("match-skip")).toHaveCount(0);
  });

  test("g. 돌려보는 화면(감독시간 `경기장면` 탭)에는 스킵 버튼이 없다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("resume-button")).toBeVisible();

    await page.getByTestId("stage-tab-stage").click();
    await page.locator('[data-testid="viewer-canvas-half1"]').waitFor({ state: "visible", timeout: 30_000 });
    await expect(page.getByTestId("match-skip")).toHaveCount(0);
  });

  test("h. 후반 스킵 → `SECOND_HALF` phase → 리포트 → 닫으면 결과 화면", async ({ page }) => {
    const h = await openMatch(page, "SECOND_HALF");
    await expect(page.getByTestId("match-skip")).toHaveAttribute("data-phase", "SECOND_HALF");
    await page.getByTestId("match-skip").click();

    await expect(page.getByTestId("half-report")).toBeVisible();
    expect(h.skips[0]).toEqual({ phase: "SECOND_HALF" });
    await expect(page.getByTestId("half-report-title")).toHaveText("후반 리포트");
    // 후반 리포트는 전반 확정 스코어 위에 쌓는다(#233) — 후반만의 점수를 경기 점수로 그리지 않는다.
    await expect(page.getByTestId("half-report-score")).toHaveText(
      `테스터 ${HALF.home * 2} : ${HALF.away * 2} 봇 FC`,
    );
    await expect(page.getByTestId("half-report-score")).not.toHaveText(
      `테스터 ${HALF.home} : ${HALF.away} 봇 FC`,
    );

    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("half-report")).toHaveCount(0);
    await expect(page.getByTestId("result-page")).toBeVisible();
  });

  test("i. 409(이미 넘어갔다)는 에러가 아니다 — 리포트를 열지 않고 상태를 따라간다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF", { skipConflict: true, conflictState: "HALFTIME" });
    await page.getByTestId("match-skip").click();

    // 리포트는 뜨지 않는다(이 요청이 그 하프를 끝낸 게 아니다).
    await expect(page.getByTestId("resume-button")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("half-report")).toHaveCount(0);
    // 화면이 막다른 에러로 끝나지 않는다.
    await expect(page.getByTestId("stage-shell")).toBeVisible();
  });
});
