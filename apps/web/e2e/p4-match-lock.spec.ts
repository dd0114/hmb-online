import { expect, test, type Page } from "@playwright/test";

/**
 * 매치 잠금·재입장 E2E (이슈 #217) — **route-mock 전용**(백엔드/데모 8080 무접촉).
 *
 * hero 제보 그대로를 브라우저에서 재현한다: "경기 도중 뒤로 나가면 끝" → 어디로 가든 경기로
 * 돌아오는가. 그리고 그 잠금이 스스로를 가두지 않는가(AC3).
 *
 *  · AC1 — 진행 중(킥오프 이후) 매치가 있으면 /lobby·/deck 진입이 /match/:id 로 돌아간다.
 *          **새로고침·재로그인도 동일** — 판정 입력이 서버 응답뿐이라 로컬 상태가 없다.
 *  · AC2 — 브리핑 매치가 있으면 [게임 시작]→[연습 경기]가 409 를 받고, 에러 문구가 아니라
 *          **그 매치로 이어간다**(detail.matchId).
 *  · AC3 — 회수 가능한 사고 매치(FAILED)는 강제 이동을 풀고 로비에 포기 버튼을 준다.
 *          포기하면 잠금이 즉시 풀린다.
 *
 * ⚠️ 라우트 매칭은 glob 이 아니라 **pathname 술어**로 한다 — glob('**\/api/**')은 vite 소스
 *    (/src/api/*.ts)까지 잡아 흰 화면이 된다(p3-tutorial.spec.ts 선례).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const MATCH_ID = "M_LOCKED_1";

type Scenario = "none" | "briefing" | "live" | "failed" | "genStuck";

interface MockState {
  scenario: Scenario;
  createAttempts: number;
  abandonCalls: number;
}

function activeMatchBody(st: MockState) {
  switch (st.scenario) {
    case "briefing":
      return { match: { id: MATCH_ID, state: "BRIEFING", createdAt: "2026-07-27T09:00:00Z" }, locked: false, abandonable: true };
    case "live":
      return { match: { id: MATCH_ID, state: "FIRST_HALF", createdAt: "2026-07-27T09:00:00Z" }, locked: true, abandonable: false };
    case "genStuck":
      // 생성이 멈춘 사고 — 서버가 abandonable 을 연다(잡은 done 인데 전이가 커밋 안 됨).
      return {
        match: { id: MATCH_ID, state: "GEN1", createdAt: "2026-07-27T09:00:00Z" },
        locked: true,
        abandonable: true,
      };
    case "failed":
      return {
        match: { id: MATCH_ID, state: "FAILED", failReason: "ai-job timeout (240s)", createdAt: "2026-07-27T09:00:00Z" },
        locked: true,
        abandonable: true,
      };
    default:
      return { match: null, locked: false, abandonable: false };
  }
}

async function mockApi(page: Page, scenario: Scenario): Promise<MockState> {
  const st: MockState = { scenario, createAttempts: 0, abandonCalls: 0 };

  // catch-all 먼저 — Playwright 는 나중에 등록한 핸들러가 우선한다.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));

  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: { id: "u1", nickname: "감독", isAdmin: false, tutorialDone: true },
        wallet: { points: 1000, gems: 0 },
        records: { wins: 1, draws: 0, losses: 0 },
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json(activeMatchBody(st))),
  );
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/deck", (route) =>
    route.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404)),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));
  // 잠금 전수 검사가 도는 메타 화면들의 최소 응답. catch-all 의 `{}` 를 그대로 받으면 페이지가
  // 렌더 중 터져 트리가 죽고, **게이트가 다시 렌더될 기회 자체가 사라진다**(= 리다이렉트 실패가
  // 잠금 구멍처럼 보인다). 화면이 정상적으로 살아 있는 상태에서 잠금을 봐야 의미가 있다.
  await page.route((url) => url.pathname === "/api/trade", (route) =>
    route.fulfill(json({ slots: [], waitSeconds: 0, wallet: { points: 1000, gems: 0 } })),
  );
  await page.route((url) => url.pathname === "/api/logs/matches", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/logs/trades", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/rankings", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/growth/dice", (route) =>
    route.fulfill(json({ normal: 0, cash: 0 })),
  );
  await page.route((url) => url.pathname === "/api/league", (route) =>
    route.fulfill(json({ season: null })),
  );

  // 매치 상세 — 리다이렉트 도착지가 실제로 그 매치를 그린다는 걸 보기 위해.
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) =>
    route.fulfill(json({ ...activeMatchBody(st).match, opponent: null })),
  );
  await page.route((url) => url.pathname.startsWith(`/api/matches/${MATCH_ID}/halves/`), (route) =>
    route.fulfill(json({ code: "INVALID_STATE", message: "아직" }, 409)),
  );

  await page.route(
    (url) => url.pathname === "/api/matches" ,
    (route) => {
      if (route.request().method() !== "POST") return route.fulfill(json({}));
      st.createAttempts++;
      if (st.scenario === "none") {
        return route.fulfill(json({ id: "M_NEW", state: "BRIEFING", createdAt: "2026-07-27T10:00:00Z" }, 201));
      }
      return route.fulfill(
        json(
          {
            code: "MATCH_IN_PROGRESS",
            message: "진행 중인 경기가 있습니다",
            detail: { matchId: MATCH_ID, state: activeMatchBody(st).match!.state, action: "createMatch" },
          },
          409,
        ),
      );
    },
  );

  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}/abandon`, (route) => {
    st.abandonCalls++;
    st.scenario = "none"; // 서버가 회수했다 — 이후 active-match 는 비어 있다
    return route.fulfill(json({ id: MATCH_ID, state: "ABANDONED", createdAt: "2026-07-27T09:00:00Z" }));
  });

  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok_e2e");
    window.localStorage.setItem("hmb.auth.provider", "guest");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });
  return st;
}

test.describe("#217 AC1 — 진행 중 경기로 되돌아온다", () => {
  test("로비로 들어가도 경기 화면으로 간다 (새로고침·직접 URL 모두)", async ({ page }) => {
    await mockApi(page, "live");

    await page.goto("/lobby");
    await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));

    // 새로고침 = 로컬 상태가 사라져도 같은 답. (판정 입력이 서버 응답뿐이라는 것의 증명)
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));

    // 메타 화면을 **전수로** 노려도 마찬가지. 라우트를 손으로 감싸는 구조라(App.tsx) 하나를
    // 빠뜨려도 유닛 테스트는 green 이다 — 구멍은 여기서만 잡힌다.
    for (const route of ["/deck", "/shop", "/growth", "/codex", "/trade", "/logs", "/league"]) {
      await page.goto(route);
      await expect(page, `${route} 가 잠기지 않았다`).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));
    }
  });

  test("재로그인 직후 루트로 들어와도 경기로 간다", async ({ page }) => {
    await mockApi(page, "live");
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));
  });

  test("진행 중 경기가 없으면 아무 것도 막지 않는다 (과잉 잠금 회귀 가드)", async ({ page }) => {
    await mockApi(page, "none");
    await page.goto("/lobby");
    await expect(page).toHaveURL(/\/lobby$/);
    await expect(page.getByTestId("play-cta")).toBeVisible();
    await expect(page.getByTestId("resume-match-card")).toHaveCount(0);
  });
});

test.describe("#217 AC2 — 경기 중 새 매치 생성 차단", () => {
  test("브리핑 매치가 있으면 [연습 경기]는 409 를 받고 그 경기로 이어간다", async ({ page }) => {
    const st = await mockApi(page, "briefing");

    await page.goto("/lobby");
    // 브리핑은 강제 이동 대상이 아니다 — 로비에 남아 '이어하기'가 보인다.
    await expect(page).toHaveURL(/\/lobby$/);
    await expect(page.getByTestId("resume-match-card")).toBeVisible();

    await page.getByTestId("play-cta").click();
    await page.getByTestId("mode-practice").click();

    await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));
    expect(st.createAttempts, "생성을 실제로 시도했고 409 를 받았다").toBe(1);
  });

  test("리그 [다음 경기]도 409 를 막다른 토스트가 아니라 이어가기로 처리한다", async ({ page }) => {
    const st = await mockApi(page, "briefing");
    await page.route((url) => url.pathname === "/api/league", (route) =>
      route.fulfill(
        json({
          season: {
            id: "S1", seasonNo: 1, state: "ACTIVE",
            teams: [{ teamId: "USER", name: "내 팀", persona: "", power: 70, isUser: true }],
            standings: [], fixtures: [],
            nextUserFixture: {
              id: "F1", round: 1, homeTeam: "USER", awayTeam: "B1",
              isUser: true, state: "SCHEDULED", scoreHome: null, scoreAway: null, matchId: null,
            },
            seasonReward: null,
          },
        }),
      ),
    );
    await page.route((url) => url.pathname === "/api/league/next-match", (route) =>
      route.fulfill(
        json(
          {
            code: "MATCH_IN_PROGRESS",
            message: "진행 중인 경기가 있습니다",
            detail: { matchId: MATCH_ID, state: "BRIEFING", action: "createMatch" },
          },
          409,
        ),
      ),
    );

    await page.goto("/league");
    await expect(page).toHaveURL(/\/league$/); // 브리핑은 강제 이동 대상이 아니라 여기 도달한다
    await page.getByTestId("next-match").click();
    await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));
    expect(st.abandonCalls).toBe(0);
  });

  test("이어하기 버튼이 진행 중 경기로 보낸다", async ({ page }) => {
    await mockApi(page, "briefing");
    await page.goto("/lobby");
    await page.getByTestId("resume-match").click();
    await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));
  });
});

test.describe("#217 AC3 — 영구 잠금 금지", () => {
  test("사고 매치(FAILED)는 강제 이동을 풀고 로비에서 포기할 수 있다", async ({ page }) => {
    const st = await mockApi(page, "failed");

    // 회수 가능한 매치까지 붙잡으면 탈출구(포기 버튼)에 도달할 수 없다 — 그래서 로비가 열려야 한다.
    await page.goto("/lobby");
    await expect(page).toHaveURL(/\/lobby$/);
    await expect(page.getByTestId("resume-match-note")).toContainText("포기");

    await page.getByTestId("abandon-match").click();
    expect(st.abandonCalls).toBe(1);

    // 포기하면 잠금이 즉시 풀린다 — 카드가 사라지고 새 경기가 만들어진다.
    await expect(page.getByTestId("resume-match-card")).toHaveCount(0);
    await page.getByTestId("play-cta").click();
    await page.getByTestId("mode-practice").click();
    await expect(page).toHaveURL(/\/match\/M_NEW$/);
  });

  test("포기 버튼은 정상 재생 중에는 없다 (리롤 방지 — 서버 abandonable 을 그대로 따른다)", async ({ page }) => {
    await mockApi(page, "live");
    await page.goto("/match/" + MATCH_ID);
    // 강제 이동 대상이라 로비 카드 자체가 없다.
    await expect(page.getByTestId("abandon-match")).toHaveCount(0);
  });
});

test.describe("#217 MAJOR-1 — 멈춘 생성 화면에서 빠져나갈 수 있다", () => {
  test("GEN 대기 스피너에도 포기 버튼이 열리고, 누르면 로비로 나간다", async ({ page }) => {
    const st = await mockApi(page, "genStuck");

    await page.goto(`/match/${MATCH_ID}`);
    await expect(page.getByTestId("genwait-panel")).toBeVisible();

    // 이게 없으면 유저는 스피너를 보며 아무 것도 못 한다(로비는 잠겨 있고 retry 는 FAILED 전용).
    await page.getByTestId("genwait-abandon").click();
    expect(st.abandonCalls).toBe(1);
    await expect(page).toHaveURL(/\/lobby$/);
  });

  test("정상 생성 중에는 그 버튼이 없다 (서버 abandonable 을 그대로 따른다)", async ({ page }) => {
    const st = await mockApi(page, "live");
    st.scenario = "live";
    await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
      route.fulfill(
        json({
          match: { id: MATCH_ID, state: "GEN1", createdAt: "2026-07-27T09:00:00Z" },
          locked: true,
          abandonable: false,
        }),
      ),
    );
    await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) =>
      route.fulfill(json({ id: MATCH_ID, state: "GEN1", createdAt: "2026-07-27T09:00:00Z" })),
    );

    await page.goto(`/match/${MATCH_ID}`);
    await expect(page.getByTestId("genwait-panel")).toBeVisible();
    await expect(page.getByTestId("genwait-abandon")).toHaveCount(0);
  });
});
