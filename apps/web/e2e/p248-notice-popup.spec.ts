import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * 공지 팝업 route-mock E2E (#248 §5 web 1~9 + hero Q7 서식/보안).
 *
 * 계약의 축은 셋이다:
 *  ① **첫 진입에 뜨고, 두 버튼이 각각 다른 범위로 억제한다** — 닫기=탭 세션 / 24h=기기 24시간,
 *    그리고 **둘 다 그 장 하나에만** 적용된다(hero Q1 확정 — 회차 일괄 아님)
 *  ② **부가 기능이 로비를 죽이지 않는다** — 응답이 `{}`·비배열·500 이어도 로비는 정상 렌더
 *  ③ **본문 서식은 되고, 스크립트는 안 된다** — HTML·javascript: 는 전부 텍스트로 강등
 *
 * ⚠️ 라우트 매칭은 **pathname 술어**로 한다(glob 은 vite 소스까지 잡아 흰 화면이 된다 — 프로젝트 기지식).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface NoticeSeed {
  id: string;
  revision?: number;
  title?: string;
  body?: string;
  priority?: number;
  startsAt?: string | null;
  endsAt?: string | null;
}

function notice(seed: NoticeSeed) {
  return {
    id: seed.id,
    revision: seed.revision ?? 1,
    title: seed.title ?? `${seed.id} 제목`,
    body: seed.body ?? `${seed.id} 본문입니다`,
    startsAt: seed.startsAt ?? null,
    endsAt: seed.endsAt ?? null,
    priority: seed.priority ?? 0,
  };
}

/** 공지 응답을 갈아끼울 수 있는 상태 컨테이너 — 같은 탭에서 revision 범프를 재현한다. */
interface NoticeMock {
  payload: unknown;
  status: number;
  /** 응답 지연(ms) — 공지가 **늦게** 도착하는 경합(#248 §4 큐)을 재현한다. */
  delayMs?: number;
  /** `/api/me/away-reports`(#245). 안 주면 미확인 원정 0건. */
  away?: unknown;
}

/** 미확인 원정 리포트 1건 — `shouldShowAwayPopup` 이 요구하는 최소 형태(reports 배열 + summary). */
function awayReportsPayload() {
  const reports = [
    {
      id: "AR1",
      matchId: "M-away-1",
      attackerName: "라이벌FC",
      goalsFor: 1,
      goalsAgainst: 2,
      result: "LOSS",
      ratingDelta: -12,
      createdAt: "2026-07-29T10:00:00Z",
      seen: false,
    },
  ];
  return {
    reports,
    summary: {
      matches: 1,
      opponents: 1,
      wins: 0,
      draws: 0,
      losses: 1,
      goalsFor: 1,
      goalsAgainst: 2,
      ratingDelta: -12,
    },
    rating: 1188,
    unseen: 1,
  };
}

/** 지금 열려 있는 모달 수 — "동시에 하나만"의 측정점. */
function openDialogs(page: Page) {
  return page.locator('[role="dialog"]');
}

async function mockLobby(page: Page, mock: NoticeMock) {
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page);
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: { id: "u1", nickname: "감독님", tutorialDone: true },
        wallet: { points: 62000, gems: 120 },
        records: { wins: 3, draws: 1, losses: 2 },
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json({ match: null, locked: false, abandonable: false })),
  );
  // #245 원정 리포트 — 기본은 "미확인 0건"이라 기존 스펙 동작은 그대로다.
  await page.route((url) => url.pathname === "/api/me/away-reports", (route) =>
    route.fulfill(json(mock.away ?? { reports: [], summary: null, rating: 1200, unseen: 0 })),
  );
  await page.route((url) => url.pathname === "/api/notices/active", async (route) => {
    if (mock.delayMs) await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
    return route.fulfill(json(mock.payload, mock.status));
  });
}

