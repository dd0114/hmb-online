import { expect, test, type Page, type Request } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * 스타터/온보딩 개편 E2E (이슈 #209) — **route-mock 전용**(백엔드/데모 8080 무접촉).
 *
 * 보는 것 세 가지:
 *  · AC3 — 가입 직후 최상위 유닛이 **덮인 카드로** 뜨고, 눌러야 공개되며, 공개 전엔 못 닫는다.
 *  · AC2 — 튜토리얼을 끝내면 클라가 `POST /api/me/tutorial-complete` 를 **정확히 한 번** 친다
 *          (덱 지급의 트리거. 지급 자체의 멱등은 서버 테스트가 본다) 그리고 덱을 다시 읽는다.
 *  · 모바일 390px 에서 연출이 안 깨진다(가로 오버플로 0, 카드가 화면 안).
 *
 * ⚠️ 라우트 매칭은 glob 이 아니라 **pathname 술어**로 한다 — glob('**\/api/**')은 vite 소스
 *    (/src/api/*.ts)까지 잡아 모듈 로딩을 깨고 흰 화면이 된다(p3-tutorial.spec.ts 선례).
 */

const LOGIN_ID = "starter01";
const PASSWORD = "sup3rs3cret";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

const POSITIONS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW"] as const;

const BASIC_PLAYERS = POSITIONS.map((position, i) => ({
  id: `P${i}`,
  name: `선수${i}`,
  position,
  grade: "SILVER",
  owned: true,
  ownedCount: 1,
  attributes: attrs(70),
  personality: "CALM",
}));

/** 가입 지급된 최상위 유닛 — 서버 `starter_grants` 가 박제한 값을 그대로 흉내낸다. */
const TOP_PLAYER = {
  id: "P005",
  name: "Diego Maradona",
  position: "MF",
  grade: "LEGEND",
  owned: true,
  ownedCount: 1,
  attributes: attrs(93),
  personality: "CALM",
};

const DECK = {
  id: "d1",
  formation: "4-3-3",
  slots: BASIC_PLAYERS.map((p, i) => ({
    playerId: p.id,
    role: "starter",
    slotIndex: i,
    promptText: null,
  })),
};

interface MockState {
  /** 서버가 최상위를 지급했는가(구 계정 재현용 토글). */
  granted: boolean;
  /** POST /api/me/tutorial-complete 요청들 — 호출 횟수 계약 검증용. */
  completeCalls: Request[];
  /** 완료 전에는 덱이 없다(404) — 지급 시점이 튜토리얼 종료 후라는 것 자체를 재현. */
  deckExists: boolean;
  deckReads: number;
}

async function mockApi(page: Page, opts: { granted?: boolean } = {}): Promise<MockState> {
  const st: MockState = {
    granted: opts.granted ?? true,
    completeCalls: [],
    deckExists: false,
    deckReads: 0,
  };

  // catch-all 먼저 — Playwright 는 나중에 등록한 핸들러가 우선한다.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));

  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: "u1", nickname: "신규감독", tutorialDone: false },
          wallet: { points: 3000 },
          records: { wins: 0, draws: 0, losses: 0 },
        }),
      ),
  );
  await page.route(
    (url) => url.pathname === "/api/me/starter-grant",
    (route) =>
      route.fulfill(
        st.granted ? json({ granted: true, player: TOP_PLAYER }) : json({ granted: false, player: null }),
      ),
  );
  await page.route(
    (url) => url.pathname === "/api/me/tutorial-complete",
    (route) => {
      st.completeCalls.push(route.request());
      st.deckExists = true; // 서버가 이 호출에서 덱을 만든다
      return route.fulfill(json({ tutorialDone: true, deckGranted: true, deck: DECK }));
    },
  );
  await page.route(
    (url) => url.pathname === "/api/players",
    (route) => route.fulfill(json([...BASIC_PLAYERS, TOP_PLAYER])),
  );
  await page.route(
    (url) => url.pathname === "/api/deck",
    (route) => {
      st.deckReads++;
      return st.deckExists
        ? route.fulfill(json(DECK))
        : route.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404));
    },
  );
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    route.fulfill(json(Object.fromEntries(BASIC_PLAYERS.map((p) => [p.id, 0.7])))),
  );
  await page.route(
    (url) => url.pathname === "/api/auth/register",
    (route) => route.fulfill(json({ token: "tok_new", user: { id: "u1", nickname: "신규감독" }, isNew: true })),
  );
  return st;
}

/** 가입 폼 제출까지 — 지급 연출은 아직 열려 있는 상태로 멈춘다. */
async function register(page: Page) {
  await skipSplash(page);
  await page.goto("/login");
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-mode-toggle").click();
  await page.getByTestId("local-nickname").fill(LOGIN_ID);
  await page.getByTestId("local-password").fill(PASSWORD);
  await page.getByTestId("local-submit").click();
  await expect(page.getByTestId("starter-reveal")).toBeVisible();
}

