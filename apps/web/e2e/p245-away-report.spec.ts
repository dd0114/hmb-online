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
  /** 마지막 ack 이 실제로 무엇을 지목했는지 — "전부 지우기"로 퇴행하면 여기서 잡힌다. */
  ackedIds: string[] | null;
  awayStarts: number;
  /** 서버가 받은 defenderId — 화면의 선택이 실제로 전달되는지. */
  chosenDefender: string | null;
  /** 원정 상대 유무 — 없으면 서버가 404 NO_OPPONENT. */
  hasOpponent: boolean;
  /** 서버 report-list-limit 흉내. */
  limit: number;
  /** 오늘 남은 원정 횟수(-1 = 무제한). */
  remainingToday: number;
  locked: boolean;
  /** `/api/me/active-match` 응답 지연(ms) — 콜드 로드 경합 재현용. */
  activeDelayMs: number;
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
    ackedIds: null,
    awayStarts: 0,
    chosenDefender: null,
    hasOpponent: true,
    limit: 20,
    remainingToday: 7,
    locked: false,
    activeDelayMs: 0,
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
  await page.route((url) => url.pathname === "/api/me/active-match", async (route) => {
    if (st.activeDelayMs > 0) {
      await new Promise((r) => setTimeout(r, st.activeDelayMs));
    }
    return route.fulfill(
      json(
        st.locked
          ? { match: { id: "M_LIVE", state: "FIRST_HALF", createdAt: "2026-07-28T09:00:00Z" }, locked: true, abandonable: false }
          : { match: null, locked: false, abandonable: false },
      ),
    );
  });
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/deck", (route) =>
    route.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404)),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));

  await page.route((url) => url.pathname === "/api/me/away-reports", (route) => {
    // 서버는 report-list-limit 로 자른다 — 목록·요약은 그 창, unseen 은 **전체** 건수다.
    const shown = st.unseen.slice(0, st.limit);
    return route.fulfill(
      json({
        reports: shown,
        summary: summarize(shown),
        rating: st.rating,
        unseen: st.unseen.length,
      }),
    );
  });
  await page.route((url) => url.pathname === "/api/me/away-reports/ack", async (route) => {
    st.ackCalls++;
    const body = route.request().postDataJSON() as { ids?: string[] } | null;
    st.ackedIds = body?.ids ?? null;
    // 서버 의미 그대로: ids 가 있으면 그것만, 없으면 미확인 전부.
    const target = body?.ids;
    const before = st.unseen.length;
    st.unseen = target ? st.unseen.filter((r) => !target.includes(r.id)) : [];
    return route.fulfill(json({ acked: before - st.unseen.length }));
  });

  await page.route((url) => url.pathname === "/api/away/candidates", (route) =>
    route.fulfill(
      st.hasOpponent
        ? json({
            candidates: [
              { userId: "u-a", nickname: "언더독 유나이티드", rating: 10 },
              { userId: "u-b", nickname: "레드 스톰 CF", rating: -5 },
            ],
            streak: 2,
            seasonNo: 1,
            seasonEndsAt: "2026-08-04T00:00:00Z",
            remainingToday: st.remainingToday,
          })
        : json({ code: "NO_OPPONENT", message: "원정 갈 상대가 아직 없습니다" }, 404),
    ),
  );

  await page.route((url) => url.pathname === "/api/away/matches", (route) => {
    if (route.request().method() !== "POST") return route.fulfill(json({}));
    st.awayStarts++;
    st.chosenDefender = (route.request().postDataJSON() as { defenderId?: string } | null)?.defenderId ?? null;
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

    await page.goto("/game");

    // hero E1: 화면에 들어온 것만으로는 뜨지 않는다 — **[원정] 카드를 누를 때** 뜬다(#286 이관).
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
    await page.getByTestId("mode-away").click();

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

    await page.goto("/game");
    await page.getByTestId("mode-away").click();

    await expect(page.getByTestId("away-report-headline")).toHaveText(
      "언더독 유나이티드이(가) 원정을 왔고, 막아냈습니다",
    );
    await expect(page.getByTestId("away-summary-rating")).toHaveText("+10");
  });

  test("0건이면 팝업이 아예 뜨지 않는다", async ({ page }) => {
    await mockApi(page, { unseen: [] });

    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    // 0건이면 팝업 대신 원정 페이지가 바로 열린다(빈 모달을 끼워 넣지 않는다).
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
    await expect(page.getByTestId("away-page")).toBeVisible();
  });
});

test.describe("#245 멱등 — 한 번만 보여준다", () => {
  test("[확인] 뒤에는 다시 와도 뜨지 않는다", async ({ page }) => {
    const st = await mockApi(page, { unseen: [...THREE_RAIDS] });

    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    await expect(page.getByTestId("away-report-modal")).toBeVisible();
    await page.getByTestId("away-report-confirm").click();
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
    // 닫으면 원래 가려던 곳으로 이어준다 — 한 번 더 누르게 하지 않는다(E1).
    // #286 이후 그 목적지는 모드 모달이 아니라 **원정 페이지**다.
    await expect(page.getByTestId("away-page")).toBeVisible();

    // 새로고침 = 서버에 다시 묻는다. 로컬 플래그가 아니라 서버 상태(seen_at)가 SoT 여야 한다.
    await page.goto("/game");   // 새로고침 대신 게임 탭 재진입 — 팝업 트리거가 여기 있다
    await page.getByTestId("mode-away").click();
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
    expect(st.ackCalls).toBeGreaterThanOrEqual(1);
  });
});