async function gotoLobby(page: Page) {
  await page.goto("/home");
  await expect(page.getByTestId("home-page")).toBeVisible();   // #286: 로비 → 홈
}

test.describe("#248 공지 팝업 — 표시와 억제", () => {
  test("활성 공지가 있으면 홈 진입 즉시 제목·본문과 함께 뜬다", async ({ page }) => {
    await mockLobby(page, {
      payload: {
        notices: [
          notice({
            id: "N1",
            title: "정기 점검",
            body: "03:00 ~ 05:00",
            startsAt: "2026-07-29T09:00:00Z",
            endsAt: "2026-07-31T09:00:00Z",
          }),
        ],
      },
      status: 200,
    });
    await gotoLobby(page);

    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("notice-title")).toHaveText("정기 점검");
    await expect(page.getByTestId("notice-body")).toContainText("03:00 ~ 05:00");
    await expect(page.getByTestId("notice-meta")).toContainText("게시");
    await expect(page.getByTestId("notice-meta")).toContainText("까지");
    // 단건이면 페이저·점은 없다(없는 정보를 만들지 않는다).
    await expect(page.getByTestId("notice-pager")).toHaveCount(0);
    await expect(page.getByTestId("notice-dots")).toHaveCount(0);
  });

  /**
   * #473 (hero: *"공지들 다 일주일 안보기로 바꿔"*) — **이 계약이 뒤집힌 자리다.**
   *
   * 구 계약은 *"[닫기] = 이 탭 세션 동안만 … 세션이 바뀌면 다시 뜬다"* 였고, 그게 곧 hero 가
   * 본 화면이다(브라우저를 새로 열면 같은 공지가 그대로 다시 떴다). 지금은 닫기가 기기에
   * 일주일 억제를 기록한다 — 세션을 갈아도 안 뜬다.
   */
  test("[닫기] = 기기에 일주일 기록 — 탭 세션을 갈아도 안 뜬다", async ({ page }) => {
    await mockLobby(page, { payload: { notices: [notice({ id: "N1" })] }, status: 200 });
    await gotoLobby(page);

    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    // 기기 기록(일주일) + 세션 백스톱, **둘 다** 남는다.
    const dismissed = JSON.parse(
      (await page.evaluate(() => window.localStorage.getItem("hmb.notice.dismissed.v1")))!,
    ) as Record<string, number>;
    expect(Object.keys(dismissed)).toEqual(["N1@1"]);
    expect(
      await page.evaluate(() => window.sessionStorage.getItem("hmb.notice.closed.v1")),
    ).toBe(JSON.stringify(["N1@1"]));

    // 같은 탭 세션에서 로비 재진입 → 안 뜬다.
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    // 탭 세션 리셋(새 탭과 동등) → **그래도 안 뜬다**(구 동작이면 여기서 다시 떴다).
    await page.evaluate(() => window.sessionStorage.clear());
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    // 기기 기록까지 지우면(= 억제 만료와 동등) 다시 뜬다 — 영구 차단이 아니다.
    await page.evaluate(() => window.localStorage.removeItem("hmb.notice.dismissed.v1"));
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toBeVisible();
  });

  // #473 — [닫기] 자체가 일주일 억제다(구 UI 의 [일주일 동안 안 보기] 버튼은 은퇴).
  test("[닫기] = 만료 시각을 기기에 기록하고, 지나면 다시 뜬다", async ({ page }) => {
    await mockLobby(page, { payload: { notices: [notice({ id: "N1" })] }, status: 200 });
    await gotoLobby(page);

    const before = Date.now();
    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    const stored = JSON.parse(
      (await page.evaluate(() => window.localStorage.getItem("hmb.notice.dismissed.v1")))!,
    ) as Record<string, number>;
    expect(Object.keys(stored)).toEqual(["N1@1"]);
    const expiry = stored["N1@1"];
    // #450 — 창이 24시간 → **7일**. 상수 import 로 쓰지 마라(계약이 앱과 같은 값을 읽으면
    // 임계 변이가 통과한다, apps/web CLAUDE.md "초록으로 거짓말하는 방식" ②).
    const WEEK_MS = 7 * 24 * 3600_000;
    expect(expiry).toBeGreaterThanOrEqual(before + WEEK_MS - 5_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + WEEK_MS + 5_000);

    // 리로드해도(세션이 새로 시작해도) 안 뜬다 — 세션이 아니라 기기 억제다.
    await page.evaluate(() => window.sessionStorage.clear());
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    // 만료 시각이 지나면 다시 뜬다.
    await page.evaluate(() =>
      window.localStorage.setItem(
        "hmb.notice.dismissed.v1",
        JSON.stringify({ "N1@1": Date.now() - 1000 }),
      ),
    );
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toBeVisible();
  });

  test("새 공지(다른 id)는 억제 중에도 뜬다", async ({ page }) => {
    const mock: NoticeMock = { payload: { notices: [notice({ id: "N1" })] }, status: 200 };
    await mockLobby(page, mock);
    await gotoLobby(page);
    await page.getByTestId("notice-close").click();

    mock.payload = { notices: [notice({ id: "N1" }), notice({ id: "N2", title: "신규 유닛" })] };
    await gotoLobby(page);
    await expect(page.getByTestId("notice-title")).toHaveText("신규 유닛");
    // 억제된 N1 은 스택에 남지 않는다 → 페이저 없음(1건).
    await expect(page.getByTestId("notice-pager")).toHaveCount(0);
  });

  test("내용을 고쳐 revision 이 오르면 억제를 뚫고 다시 뜬다 (변이체 킬)", async ({ page }) => {
    const mock: NoticeMock = {
      payload: { notices: [notice({ id: "N1", revision: 1, title: "오탈자" })] },
      status: 200,
    };
    await mockLobby(page, mock);
    await gotoLobby(page);
    await page.getByTestId("notice-close").click();
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    // 억제 키에서 revision 을 빼면(=id 만 쓰면) 이 단언이 깨진다 — 수정본을 아무도 못 본다.
    mock.payload = { notices: [notice({ id: "N1", revision: 2, title: "수정본" })] };
    await gotoLobby(page);
    await expect(page.getByTestId("notice-title")).toHaveText("수정본");
  });
});