test.describe("#209 AC3 — 가입 최상위 지급 연출", () => {
  test("카드는 덮인 채 열리고, 눌러야 공개된다", async ({ page }) => {
    await mockApi(page);
    await register(page);

    const card = page.getByTestId("starter-reveal-card");
    await expect(card).toHaveAttribute("data-revealed", "false");
    // 공개 전엔 결과가 새지 않는다 — 확인 버튼도, 선수 이름도 없다.
    await expect(page.getByTestId("starter-reveal-close")).toHaveCount(0);
    await expect(page.getByText("Diego Maradona")).toHaveCount(0);

    await card.click();
    await expect(card).toHaveAttribute("data-revealed", "true");
    await expect(page.getByTestId("starter-reveal-grant")).toContainText("Diego Maradona");
    await expect(page.getByTestId("starter-reveal-grant")).toContainText("15명");

    await page.getByTestId("starter-reveal-close").click();
    // #493 W1: 신규 가입의 기본 착지는 1분 미니게임(/welcome)이다 — 건너뛰면 홈(온보딩 시작).
    await expect(page).toHaveURL(/\/welcome$/);
    await page.getByTestId("minigame-skip").click();
    await expect(page).toHaveURL(/\/home$/);
  });

  test("모바일 390px — 카드·시트가 화면 안에 들어오고 가로 스크롤이 없다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await register(page);
    await page.getByTestId("starter-reveal-card").click();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, "가로 오버플로").toBeLessThanOrEqual(0);

    const box = await page.getByTestId("starter-reveal-card").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    const sheet = await page.getByTestId("starter-reveal").boundingBox();
    expect(sheet!.x).toBeGreaterThanOrEqual(0);
    expect(sheet!.x + sheet!.width).toBeLessThanOrEqual(390);
    // 확인 버튼이 화면 안에 있어야 진행할 수 있다(fold 아래로 밀리면 막힌다).
    await expect(page.getByTestId("starter-reveal-close")).toBeInViewport();
  });

  test("최상위 지급이 없는 계정은 카드 없이 문구만 — 동선이 막히지 않는다", async ({ page }) => {
    await mockApi(page, { granted: false });
    await register(page);

    await expect(page.getByTestId("starter-reveal-card")).toHaveCount(0);
    await page.getByTestId("starter-reveal-close").click();
    // 지급이 없어도 신규 유저다 — 미니게임(#493 W1)을 거쳐 홈으로.
    await expect(page).toHaveURL(/\/welcome$/);
    await page.getByTestId("minigame-skip").click();
    await expect(page).toHaveURL(/\/home$/);
  });
});

test.describe("#209 AC2 — 튜토리얼 완료가 덱 지급을 트리거한다", () => {
  test("건너뛰기 = 완료와 같은 저장 경로(정확히 1회 호출)", async ({ page }) => {
    const st = await mockApi(page);
    await register(page);
    await page.getByTestId("starter-reveal-card").click();
    await page.getByTestId("starter-reveal-close").click();
    await page.getByTestId("minigame-skip").click(); // #493 W1 미니게임 통과

    // 로비 진입 → 튜토리얼 자동 시작. 건너뛰기는 유저가 온보딩 전체를 거절한 경우다 —
    // 그래도 덱은 지급된다(안 그러면 경기 자체를 못 한다, #209 D6).
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await page.getByTestId("tutorial-skip").click();

    await expect.poll(() => st.completeCalls.length, { timeout: 5000 }).toBe(1);
    expect(st.completeCalls[0]!.method()).toBe("POST");

    // 저장 후 재진입해도 다시 뜨지 않는다(재노출 0) — 저장이 중복으로 나가지도 않는다.
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    expect(st.completeCalls.length, "중복 저장 0").toBe(1);
  });

  test("덱 화면을 띄워 둔 채 완료하면 지급된 덱이 **리로드 없이** 채워진다", async ({ page }) => {
    const st = await mockApi(page);
    await register(page);
    await page.getByTestId("starter-reveal-card").click();
    await page.getByTestId("starter-reveal-close").click();

    // 덱 화면에 먼저 들어간다 — 이 시점의 서버 응답은 404(= 아직 덱 없음, 지급 시점이
    // 튜토리얼 종료 후라는 사실 자체). 여기서 덱 쿼리가 **마운트**돼 있어야 무효화가 의미를 갖는다.
    await page.goto("/deck");
    await expect.poll(() => st.deckReads, { timeout: 5000 }).toBeGreaterThan(0);
    const deckReadsBefore = st.deckReads;
    expect(st.deckExists, "완료 전에는 덱이 없다").toBe(false);

    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await page.getByTestId("tutorial-skip").click();

    await expect.poll(() => st.completeCalls.length, { timeout: 5000 }).toBe(1);
    // 지급 후 덱을 다시 읽는다 = 유저가 빈 덱 화면에 남지 않는다(캐시 무효화 계약).
    await expect.poll(() => st.deckReads, { timeout: 5000 }).toBeGreaterThan(deckReadsBefore);
  });
});