test.describe("#245 MAJ-1 — 안 보여준 리포트를 소진하지 않는다", () => {
  test("창에 잘린 리포트는 남기고, 남았다는 사실을 말한다", async ({ page }) => {
    const st = await mockApi(page, {
      unseen: [...THREE_RAIDS, { ...THREE_RAIDS[0]!, id: "R4", matchId: "M4" }, { ...THREE_RAIDS[1]!, id: "R5", matchId: "M5" }],
      limit: 3, // 서버가 3건만 실어 보냈다(실서버 기본은 20)
    });

    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    await expect(page.getByTestId("away-report-item")).toHaveCount(3);
    await expect(page.getByTestId("away-report-remaining")).toContainText("외 2경기");

    await page.getByTestId("away-report-confirm").click();

    // 확인은 **화면에 그린 3건만** 지목해야 한다. ids 없이 보내면 서버가 5건 전부를 소진하고
    // 나머지 2건은 한 번도 보이지 않은 채 사라진다.
    expect(st.ackedIds).toEqual(["R1", "R2", "R3"]);
    expect(st.unseen.map((r) => r.id)).toEqual(["R4", "R5"]);
  });
});

test.describe("#245 2R blocker — 클릭이 리포트를 소멸시키지 않는다", () => {
  test("경기를 보러 가도 확인 처리되지 않는다(지난 리포트를 볼 화면이 없으므로 영구 소실이 된다)", async ({ page }) => {
    const st = await mockApi(page, { unseen: [THREE_RAIDS[0]!, THREE_RAIDS[1]!] });

    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    await page.getByTestId("away-report-item").first().click();
    await expect(page).toHaveURL(/\/match\/M1$/);

    expect(st.ackCalls).toBe(0);
    expect(st.unseen).toHaveLength(2);
  });

  test("몰수 경기는 열 수 없다 — 재생할 하프가 애초에 없다", async ({ page }) => {
    await mockApi(page, {
      unseen: [{ ...THREE_RAIDS[0]!, id: "RF", matchId: "MF", goalsFor: 0, goalsAgainst: 0, result: "WIN", ratingDelta: 10 }],
    });

    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    const item = page.getByTestId("away-report-item").first();
    await expect(item).toContainText("몰수");
    // 열리면 수비자에게 "포기한 경기입니다"가 뜬다 — 포기한 건 상대인데.
    await expect(item).toBeDisabled();
  });
});

test.describe("#245 요구 6 — 리포트에서 그 경기를 본다", () => {
  test("[경기 보기]가 그 매치로 가고, 홈 이름이 공격자로 뜬다(내 닉이 아니라)", async ({ page }) => {
    await mockApi(page, { unseen: [THREE_RAIDS[0]!] });

    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    await page.getByTestId("away-report-item").first().click();

    await expect(page).toHaveURL(/\/match\/M1$/);
    // ownerName 을 무시하고 me.nickname 을 홈에 박으면 관전 화면이 양 팀을 바꿔 부른다.
    await expect(page.getByText("FC 한밤중").first()).toBeVisible();
  });
});