test.describe("#248 공지 팝업 — 다건 중첩 스택 (hero Q1)", () => {
  const three = {
    notices: [notice({ id: "A" }), notice({ id: "B" }), notice({ id: "C" })],
  };

  /**
   * 뒤 카드가 앞 카드 **아래로 몇 px 비치는가**. hero Q1 의 핵심("겹쳐 보인다")은 개수가 아니라
   * 이 두께다 — 개수만 세던 계약은 겹침이 10/20px → 4/8px 로 줄어든 회귀를 통과시켰다.
   */
  async function overlapPx(page: Page, nth: 1 | 2): Promise<number> {
    const card = await page.getByTestId("notice-card").boundingBox();
    const behind = await page.getByTestId(`notice-behind-${nth}`).boundingBox();
    if (!card || !behind) throw new Error(`bounding box 없음 (behind-${nth})`);
    return behind.y + behind.height - (card.y + card.height);
  }

  test("3건 → 스택 + `1 / 3` 페이저, 닫을 때마다 다음 장, 마지막에 사라진다", async ({ page }) => {
    await mockLobby(page, { payload: three, status: 200 });
    await gotoLobby(page);

    await expect(page.getByTestId("notice-pager")).toHaveText("1 / 3");
    await expect(page.getByTestId("notice-title")).toHaveText("A 제목");
    // 뒤 카드가 실제로 겹쳐 **보인다** — 개수뿐 아니라 두께까지 본다(hero Q1 의 핵심).
    await expect(page.locator('[data-testid="notice-popup"] [aria-hidden="true"]')).toHaveCount(2);
    expect(await overlapPx(page, 1), "1번째 뒤 카드가 아래로 비치는 두께").toBeGreaterThanOrEqual(8);
    expect(await overlapPx(page, 2), "2번째는 그 두 배 근처").toBeGreaterThanOrEqual(16);
    await expect(page.getByTestId("notice-dots").locator("span")).toHaveCount(3);
    // [다음] 버튼은 없다 — 닫기가 곧 "이 장 처리하고 다음 장"이다.
    await expect(page.getByRole("button", { name: "다음" })).toHaveCount(0);

    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-pager")).toHaveText("2 / 3");
    await expect(page.getByTestId("notice-title")).toHaveText("B 제목");
    await expect(page.locator('[data-testid="notice-popup"] [aria-hidden="true"]')).toHaveCount(1);

    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-pager")).toHaveText("3 / 3");
    await expect(page.locator('[data-testid="notice-popup"] [aria-hidden="true"]')).toHaveCount(0);

    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);
    await expect(page.getByTestId("home-page")).toBeVisible();   // #286: 로비 → 홈
  });

  /**
   * ⚠️ `transform-origin` 회귀 가드 (major-1).
   *
   * 기본값(center)으로 두면 `scale` 이 뒤 카드의 아래 모서리를 **위로 끌어올려** `translateY` 를
   * 상쇄하고, 그 상쇄량은 **카드 높이에 비례**한다 — 즉 본문이 길수록 겹침이 더 얇아진다.
   * `bottom center` 로 고정하면 비치는 두께 = `translateY` 값 그대로라 본문 길이와 무관해진다.
   * 짧은 본문·긴 본문 **양쪽**에서 같은 두께가 나와야 이 성질이 지켜진 것이다.
   */
  test("겹침 두께는 본문 길이와 무관하다 (transform-origin 회귀 가드)", async ({ page }) => {
    const long = Array.from({ length: 40 }, (_, i) => `${i + 1}번째 줄 — 아주 긴 점검 안내 본문입니다.`).join("\n");
    await mockLobby(page, {
      payload: {
        notices: [notice({ id: "L", body: long }), notice({ id: "M" }), notice({ id: "N" })],
      },
      status: 200,
    });
    await gotoLobby(page);

    const cardBox = await page.getByTestId("notice-card").boundingBox();
    expect(cardBox!.height, "긴 본문 카드가 실제로 커졌다(가드가 공회전하지 않는다)").toBeGreaterThan(300);

    // center 였다면 카드가 커진 만큼 상쇄가 커져 여기서 8px 아래로 내려간다.
    expect(await overlapPx(page, 1)).toBeGreaterThanOrEqual(8);
    expect(await overlapPx(page, 1)).toBeLessThanOrEqual(14);
    expect(await overlapPx(page, 2)).toBeGreaterThanOrEqual(16);
    expect(await overlapPx(page, 2)).toBeLessThanOrEqual(26);
    // 층이 뒤로 갈수록 더 내려간다(순서가 뒤집히거나 겹치지 않는다).
    expect(await overlapPx(page, 2)).toBeGreaterThan(await overlapPx(page, 1));
  });

  // #473 — 한 번 누르면 **그 장만** 억제된다. 회차 일괄이면 첫 클릭에 3건이 기록되고,
  // 아직 보지도 않은 B·C 가 일주일 동안 삼켜진다.
  test("[닫기]는 **그 장만** 억제한다 — 회차 일괄이 아니다", async ({ page }) => {
    await mockLobby(page, { payload: three, status: 200 });
    await gotoLobby(page);

    // 첫 장만 닫는다(팝업은 B 로 넘어가 계속 열려 있다).
    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-title")).toHaveText("B 제목");

    const afterFirst = JSON.parse(
      (await page.evaluate(() => window.localStorage.getItem("hmb.notice.dismissed.v1")))!,
    ) as Record<string, number>;
    expect(Object.keys(afterFirst)).toEqual(["A@1"]);

    // 나머지 둘을 닫으면 각자 기록된다 — 그때서야 3건이다.
    await page.getByTestId("notice-close").click();
    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);
    const afterAll = JSON.parse(
      (await page.evaluate(() => window.localStorage.getItem("hmb.notice.dismissed.v1")))!,
    ) as Record<string, number>;
    expect(Object.keys(afterAll).sort()).toEqual(["A@1", "B@1", "C@1"]);

    // 새 탭 세션이어도(세션 백스톱이 풀려도) 일주일 억제는 살아 있다.
    await page.evaluate(() => window.sessionStorage.clear());
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);
  });
});

