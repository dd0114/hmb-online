import { expect, test, type Page } from "@playwright/test";

/**
 * #249 오토 모드 — 감독시간 없이 전반→후반 즉시. **web 쪽 계약**만 여기서 본다:
 *
 *  ① 오토 토글이 **경기 시작 전(브리핑)과 전반 경기 중** 둘 다에 있다(hero 요구 1)
 *  ② 오토 ON 매치는 감독 패널이 **뜨지 않는다** — 서버의 0초 감독시간이 한 프레임 보여도(hero 요구 2)
 *  ③ 중간에 풀면 정상 흐름 — 감독 패널이 그대로 열린다(hero 요구 3)
 *  ④ 경합: 토글 요청이 도는 사이 서버가 이미 후반을 열어 응답하면 화면이 그 응답을 따라간다
 *
 * 흐름 자체(전이·인풋 승계)는 서버 계약이다({@code MatchAutoModeTest}) — 여기서 재판정하지 않는다.
 * API 는 **전면 목킹**한다(라이브/데모 백엔드 무접촉). 라우트는 pathname 술어로 — glob 이면 vite
 * 소스까지 잡혀 흰 화면이 된다.
 */

const MATCH_ID = "m-p249";

const DECK = {
  formation: "4-3-3",
  slots: Array.from({ length: 11 }, (_, i) => ({
    slotIndex: i,
    playerId: `p${i + 1}`,
    role: "starter" as const,
  })),
};
const PLAYERS = Array.from({ length: 11 }, (_, i) => ({
  id: `p${i + 1}`,
  name: `선수${i + 1}`,
  position: i === 0 ? "GK" : "MF",
  grade: "B",
}));

type Detail = Record<string, unknown>;

/**
 * 목 서버. `state.detail` 을 바꾸면 다음 폴링부터 그 값이 내려간다.
 * `POST /auto` 는 진짜 서버처럼 **응답이 SoT** 다 — `autoResponse` 로 서버가 무엇을 돌려줄지 정한다.
 */
