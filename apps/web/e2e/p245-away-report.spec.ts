import { expect, test, type Page } from "@playwright/test";

/**
 * 원정(피침공) 리포트·레이팅 E2E (이슈 #245) — **route-mock 전용**(백엔드/데모 8080 무접촉).
 *
 *  · 요구 1 — 로비에 오면 "어떤 팀에게 원정을 당했고 결과가 어땠는지" 팝업으로 받는다.
 *  · 요구 2 — 승 +10 / 패 −10 이 리포트와 헤더 레이팅에 보인다.
 *  · 요구 3 — 부재중 다건이 "몇 팀과 몇 승 몇 패 · 득실 · 레이팅 ±X" 로 묶인다.
 *  · 멱등  — [확인] 이후에는 다시 뜨지 않는다(ack 이 서버 상태를 바꾼다).
 *  · 0건   — 빈 모달을 띄우지 않는다.
 *  · 잠금  — 진행 중 매치로 강제 이동될 땐 팝업을 띄우지 않는다(스쳐 지나가며 소진되면 안 된다).
 *  · 원정  — [게임 시작]에 '원정' 이 있고, 상대가 없으면 봇으로 대체하지 않고 그 사실을 말한다.
 *
 * ⚠️ 라우트 매칭은 glob 이 아니라 **pathname 술어**로 한다 — glob('**\/api/**')은 vite 소스
 *    (/src/api/*.ts)까지 잡아 흰 화면이 된다(p3-tutorial.spec.ts 선례).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface MockState {
  /** 서버가 들고 있는 미확인 리포트(=팝업 대상). ack 이 이걸 비운다. */
  unseen: Report[];
  ackCalls: number;
  awayStarts: number;
  /** 원정 상대 유무 — 없으면 서버가 404 NO_OPPONENT. */
  hasOpponent: boolean;
  locked: boolean;
  rating: number;
}

interface Report {
  id: string;
  matchId: string;
  attackerName: string;
  goalsFor: number;
  goalsAgainst: number;
  result: "WIN" | "DRAW" | "LOSS";
  ratingDelta: number;
  createdAt: string;
  seen: boolean;
}

const THREE_RAIDS: Report[] = [
  { id: "R1", matchId: "M1", attackerName: "FC 한밤중", goalsFor: 1, goalsAgainst: 3, result: "LOSS", ratingDelta: -10, createdAt: "2026-07-28T03:12:00Z", seen: false },
  { id: "R2", matchId: "M2", attackerName: "언더독 유나이티드", goalsFor: 2, goalsAgainst: 0, result: "WIN", ratingDelta: 10, createdAt: "2026-07-28T01:40:00Z", seen: false },
  { id: "R3", matchId: "M3", attackerName: "레드 스톰 CF", goalsFor: 1, goalsAgainst: 4, result: "LOSS", ratingDelta: -10, createdAt: "2026-07-27T23:05:00Z", seen: false },
];

/** 서버가 하는 집계를 그대로 흉내 — 화면은 이 숫자를 그리기만 해야 한다(다시 세면 안 된다). */
function summarize(reports: Report[]) {
  return {
    matches: reports.length,
    opponents: new Set(reports.map((r) => r.attackerName)).size,
    wins: reports.filter((r) => r.result === "WIN").length,
    draws: reports.filter((r) => r.result === "DRAW").length,
    losses: reports.filter((r) => r.result === "LOSS").length,
    goalsFor: reports.reduce((s, r) => s + r.goalsFor, 0),
    goalsAgainst: reports.reduce((s, r) => s + r.goalsAgainst, 0),
    ratingDelta: reports.reduce((s, r) => s + r.ratingDelta, 0),
  };
}

async function mockApi(page: Page, over: Partial<MockState> = {}): Promise<MockState> {
  const st: MockState = {
    unseen: [],
    ackCalls: 0,
    awayStarts: 0,
    hasOpponent: true,
    locked: false,
    rating: -10,
    ...over,
  };

  // catch-all 먼저 — Playwright 는 나중에 등록한 핸들러가 우선한다.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));

  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: { id: "u1", nickname: "감독", isAdmin: false, tutorialDone: true },
        wallet: { points: 1000, gems: 0 },
        records: { wins: 1, draws: 0, losses: 2 },
        rating: st.rating,
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(
      json(
        st.locked
          ? { match: { id: "M_LIVE", state: "FIRST_HALF", createdAt: "2026-07-28T09:00:00Z" }, locked: true, abandonable: false }
          : { match: null, locked: false, abandonable: false },
      ),
    ),
  );
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/deck", (route) =>
    route.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404)),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));

  await page.route((url) => url.pathname === "/api/me/away-reports", (route) =>
    route.fulfill(
      json({
        reports: st.unseen,
        summary: summarize(st.unseen),
        rating: st.rating,
        unseen: st.unseen.length,
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/me/away-reports/ack", (route) => {
    st.ackCalls++;
    const acked = st.unseen.length;
    st.unseen = []; // 서버가 seen_at 을 박았다 — 다음 조회부터 팝업 대상이 아니다
    return route.fulfill(json({ acked }));
  });

  await page.route((url) => url.pathname === "/api/away/matches", (route) => {
    if (route.request().method() !== "POST") return route.fulfill(json({}));
    st.awayStarts++;
    if (!st.hasOpponent) {
      return route.fulfill(json({ code: "NO_OPPONENT", message: "원정 갈 상대가 아직 없습니다" }, 404));
    }
    return route.fulfill(
      json({ id: "M_AWAY", state: "BRIEFING", mode: "away", createdAt: "2026-07-28T10:00:00Z" }, 201),
    );
  });

  // 관전 도착지(리포트 → 경기 보기)와 강제 이동 도착지.
  await page.route((url) => /^\/api\/matches\/[^/]+$/.test(url.pathname), (route) =>
    route.fulfill(
      json({
        id: url(route).split("/").pop(),
        state: "FINISHED",
        mode: "away",
        ownerName: "FC 한밤중",
        opponent: { name: "감독", analysisText: "", deck: [] },
        scoreHome: 3,
        scoreAway: 1,
        result: "WIN",
        createdAt: "2026-07-28T03:00:00Z",
      }),
    ),
  );
  await page.route((url) => url.pathname.includes("/halves/"), (route) =>
    route.fulfill(json({ code: "INVALID_STATE", message: "아직" }, 409)),
  );

  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok_e2e");
    window.localStorage.setItem("hmb.auth.provider", "guest");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });
  return st;
}