test.describe("#245 3R m2 — 오탭은 확인이 아니다", () => {
  test("Escape 로 닫으면 확인되지 않아 다음 진입에 다시 뜬다", async ({ page }) => {
    const st = await mockApi(page, { unseen: [...THREE_RAIDS] });

    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    await expect(page.getByTestId("away-report-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
    // 오탭으로 닫혀도 **가려던 곳으로는 이어준다**(hero E1) — 여기서 멈춰 세우면 한 번 더
    // 누르게 하는 셈이다. 중요한 건 "확인"이 아니라는 것.
    await expect(page).toHaveURL(/\/away$/);

    expect(st.ackCalls).toBe(0);
    // 확인하지 않았으니 다음에 또 뜬다(#286 이후 트리거는 게임 탭의 [원정] 카드다).
    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    await expect(page.getByTestId("away-report-modal")).toBeVisible();
  });
});

test.describe("#245 요구 2 — 레이팅", () => {
  test("홈에 레이팅이 팀 한 줄과 함께 보인다(지갑 P 와 다른 축)", async ({ page }) => {
    // #286: 로비 헤더 배지가 사라지고 **홈 팀 한 줄**로 옮겨왔다. 축이 다르다는 계약은 그대로 —
    // 레이팅이 지갑 배지로 섞여 들어가면 "실력"과 "재화"가 한 덩어리로 읽힌다.
    await mockApi(page, { unseen: [], rating: -20 });

    await page.goto("/home");
    await expect(page.getByTestId("home-rating")).toContainText("-20");
    await expect(page.getByTestId("points-badge")).toBeVisible();
  });
});

test.describe("#245 원정 모드", () => {
  test("[게임] 탭에 원정이 있고, 원정 페이지에서 떠나면 원정 매치로 간다", async ({ page }) => {
    const st = await mockApi(page, { unseen: [] });

    await page.goto("/game");
    await expect(page.getByTestId("mode-away")).toBeVisible();
    // ⚠️ 증감폭(±10)은 서버 config 소유다 — 카드가 숫자를 베끼면 값을 바꿨을 때 화면만 거짓말한다.
    await expect(page.getByTestId("mode-away")).not.toContainText("승패로 ±10");
    await page.getByTestId("mode-away").click();
    // #286: 2택은 모달이 아니라 **원정 페이지**의 [원정 떠나기] 뒤에 온다.
    await page.getByTestId("away-start").click();

    // hero E2: 레이팅 비슷한 2명을 보여주고 그 중 고른다.
    // 남은 횟수는 **누르기 전에** 보인다 — 눌렀는데 거부되는 건 나쁜 UX 다.
    await expect(page.getByTestId("away-remaining")).toContainText("7회 남음");
    const candidates = page.getByTestId("away-candidate");
    await expect(candidates).toHaveCount(2);
    await expect(page.getByTestId("away-streak")).toContainText("2연승");
    await candidates.first().click();

    await expect(page).toHaveURL(/\/match\/M_AWAY$/);
    expect(st.awayStarts).toBe(1);
    expect(st.chosenDefender).toBe("u-a");   // 고른 상대가 실제로 서버에 전달된다
  });

  test("상대가 없으면 봇으로 대체하지 않고 그 사실을 말한다", async ({ page }) => {
    await mockApi(page, { unseen: [], hasOpponent: false });

    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    await page.getByTestId("away-start").click();

    // 매치로 이동하지 않는다 — 조용한 봇 폴백이면 여기서 /match 로 갔을 것이다.
    await expect(page).toHaveURL(/\/away$/);
    await expect(page.getByTestId("away-no-opponent")).toBeVisible();
  });
});

test.describe("#245 3R blocker — 잠금 판정 전에 팝업이 스치지 않는다", () => {
  test("active-match 가 늦게 와도 그 사이 팝업이 뜨지 않는다(스치는 창에서 오탭하면 영구 소실)", async ({
    page,
  }) => {
    // away-reports 는 즉시, active-match 는 900ms 뒤 — "자리를 비웠다 돌아온" 콜드 로드의 경합.
    const st = await mockApi(page, {
      unseen: [...THREE_RAIDS],
      locked: true,
      activeDelayMs: 900,
    });

    await page.goto("/home");
    // ⚠️ **트리거를 실제로 당긴다**(E1 이후 팝업은 [게임 시작]에 달려 있다). 안 누르면 게이트가
    // 있든 없든 "팝업 0"이 참이라, 이 계약이 다시 tautology 가 된다(독립검증 MAJ-5 가 그 상태였다).
    // best-effort — 이미 매치로 튕겼으면 버튼이 없다. 기다리면 타임아웃을 다 먹는다.
    await page.getByTestId("play-cta").click({ timeout: 2000 }).catch(() => {});

    // ⚠️ 창 자체를 관측해야 한다. 이전 계약은 URL 이동을 먼저 기다린 뒤 개수를 세서
    // **게이트를 통째로 지워도 통과**했다(3R: W5 변이체 생존). 지연 구간을 훑는다.
    for (let i = 0; i < 12; i++) {
      expect(
        await page.getByTestId("away-report-modal").count(),
        `t=${i * 100}ms 에 팝업이 떴다 — 잠금 판정 전에는 띄우면 안 된다`,
      ).toBe(0);
      await page.waitForTimeout(100);
    }

    await expect(page).toHaveURL(/\/match\/M_LIVE$/);
    expect(st.ackCalls).toBe(0);
    expect(st.unseen).toHaveLength(3);
  });
});

test.describe("#245 × #217 — 잠금과 충돌하지 않는다", () => {
  test("진행 중 경기로 강제 이동될 땐 팝업을 띄우지 않는다", async ({ page }) => {
    const st = await mockApi(page, { unseen: [...THREE_RAIDS], locked: true });

    await page.goto("/home");
    // 트리거를 당겨본다 — 강제 이동 중이면 그래도 팝업이 떠선 안 된다(MAJ-5).
    // best-effort — 이미 매치로 튕겼으면 버튼이 없다. 기다리면 타임아웃을 다 먹는다.
    await page.getByTestId("play-cta").click({ timeout: 2000 }).catch(() => {});

    // 로비를 스쳐 매치로 간다. 그 사이 팝업이 떠 ack 이 소진되면 결과를 영영 못 본다.
    await expect(page).toHaveURL(/\/match\/M_LIVE$/);
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
    expect(st.ackCalls).toBe(0);
  });
});