async function mockApi(
  page: Page,
  state: { detail: Detail; autoResponse?: (auto: boolean, cur: Detail) => Detail },
) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();

    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false },
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/auto`) {
      const body = route.request().postDataJSON() as { auto: boolean };
      state.detail = state.autoResponse
        ? state.autoResponse(body.auto, state.detail)
        : { ...state.detail, auto: body.auto };
      return route.fulfill({ json: state.detail });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill({ json: state.detail });
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) {
      return route.fulfill({ json: { tickSnapshots: [], events: [] } });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    if (url.pathname === "/api/relations") return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
}

function detailFor(over: Detail = {}): Detail {
  return {
    id: MATCH_ID,
    state: "FIRST_HALF",
    auto: false,
    scoreH1Home: null,
    scoreH1Away: null,
    scoreHome: null,
    scoreAway: null,
    result: null,
    createdAt: "2026-07-29T04:00:00Z",
    opponent: { name: "봇 FC", analysisText: "균형", deck: [] },
    clock: {
      phase: "FIRST_HALF",
      kickoffAt: "2026-07-29T04:00:00.000Z",
      phaseStartAt: "2026-07-29T04:00:00.000Z",
      phaseEndsAt: "2026-07-29T04:07:00.000Z",
      serverNow: "2026-07-29T04:01:00.000Z",
      halfRealMs: 420000,
      halftimeMs: 180000,
      seekForwardBlocked: true,
      seekGraceMs: 1500,
    },
    ...over,
  };
}

async function open(page: Page, state: { detail: Detail; autoResponse?: (a: boolean, c: Detail) => Detail }) {
  await mockApi(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe("#249 오토 모드 — web 계약", () => {
  // ── ① 토글이 두 자리에 있다 ───────────────────────────────────────────

  test("a. 경기 시작 전(브리핑)에 오토를 켤 수 있다", async ({ page }) => {
    const state = { detail: detailFor({ state: "BRIEFING", clock: null }) };
    await open(page, state);

    const sw = page.getByTestId("auto-mode-switch");
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute("data-auto", "off");
    // 문구는 상태가 아니라 다음에 일어날 일을 말한다.
    await expect(page.getByTestId("auto-mode-hint")).toContainText("감독시간");

    await sw.click();
    await expect(sw).toHaveAttribute("data-auto", "on");
    await expect(page.getByTestId("auto-mode-hint")).toContainText("감독시간 없이");
  });

  test("b. 전반 경기 중에도 스코어바에서 켜고 끌 수 있다 (390px 에서 보인다)", async ({ page }) => {
    const state = { detail: detailFor() };
    await open(page, state);

    const pill = page.getByTestId("auto-mode-pill");
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("data-auto", "off");

    await pill.click();
    await expect(pill).toHaveAttribute("data-auto", "on");
    await pill.click();
    await expect(pill).toHaveAttribute("data-auto", "off"); // hero 요구 3 — 다시 풀 수 있다
  });

  test("c. 감독시간 화면엔 토글이 없다 — [후반 시작]이 같은 일을 하므로 컨트롤이 둘이 되면 안 된다", async ({
    page,
  }) => {
    const state = { detail: detailFor({ state: "HALFTIME", scoreH1Home: 1, scoreH1Away: 0, auto: false }) };
    await open(page, state);

    await expect(page.getByTestId("halftime-panel")).toBeVisible();
    await expect(page.getByTestId("auto-mode-pill")).toHaveCount(0);
    await expect(page.getByTestId("auto-mode-switch")).toHaveCount(0);
  });

  // ── ② 오토면 감독 패널이 뜨지 않는다 ──────────────────────────────────

  test("d. 오토 ON 이면 서버가 HALFTIME 을 한 프레임 내려줘도 감독 패널이 뜨지 않는다", async ({ page }) => {
    // 서버의 0초 감독시간이 폴링에 잡힌 순간을 그대로 재현한다(phaseEndsAt == phaseStartAt).
    const state = {
      detail: detailFor({
        state: "HALFTIME",
        auto: true,
        scoreH1Home: 1,
        scoreH1Away: 0,
        clock: {
          phase: "HALFTIME",
          kickoffAt: "2026-07-29T04:00:00.000Z",
          phaseStartAt: "2026-07-29T04:07:00.000Z",
          phaseEndsAt: "2026-07-29T04:07:00.000Z",
          serverNow: "2026-07-29T04:07:00.500Z",
          halfRealMs: 420000,
          halftimeMs: 180000,
          seekForwardBlocked: true,
          seekGraceMs: 1500,
        },
      }),
    };
    await open(page, state);

    await expect(page.getByTestId("stage-shell")).toBeVisible();
    await expect(page.getByTestId("halftime-panel")).toHaveCount(0);
  });

  test("e. 회귀 — 오토가 아니면 같은 상태에서 감독 패널이 그대로 열린다", async ({ page }) => {
    const state = { detail: detailFor({ state: "HALFTIME", auto: false, scoreH1Home: 1, scoreH1Away: 0 }) };
    await open(page, state);

    await expect(page.getByTestId("halftime-panel")).toBeVisible();
  });

  // ── ④ 경합 ───────────────────────────────────────────────────────────

  test("f. 경합 — 토글이 도는 사이 서버가 이미 후반을 열었으면 화면이 그 응답을 따라간다", async ({ page }) => {
    // 유저가 전반 막바지에 눌렀는데 그 사이 경계가 넘어간 경우. 서버는 그 자리에서 후반을 연다.
    const state = {
      detail: detailFor(),
      autoResponse: (auto: boolean, cur: Detail) =>
        auto ? { ...cur, auto: true, state: "GEN2", clock: null } : { ...cur, auto },
    };
    await open(page, state);

    await page.getByTestId("auto-mode-pill").click();

    // 관전 셸을 벗어나 후반 준비 화면으로 간다(hero 컨펌 Q4 = 현행 유지). 토글은 사라진다 —
    // 되돌릴 수 없는 상태에서 죽은 버튼을 남기지 않는다.
    await expect(page.getByTestId("match-state")).toHaveText("GEN2");
    await expect(page.getByTestId("auto-mode-pill")).toHaveCount(0);
    await expect(page.getByTestId("auto-mode-switch")).toHaveCount(0);
  });
});