function url(route: { request(): { url(): string } }): string {
  return new URL(route.request().url()).pathname;
}

test.describe("#245 요구 1·3 — 부재중 피원정 팝업", () => {
  test("다건이 '몇 팀과 몇 승 몇 패 · 득실 · 레이팅' 으로 묶여 뜬다", async ({ page }) => {
    await mockApi(page, { unseen: [...THREE_RAIDS] });

    await page.goto("/lobby");

    const modal = page.getByTestId("away-report-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("away-report-headline")).toHaveText(
      "3팀이 우리 홈구장을 찾아왔습니다 — 1승 2패",
    );
    await expect(page.getByTestId("away-summary-record")).toHaveText("1승 0무 2패");
    await expect(page.getByTestId("away-summary-goals")).toHaveText("4 : 7");
    await expect(page.getByTestId("away-summary-rating")).toHaveText("-10");

    // 요구 1: 어떤 팀에게 당했는지가 경기별로 보인다.
    const items = page.getByTestId("away-report-item");
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText("FC 한밤중");
    await expect(items.first()).toContainText("1 : 3");
    await expect(items.first()).toContainText("-10");
  });

  test("단건이면 상대 이름과 결과를 말한다", async ({ page }) => {
    await mockApi(page, { unseen: [THREE_RAIDS[1]!], rating: 10 });

    await page.goto("/lobby");

    await expect(page.getByTestId("away-report-headline")).toHaveText(
      "언더독 유나이티드이(가) 원정을 왔고, 막아냈습니다",
    );
    await expect(page.getByTestId("away-summary-rating")).toHaveText("+10");
  });

  test("0건이면 팝업이 아예 뜨지 않는다", async ({ page }) => {
    await mockApi(page, { unseen: [] });

    await page.goto("/lobby");
    await expect(page.getByTestId("play-cta")).toBeVisible();
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
  });
});

test.describe("#245 멱등 — 한 번만 보여준다", () => {
  test("[확인] 뒤에는 로비를 다시 와도 뜨지 않는다", async ({ page }) => {
    const st = await mockApi(page, { unseen: [...THREE_RAIDS] });

    await page.goto("/lobby");
    await expect(page.getByTestId("away-report-modal")).toBeVisible();
    await page.getByTestId("away-report-confirm").click();
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);

    // 새로고침 = 서버에 다시 묻는다. 로컬 플래그가 아니라 서버 상태(seen_at)가 SoT 여야 한다.
    await page.reload();
    await expect(page.getByTestId("play-cta")).toBeVisible();
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
    expect(st.ackCalls).toBeGreaterThanOrEqual(1);
  });
});

test.describe("#245 요구 2 — 레이팅", () => {
  test("헤더에 레이팅이 전적과 함께 보인다(지갑 P 와 다른 축)", async ({ page }) => {
    await mockApi(page, { unseen: [], rating: -20 });

    await page.goto("/lobby");
    await expect(page.getByTestId("rating-badge")).toHaveAttribute("data-rating", "-20");
    // 재화 배지는 그대로 — 레이팅이 지갑으로 섞여 들어가면 안 된다.
    await expect(page.getByTestId("points-badge")).toBeVisible();
  });
});

test.describe("#245 원정 모드", () => {
  test("[게임 시작]에 원정이 있고, 누르면 원정 매치로 간다", async ({ page }) => {
    const st = await mockApi(page, { unseen: [] });

    await page.goto("/lobby");
    await page.getByTestId("play-cta").click();
    await expect(page.getByTestId("mode-away")).toBeVisible();
    await page.getByTestId("mode-away").click();

    await expect(page).toHaveURL(/\/match\/M_AWAY$/);
    expect(st.awayStarts).toBe(1);
  });

  test("상대가 없으면 봇으로 대체하지 않고 그 사실을 말한다", async ({ page }) => {
    await mockApi(page, { unseen: [], hasOpponent: false });

    await page.goto("/lobby");
    await page.getByTestId("play-cta").click();
    await page.getByTestId("mode-away").click();

    // 매치로 이동하지 않는다 — 조용한 봇 폴백이면 여기서 /match 로 갔을 것이다.
    await expect(page).toHaveURL(/\/lobby$/);
    await expect(page.getByText(/원정 갈 상대가 없습니다/)).toBeVisible();
  });
});

test.describe("#245 × #217 — 잠금과 충돌하지 않는다", () => {
  test("진행 중 경기로 강제 이동될 땐 팝업을 띄우지 않는다", async ({ page }) => {
    const st = await mockApi(page, { unseen: [...THREE_RAIDS], locked: true });

    await page.goto("/lobby");

    // 로비를 스쳐 매치로 간다. 그 사이 팝업이 떠 ack 이 소진되면 결과를 영영 못 본다.
    await expect(page).toHaveURL(/\/match\/M_LIVE$/);
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
    expect(st.ackCalls).toBe(0);
  });
});