test.describe("#248 공지 팝업 — 실패해도 로비는 산다", () => {
  const broken: { name: string; payload: unknown; status: number }[] = [
    { name: "활성 0건", payload: { notices: [] }, status: 200 },
    { name: "구 서버 빈 객체", payload: {}, status: 200 },
    { name: "notices 가 배열이 아님", payload: { notices: "곧 공지" }, status: 200 },
    { name: "배열이 통째로 옴", payload: [{ id: "N1" }], status: 200 },
    { name: "서버 500", payload: { code: "INTERNAL_ERROR", message: "boom" }, status: 500 },
    { name: "404", payload: { code: "NOT_FOUND", message: "no" }, status: 404 },
  ];

  for (const c of broken) {
    test(`${c.name} → 팝업 없음 + 로비 정상 렌더`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await mockLobby(page, { payload: c.payload, status: c.status });
      await gotoLobby(page);

      await expect(page.getByTestId("notice-popup")).toHaveCount(0);
      // 로비가 흰 화면이 되지 않는다 — 메뉴 전체가 살아 있다.
      await expect(page.getByTestId("home-tile-deck")).toBeVisible();
      await expect(page.getByTestId("home-tile-recruit")).toBeVisible();
      expect(errors, "렌더 중 예외 0").toEqual([]);
    });
  }

  test("저장소 JSON 이 손상돼도 예외 없이 표시한다", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await mockLobby(page, { payload: { notices: [notice({ id: "N1" })] }, status: 200 });
    await page.addInitScript(() => {
      window.sessionStorage.setItem("hmb.notice.closed.v1", "{not json");
      window.localStorage.setItem("hmb.notice.dismissed.v1", "]]]");
    });
    await gotoLobby(page);

    // 오염이 공지를 영구히 못 보게 만들면 안 된다.
    await expect(page.getByTestId("notice-popup")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

/**
 * 로비 팝업 큐의 **교차 계약** (#248 §5 web 10 · §4) — #245 원정이 main 에 들어와 실물이 생겼다.
 *
 * 지금까지 이 계약은 `lobby-popup.test.ts` 순수함수로만 있었다. 화면에서 성립하는지가 본론이다:
 * **동시에 하나만 열리고, 겹치면 공지가 이기고, 진 쪽은 삼켜지지 않고 미뤄질 뿐이다.**
 *
 * ⚠️ 두 팝업은 트리거가 다르다 — 공지는 **로비 진입**, 원정은 **[게임 시작] 클릭**(hero E1).
 * 그래서 진입 시점만 보면 `away` 가 애초에 false 라 우선순위를 뒤집어도 티가 안 난다.
 * 큐가 실제로 일하는 순간은 **공지가 늦게 도착하는 경합**이다 — 그 창을 여기서 만든다.
 */
test.describe("#248 로비 팝업 큐 — 공지 × 원정(#245) 교차", () => {
  test("둘 다 준비돼도 로비 진입에는 **공지만** 열린다 (원정 모달은 DOM 에 없다)", async ({ page }) => {
    await mockLobby(page, {
      payload: { notices: [notice({ id: "N1", title: "정기 점검" })] },
      status: 200,
      away: awayReportsPayload(),
    });
    await gotoLobby(page);

    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("away-report-modal")).toHaveCount(0);
    await expect(openDialogs(page), "열린 모달은 정확히 1개").toHaveCount(1);
  });

  test("공지를 다 닫아도 원정은 살아 있다 — 다른 화면에서 그대로 뜬다 (삼키지 않는다)", async ({ page }) => {
    await mockLobby(page, {
      payload: { notices: [notice({ id: "N1" }), notice({ id: "N2" })] },
      status: 200,
      away: awayReportsPayload(),
    });
    await gotoLobby(page);

    // 1단계 — 홈에서 공지 2장. 원정은 여기 없다(#286 에서 게임 탭으로 갔다).
    await expect(page.getByTestId("notice-pager")).toHaveText("1 / 2");
    await expect(openDialogs(page)).toHaveCount(1);
    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-pager")).toHaveText("2 / 2");
    await expect(openDialogs(page), "장을 넘기는 중에도 1개").toHaveCount(1);
    await page.getByTestId("notice-close").click();

    // 2단계 — 공지가 끝나면 홈에 모달이 하나도 없다.
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);
    await expect(openDialogs(page)).toHaveCount(0);

    // 3단계 — 게임 탭의 [원정] 카드를 누르면 그제서야 원정. **공지가 원정을 소진시키지 않았다.**
    await page.goto("/game");
    await page.getByTestId("mode-away").click();
    await expect(page.getByTestId("away-report-modal")).toBeVisible();
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);
    await expect(openDialogs(page)).toHaveCount(1);
  });

  /**
   * **#286 이후 두 팝업은 구조적으로 겹칠 수 없다** — 공지는 홈(진입), 원정은 게임 탭([원정] 카드).
   *
   * 예전 계약("원정이 먼저 열린 뒤 공지가 도착하면 공지가 이긴다")은 **한 화면에 둘 다 있을 때**의
   * 경합 규칙이었다. 그 경합 창이 사라졌으므로 같은 시나리오를 재현할 수 없다 — 대신 **경합이
   * 불가능하다는 사실 자체**를 박아 둔다. 누군가 원정 팝업을 홈으로 되돌리면 여기서 깨지고,
   * 그때는 `pickLobbyPopup` 에 `away` 를 다시 채우면 된다(규칙과 테스트는 그대로 살아 있다).
   */
  test("공지는 홈에만, 원정은 게임 탭에만 뜬다 — 한 화면에 둘이 겹칠 수 없다", async ({ page }) => {
    await mockLobby(page, {
      payload: { notices: [notice({ id: "N1", title: "긴급 점검" })] },
      status: 200,
      away: awayReportsPayload(),
    });

    // 홈: 공지만. 원정 리포트가 미확인 상태여도 홈에서는 뜨지 않는다.
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("notice-title")).toHaveText("긴급 점검");
    await expect(page.getByTestId("away-report-modal"), "원정은 홈에 없다").toHaveCount(0);
    await expect(openDialogs(page), "겹치는 순간 없이 항상 1개").toHaveCount(1);
    await page.getByTestId("notice-close").click();

    // 게임 탭: 원정만. 공지는 홈 진입 트리거라 여기서 저절로 뜨지 않는다.
    await page.goto("/game");
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);
    await page.getByTestId("mode-away").click();
    await expect(page.getByTestId("away-report-modal")).toBeVisible();
    await expect(openDialogs(page)).toHaveCount(1);
  });
});

test.describe("#248 공지 본문 — 서식은 되고 스크립트는 안 된다 (hero Q7)", () => {
  const PNG_1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("굵게·기울임·목록·링크·이미지가 각각 렌더된다", async ({ page }) => {
    const body = [
      "첫 줄\n둘째 줄",
      "",
      "**굵게** 와 *기울임*",
      "- 항목 하나",
      "- 항목 둘",
      "[상점 보기](https://example.test/shop) 그리고 ![새 유닛](/assets/notice-test.png)",
    ].join("\n");
    await mockLobby(page, { payload: { notices: [notice({ id: "N1", body })] }, status: 200 });
    await page.route((url) => url.pathname === "/assets/notice-test.png", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_1x1, "base64") }),
    );
    await gotoLobby(page);

    const bodyEl = page.getByTestId("notice-body");
    await expect(bodyEl.locator("strong")).toHaveText("굵게");
    await expect(bodyEl.locator("em")).toHaveText("기울임");
    await expect(bodyEl.locator("ul li")).toHaveCount(2);
    const link = bodyEl.locator("a");
    await expect(link).toHaveAttribute("href", "https://example.test/shop");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(bodyEl.locator("img")).toHaveCount(1);

    // ⚠️ 본문 링크가 DOM 순서상 첫 포커서블이라 그냥 두면 **Enter 한 번에 외부 사이트로 나간다**.
    // 포커스는 주 동작(닫기)에 있어야 한다.
    await expect(page.getByTestId("notice-close")).toBeFocused();

    // 문단 안 줄바꿈이 보존된다(pre-wrap).
    await expect(bodyEl.locator("p").first()).toContainText("첫 줄");
    await expect(bodyEl.locator("p").first()).toContainText("둘째 줄");
  });

  test("이미지 로드 실패는 숨겨지고 레이아웃·버튼은 유지된다", async ({ page }) => {
    await mockLobby(page, {
      payload: { notices: [notice({ id: "N1", body: "안내\n\n![죽은 호스트](https://dead.test/x.png)" })] },
      status: 200,
    });
    await page.route((url) => url.hostname === "dead.test", (route) => route.abort());
    await gotoLobby(page);

    await expect(page.getByTestId("notice-body")).toContainText("안내");
    // 깨진 아이콘 대신 사라진다.
    await expect(page.getByTestId("notice-image")).toHaveCount(0);
    await expect(page.getByTestId("notice-close")).toBeVisible();
    await expect(page.getByTestId("notice-dismiss-hint")).toBeVisible();
  });

  test("변이체 킬 — <script>·<img onerror>·javascript: 링크가 실행되지 않는다", async ({ page }) => {
    const hostile = [
      '<script>window.__pwned = "script"</script>',
      '<img src=x onerror="window.__pwned = \'onerror\'">',
      "[눌러](javascript:window.__pwned='href')",
      "![그림](javascript:window.__pwned='img')",
      "<a href=\"javascript:alert(1)\">링크</a>",
    ].join("\n\n");
    await mockLobby(page, { payload: { notices: [notice({ id: "N1", body: hostile })] }, status: 200 });
    await gotoLobby(page);

    const bodyEl = page.getByTestId("notice-body");
    await expect(bodyEl).toBeVisible();

    // ① 스크립트가 돌지 않았다.
    expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
    // ② 실행 가능한 노드가 하나도 만들어지지 않았다.
    expect(await bodyEl.locator("script").count()).toBe(0);
    expect(await bodyEl.locator("img").count()).toBe(0);
    expect(await bodyEl.locator("a").count()).toBe(0);
    // ③ innerHTML 에 살아 있는 태그가 없다 — 꺾쇠가 전부 이스케이프돼 텍스트로 남았다.
    //    (문자열에 "onerror=" 가 보이는 것은 정상이다 — `&lt;img … onerror=…&gt;` 는 태그가 아니라 글자다.)
    const html = await bodyEl.innerHTML();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=");
    // 실행 훅이 붙은 엘리먼트가 0개 — 속성 레벨로도 확인한다.
    expect(await bodyEl.locator("[onerror], [onload], [onclick]").count()).toBe(0);
    // ④ 원문은 텍스트로 보인다(운영자가 뭘 넣었는지 감춰지지 않는다).
    await expect(bodyEl).toContainText("javascript:window.__pwned");
  });
});
