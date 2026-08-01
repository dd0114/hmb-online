import { expect, test, type Page } from "@playwright/test";

/**
 * 신규 유저 온보딩 튜토리얼 E2E — PRD-v4 §B (AC-B1, AC-B2), P3-D6.
 *
 * 서버가 `user.tutorialDone` 을 아직 안 내므로 **route-mock 전용**이다(백엔드/데모 8080 무접촉).
 * 완료 저장은 지금 localStorage(userId 별) 폴백이고, 서버 필드가 오면 그쪽이 SoT 가 된다
 * (src/common/tutorial-storage.ts TODO(openapi-v3)).
 *
 * ⚠️ 라우트 매칭은 glob('**\/api/**')이 아니라 **pathname 술어**로 한다 —
 *    glob 은 vite 소스(/src/api/*.ts)까지 잡아 모듈 로딩을 깨고 흰 화면이 된다(선례 있음).
 */

/** 로그인 id 겸 닉네임(서버 단일 식별자 — users.nickname 재사용). */
const LOGIN_ID = "newbie01";
const PASSWORD = "sup3rs3cret";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

// ── 덱 화면(/deck) 목 데이터 ────────────────────────────────────────────────
// 튜토리얼이 로비 → 덱으로 넘어가는 스텝을 갖게 되면서 덱 화면도 실제로 렌더돼야 한다.
// src/deck/** 는 읽기 전용(#106 세션 소유)이라 화면은 그대로 두고 API 만 목킹한다.
const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

const POSITIONS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW"] as const;

/** 선발 11명을 정확히 채운 상태 — '저장'이 활성인 실제 화면을 코치마크가 가리키게 한다. */
const PLAYERS = POSITIONS.map((position, i) => ({
  id: `P${i}`,
  name: `선수${i}`,
  position,
  grade: "SILVER",
  owned: true,
  ownedCount: 1,
  attributes: attrs(70),
  personality: "CALM",
}));

const DECK = {
  id: "d1",
  formation: "4-4-2",
  slots: PLAYERS.map((p, i) => ({
    playerId: p.id,
    role: "starter",
    slotIndex: i,
    promptText: null,
  })),
};

interface MockOptions {
  /** /api/me 가 내려줄 유저 id — 계정 격리 검증에 쓴다. */
  userId?: string;
  /** 서버 additive 필드. undefined = 미발행(현 상태). */
  tutorialDone?: boolean;
}

/** 테스트 도중 바꿀 수 있는 목 상태(계정 전환·401 재현용). */
interface MockState {
  userId: string;
  tutorialDone?: boolean;
  /** true 면 /api/me 가 401 — UnauthorizedBridge 의 로그아웃 경로를 탄다(리로드 없음). */
  unauthorized: boolean;
  /** /api/me 응답 지연(ms) — 계정 전환 직후 stale 캐시 창을 재현한다. */
  meDelayMs?: number;
}

async function mockApi(page: Page, opts: MockOptions = {}): Promise<MockState> {
  const st: MockState = {
    userId: opts.userId ?? "u1",
    tutorialDone: opts.tutorialDone,
    unauthorized: false,
  };

  // catch-all 먼저 — Playwright 는 나중에 등록한 핸들러가 우선한다.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );
  await page.route(
    (url) => url.pathname === "/api/me",
    async (route) => {
      if (st.unauthorized) {
        return route.fulfill(json({ code: "UNAUTHORIZED", message: "세션이 만료되었습니다" }, 401));
      }
      if (st.meDelayMs) await new Promise((r) => setTimeout(r, st.meDelayMs));
      return route.fulfill(
        json({
          user: {
            id: st.userId,
            nickname: "신규감독",
            ...(st.tutorialDone === undefined ? {} : { tutorialDone: st.tutorialDone }),
          },
          wallet: { points: 3000 },
          records: { wins: 0, draws: 0, losses: 0 },
        }),
      );
    },
  );
  // 덱 화면(/deck) — 튜토리얼 덱 스텝의 대상이 실제로 그려지도록 최소 목킹.
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/deck", (route) => route.fulfill(json(DECK)));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    route.fulfill(json(Object.fromEntries(PLAYERS.map((p) => [p.id, 0.7])))),
  );
  await page.route(
    (url) => url.pathname === "/api/auth/register",
    (route) => route.fulfill(json({ token: "tok_new", isNew: true })),
  );
  await page.route(
    (url) => url.pathname === "/api/auth/login",
    (route) => route.fulfill(json({ token: "tok_local", isNew: false })),
  );
  return st;
}

/**
 * 이미 /login 화면에 있을 때의 가입 절차(리로드 없음).
 * ⚠️ 계정 전환 시나리오에서는 절대 goto 하지 말 것 — 풀 리로드가 메모리 상태를 지워
 * 검증하려는 SPA 상태 누수를 감춰버린다.
 */
async function fillRegister(page: Page) {
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-mode-toggle").click();
  await page.getByTestId("local-nickname").fill(LOGIN_ID);
  await page.getByTestId("local-password").fill(PASSWORD);
  await page.getByTestId("local-submit").click();
  await page.getByRole("button", { name: "확인" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function fillLogin(page: Page) {
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-nickname").fill(LOGIN_ID);
  await page.getByTestId("local-password").fill(PASSWORD);
  await page.getByTestId("local-submit").click();
  await expect(page).toHaveURL(/\/home$/);
}

/** 신규 가입 → 스타터팩 확인 → 로비. isNew=true 라 튜토리얼이 자동 시작된다. */
async function registerNewUser(page: Page) {
  await page.goto("/login");
  await fillRegister(page);
}

/** 기존 유저 로그인(isNew=false) — 재로그인 미노출 검증용. */
async function loginExistingUser(page: Page) {
  await page.goto("/login");
  await fillLogin(page);
}

interface Geometry {
  vp: { width: number; height: number };
  target: { x: number; y: number; width: number; height: number };
  bubble: { x: number; y: number; width: number; height: number };
  arrowCenter: number;
  ring: { x: number; y: number; width: number; height: number };
  /** 말풍선과 대상의 세로 간격(음수 = 겹침). */
  gap: number;
}

/** 네 요소를 **한 프레임에서** 함께 잰다(따로 재면 서로 다른 시점이 섞인다). */
async function geometryOf(page: Page, targetTestId: string): Promise<Geometry | null> {
  return page.evaluate((id) => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const target = box(`[data-testid="${id}"]`);
    const bubble = box('[data-testid="tutorial-bubble"]');
    const arrow = box('[data-testid="tutorial-arrow"]');
    const ring = box('[data-testid="tutorial-highlight"]');
    if (!target || !bubble || !arrow || !ring) return null;
    const gap =
      bubble.y >= target.y + target.height
        ? bubble.y - (target.y + target.height)
        : target.y - (bubble.y + bubble.height);
    return {
      vp: { width: window.innerWidth, height: window.innerHeight },
      target,
      bubble,
      arrowCenter: arrow.x + arrow.width / 2,
      ring,
      gap,
    };
  }, targetTestId);
}

/**
 * **대상 중 화면에 보이는 부분** (#291).
 *
 * ⚠️ 링이 감싸야 하는 것은 대상 전체가 아니라 **보이는 부분**이다. 하이라이트 구멍은
 * `TutorialOverlay.tsx:246-249` 에서 뷰포트로 **일부러 clamp** 된다 — 딤 처리의 구멍이 화면 밖으로
 * 나가면 안 되기 때문이다. 그런데 대상이 뷰포트보다 클 수 있다: 1280×720 에서 전술보드는 625px 에
 * 문서 좌표 188~813 이라 **하단 93px 이 화면 밖**이다.
 *
 * 옛 계약은 `ring.bottom >= target.bottom` 을 요구해서 이 경우 **구조적으로 만족 불가**였고,
 * 5초를 꽉 채우고 실패했다(#244 덱 재설계 이래 main 상시 red). 그때 `test.fail()` 로 박제해 뒀는데
 * ⚠️ **기대실패는 초록으로 집계되므로 "87 passed" 가 이 결함을 가려 준다** — 지워야 할 부류의 핀이다.
 *
 * 완화하되 **약화하지는 않는다**: 보이는 부분은 여전히 **전부** 감싸야 한다. 링이 대상을 안 가리키는
 * 진짜 결함(이 계약의 존재 이유)은 그대로 잡힌다.
 */
function visibleTarget(g: Geometry) {
  const { target, vp } = g;
  const left = Math.max(target.x, 0);
  const top = Math.max(target.y, 0);
  const right = Math.min(target.x + target.width, vp.width);
  const bottom = Math.min(target.y + target.height, vp.height);
  return { left, top, right, bottom };
}

/** 아래 개별 단언과 같은 기준 — 폴링용 요약 술어. */
function settled(g: Geometry | null): boolean {
  if (!g) return false;
  const { target, bubble, arrowCenter, ring, vp, gap } = g;
  const v = visibleTarget(g);
  return (
    gap >= -2 &&
    gap < 40 &&
    arrowCenter >= target.x - 2 &&
    arrowCenter <= target.x + target.width + 2 &&
    bubble.x >= 0 &&
    bubble.y >= 0 &&
    bubble.x + bubble.width <= vp.width &&
    bubble.y + bubble.height <= vp.height &&
    ring.x <= v.left &&
    ring.y <= v.top &&
    ring.x + ring.width >= v.right &&
    ring.y + ring.height >= v.bottom
  );
}

/**
 * AC-B2 — 말풍선이 **대상 요소를 실제로 가리키는지** 실측한다.
 *  (1) 말풍선이 대상 바로 위/아래에 붙어 있다.
 *  (2) 화살표의 x 중심이 대상의 가로 범위 안에 있다(= 대상을 가리킨다).
 *  (3) 말풍선·하이라이트가 뷰포트 안에 있고 링이 대상을 감싼다.
 *
 * `toBeVisible` 은 opacity:0 도 통과하므로 좌표를 직접 잰다. 단, 로비는 지연 쿼리로
 * 콘텐츠가 늘어나며 대상이 밀리므로 **배치가 안정될 때까지 기다린 뒤** 실측한다.
 */
async function expectBubblePointsAt(page: Page, targetTestId: string) {
  // 배치가 **모든 기준을 동시에** 만족할 때까지 기다린다. 한 조건만 폴링하면
  // 리사이즈 직후처럼 일부만 갱신된 프레임을 '안정'으로 오인한다.
  await expect
    .poll(async () => settled(await geometryOf(page, targetTestId)), {
      message: `말풍선이 ${targetTestId} 를 가리킬 때까지`,
      timeout: 5000,
    })
    .toBe(true);

  const g = await geometryOf(page, targetTestId);
  expect(g, `${targetTestId} 배치 실측`).not.toBeNull();
  const { target, bubble, arrowCenter, ring, vp, gap } = g!;

  // (1) 대상 위/아래로 붙어 있다 — 화면 반대편에 떠 있지 않다.
  expect(gap, "말풍선-대상 간격").toBeLessThan(40);
  expect(gap, "말풍선-대상 겹침").toBeGreaterThanOrEqual(-2);

  // (2) 화살표가 대상의 가로 범위 안을 가리킨다.
  expect(arrowCenter, "화살표 중심 ≥ 대상 좌측").toBeGreaterThanOrEqual(target.x - 2);
  expect(arrowCenter, "화살표 중심 ≤ 대상 우측").toBeLessThanOrEqual(
    target.x + target.width + 2,
  );

  // (3) 뷰포트 안.
  expect(bubble.x).toBeGreaterThanOrEqual(0);
  expect(bubble.y).toBeGreaterThanOrEqual(0);
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(vp.width);
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(vp.height);

  // 하이라이트 링은 대상의 **보이는 부분**을 감싼다(#291 — `visibleTarget` 주석 참조).
  const v = visibleTarget(g!);
  expect(ring.x, "링 좌측 ≤ 대상 보이는 좌측").toBeLessThanOrEqual(v.left);
  expect(ring.y, "링 상단 ≤ 대상 보이는 상단").toBeLessThanOrEqual(v.top);
  expect(ring.x + ring.width, "링 우측 ≥ 대상 보이는 우측").toBeGreaterThanOrEqual(v.right);
  expect(ring.y + ring.height, "링 하단 ≥ 대상 보이는 하단").toBeGreaterThanOrEqual(v.bottom);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.describe("AC-B1 — 신규 유저 온보딩", () => {
  test("신규 가입 → 홈 진입 시 튜토리얼이 자동으로 시작한다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);

    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await expect(page.getByTestId("tutorial-progress")).toHaveText("1 / 7");
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");
    await expectBubblePointsAt(page, "home-tile-game");
  });

  test("'다음' 으로 상점·도감·리그를 지나 마지막 홈 스텝(덱 진입)까지 간다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);

    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");
    await page.getByTestId("tutorial-next").click();

    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");
    await expectBubblePointsAt(page, "home-tile-recruit");
    await page.getByTestId("tutorial-next").click();

    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "codex");
    await expectBubblePointsAt(page, "home-tile-players");
    await page.getByTestId("tutorial-next").click();

    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "league");
    await expect(page.getByTestId("tutorial-progress")).toHaveText("4 / 7");
    await page.getByTestId("tutorial-next").click();

    // 로비의 마지막 스텝 = '덱 구성' 버튼을 가리키는 CTA(다음 두 스텝은 덱 화면 안에 있다).
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck");
    await expect(page.getByTestId("tutorial-progress")).toHaveText("5 / 7");
    await expectBubblePointsAt(page, "home-tile-deck");
    /**
     * ⚠️ **#386 에서 뒤집힌 성질.** 예전엔 여기서 [다음]을 눌러도 완료로 저장하지 않았다
     * (덱 스텝 2개를 아직 안 봤으므로) — 그래서 라벨도 '다음'이었다. 그런데 이 클릭이 실제
     * 유저의 흔한 종료였고, 저장이 안 되니 **접속할 때마다 코치마크가 처음부터 다시 돌았다**
     * (덱 지급 트리거·공지 노출이 전부 그 뒤에 묶여 있었다). 지금은 **유저가 눌러서 끝낸 것은
     * 저장한다** — 그래서 라벨도 '시작하기'다(라벨과 저장이 어긋나면 안 된다).
     */
    await expect(page.getByTestId("tutorial-next")).toHaveText("시작하기");

    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    await expect(page.getByTestId("home-tile-game")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"))).toBe("1");
  });

  test("건너뛰기 → 즉시 종료", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);

    await page.getByTestId("tutorial-skip").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  });

  /**
   * AC-B1 핵심. **시작 트리거가 살아 있는 상태**에서 검증해야 의미가 있다 —
   * 서버가 계속 tutorialDone=false 를 주는(=매번 시작하라는) 상황에서도 저장된 완료 기록
   * 때문에 안 떠야 한다. 트리거 없는 상태로 검증하면 저장을 통째로 지워도 통과해버린다
   * (풀 리로드로 메모리 isNew 신호가 사라지므로 — 실제로 그런 tautological 테스트였다).
   */
  test("완료 기록이 있으면 시작 트리거가 있어도 다시 뜨지 않는다 (AC-B1 핵심)", async ({
    page,
  }) => {
    await mockApi(page, { tutorialDone: false }); // 서버는 계속 '안 끝났다'고 말한다
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();

    await page.getByTestId("tutorial-skip").click(); // 유저의 명시적 종료 → 완료 저장
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

    // 풀 리로드(메모리 신호 소멸) — 그래도 서버 false 라는 트리거는 남아 있다.
    await page.reload();
    await expect(page.getByTestId("home-tile-game")).toBeVisible();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

    // 로그아웃 → 재로그인해도 마찬가지.
    await page.getByRole("button", { name: "로그아웃" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await loginExistingUser(page);
    await expect(page.getByTestId("home-tile-game")).toBeVisible();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  });

  test("기존 유저 무회귀: 서버 필드 미발행 + isNew 아님 + 무기록 → 미노출", async ({ page }) => {
    await mockApi(page); // tutorialDone 필드 자체가 없다(구 서버)
    await loginExistingUser(page);
    await expect(page.getByTestId("home-tile-game")).toBeVisible();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  });

  test("다른 계정(userId)에는 완료 표시가 전이되지 않는다", async ({ page }) => {
    await mockApi(page, { userId: "u1" });
    await registerNewUser(page);
    await page.getByTestId("tutorial-skip").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

    // 같은 브라우저, 다른 유저 — 이 계정에겐 처음이므로 다시 시작한다.
    await page.getByRole("button", { name: "로그아웃" }).click();
    await mockApi(page, { userId: "u2" });
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  });

  test("서버 tutorialDone=true 면(발행 후) 신규 신호가 있어도 뜨지 않는다", async ({ page }) => {
    await mockApi(page, { tutorialDone: true });
    await registerNewUser(page);
    await expect(page.getByTestId("home-tile-game")).toBeVisible();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  });

  test("서버 tutorialDone=false 면 신규 신호 없이 로그인해도 시작한다", async ({ page }) => {
    await mockApi(page, { tutorialDone: false });
    await loginExistingUser(page);
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  });

  test("[내 정보]의 '튜토리얼 다시 보기' 로 언제든 다시 시작한다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await page.getByTestId("tutorial-skip").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

    // #286: 진입점이 로비 하단 → **[내 정보] 탭**으로 옮겼다(홈은 최대한 간결하게 — hero 3R).
    // 눌러도 홈으로 되돌아온다 — 코치마크 1스텝이 홈 타일을 가리키기 때문.
    await page.goto("/me");
    await page.getByTestId("tutorial-replay").click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await expect(page.getByTestId("tutorial-progress")).toHaveText("1 / 7");
  });
});

test.describe("접근성 — 키보드만으로 진행", () => {
  test("ESC 는 건너뛰기, Enter 는 다음", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);

    // 열리면 '다음' 에 포커스가 있다 → Enter 로 진행.
    await expect(page.getByTestId("tutorial-next")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  });
});

test.describe("AC-B2 — 모바일/데스크탑 배치", () => {
  for (const vp of [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1280, height: 900 },
  ]) {
    test(`${vp.name}(${vp.width}px): 모든 스텝이 대상을 가리키고 가로 오버플로 0`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockApi(page);
      await registerNewUser(page);

      // 로비 5스텝 — 마지막(deck)은 '다음'이 아니라 **하이라이트된 버튼**으로 넘어간다(골든 패스).
      const lobbySteps: [string, string][] = [
        ["play", "home-tile-game"],
        ["shop", "home-tile-recruit"],
        ["codex", "home-tile-players"],
        ["league", "home-tile-game"],
        ["deck", "home-tile-deck"],
      ];

      const shot = async (stepId: string, targetId: string) => {
        await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", stepId);
        await expectBubblePointsAt(page, targetId);
        expect(await horizontalOverflow(page), `${stepId} 가로 오버플로`).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: `test-results/tutorial-${vp.name}-${stepId}.png`,
          fullPage: false,
        });
      };

      for (const [stepId, targetId] of lobbySteps) {
        await shot(stepId, targetId);
        if (stepId !== "deck") await page.getByTestId("tutorial-next").click();
      }

      // 덱 화면으로 따라 들어간다 — 코치마크는 비-모달이라 대상 클릭이 그대로 통과한다.
      await page.getByTestId("home-tile-deck").click();
      await expect(page).toHaveURL(/\/deck$/);

      await shot("deck-board", "tactics-board");
      await page.getByTestId("tutorial-next").click();
      await shot("deck-save", "save-deck");

      await expect(page.getByTestId("tutorial-next")).toHaveText("시작하기");
      await page.getByTestId("tutorial-next").click();
      await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    });
  }

  test("리사이즈(방향전환)하면 말풍선이 대상을 다시 따라간다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await registerNewUser(page);
    await expectBubblePointsAt(page, "home-tile-game");

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();
    await expectBubblePointsAt(page, "home-tile-game");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("유저 이탈 — 온보딩을 삼키지 않는다 (blocker-1 회귀 가드)", () => {
  /** 완료 저장 여부를 스토리지에서 직접 확인한다. */
  async function doneFlag(page: Page, userId = "u1"): Promise<string | null> {
    return page.evaluate((id) => localStorage.getItem(`hmb.tutorial.done.${id}`), userId);
  }

  test("하이라이트된 버튼을 눌러 화면을 떠나도 '완료'로 저장되지 않는다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");

    // 코치마크는 대상 클릭을 통과시킨다 — 유저가 그대로 영입 화면으로 이동(#286).
    await page.getByTestId("home-tile-recruit").click();
    await expect(page).toHaveURL(/\/recruit$/);
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

    // ⚠️ 오버레이는 유예 중에도 렌더를 멈추므로 count 0 만으로는 중단이 확정된 게 아니다.
    // 남은 스텝이 각자 유예를 소진할 때까지 기다린 뒤에 저장 여부를 봐야 한다
    // (안 기다리면 "중단도 저장한다"는 회귀를 이 가드가 놓친다).
    await page.waitForTimeout(2500);

    // 유저가 끝낸 적이 없으므로 완료 기록이 있으면 안 된다.
    expect(await doneFlag(page)).toBeNull();
  });

  test("떠났다가 홈으로 돌아오면 온보딩이 재개된다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");
    await page.getByTestId("home-tile-recruit").click();
    await expect(page).toHaveURL(/\/recruit$/);

    // 네비는 하단탭(모바일)/사이드바(데스크탑) 두 벌이 DOM 에 있고 CSS 로 하나만 보인다
    // → 보이는 쪽을 집는다(.first() 는 뷰포트에 따라 숨은 쪽을 잡는다).
    await page.locator('[data-testid="nav-home"]:visible').click();
    await expect(page).toHaveURL(/\/home$/);

    // 떠나기 직전 스텝에서 재개한다 — 중간 스텝을 잃지 않는다.
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");
    expect(await doneFlag(page)).toBeNull();
  });

  test("반대로 '건너뛰기'(명시적 종료)는 저장한다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await page.getByTestId("tutorial-skip").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    expect(await doneFlag(page)).toBe("1");
  });

  test("골든 패스(덱까지 끝까지) 의 '시작하기'(명시적 완료)는 저장한다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    for (let i = 0; i < 4; i += 1) await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck");

    // 로비 마지막 스텝에서는 아직 완료가 아니다(덱 스텝 2개가 남았다).
    expect(await doneFlag(page)).toBeNull();

    await page.getByTestId("home-tile-deck").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck-board");
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck-save");

    await expect(page.getByTestId("tutorial-next")).toHaveText("시작하기");
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    expect(await doneFlag(page)).toBe("1");
  });
});

/**
 * BLK-1 — 로그아웃/세션만료(401)는 **리로드 없는 SPA 전환**이라 모듈 변수·ref 가 살아남는다.
 * 계정 경계에서 튜토리얼 세션 상태가 전부 버려지는지 실제 401 경로로 검증한다.
 */
test.describe("계정 전환 — 세션 상태 격리 (BLK-1 회귀 가드)", () => {
  /** u1 이 2/4 까지 보고 하이라이트 버튼으로 이탈한 뒤 401 로 세션이 끊긴 상태를 만든다. */
  async function newUserLeavesThenSessionExpires(page: Page, st: MockState) {
    await registerNewUser(page);
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");

    await page.getByTestId("home-tile-recruit").click(); // 이탈(저장 없음, resumeIndex 남음)
    await expect(page).toHaveURL(/\/recruit$/);
    // ⚠️ 대상 부재 유예(기본 400ms)가 **만료돼 중단이 확정될 때까지** 기다린다.
    // 오버레이는 유예 중에도 렌더를 멈춰(count 0) 있으므로 count 만으로는 중단을 알 수 없고,
    // 확정 전에 401 을 쏘면 resumeIndex 가 0 이라 "남의 재개 지점 승계"가 재현되지 않는다
    // (실제로 이 대기를 넣기 전에는 뮤테이션이 살아남았다).
    // 남은 스텝(shop→codex→league)이 **각각** 유예를 소진한 뒤에야 중단이 확정된다(≈1.2s+).
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    await page.waitForTimeout(2500);

    st.unauthorized = true;
    await page.locator('[data-testid="nav-home"]:visible').click(); // me 재조회 → 401
    await expect(page).toHaveURL(/\/login$/); // 리로드 없이 로그인 화면으로
  }

  test("재현 A: 세션만료 후 기존 유저가 로그인하면 튜토리얼이 뜨지 않는다", async ({ page }) => {
    const st = await mockApi(page);
    await newUserLeavesThenSessionExpires(page, st);

    // 같은 탭에서 **기존 유저** u2 로그인(isNew=false, 완료 기록 없음).
    st.unauthorized = false;
    st.userId = "u2";
    await fillLogin(page);

    await expect(page.getByTestId("home-tile-game")).toBeVisible();
    // u1 의 isNew 신호가 남아 u2 에게 튀면 안 된다.
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  });

  /**
   * BLK-1 재현: 로그아웃 직후 `/api/me` 왕복(모바일에서 흔한 400ms) 동안 쿼리 캐시가
   * **이전 계정**을 돌려주는 창이 있었고, 그 창에서 ESC 한 번이면 이전 계정에 완료가 박혔다.
   * (그 계정은 스텝을 하나도 안 봤다.)
   */
  test("재현 C: 로그아웃→신규가입 지연 창에서 ESC 해도 이전 계정에 저장되지 않는다", async ({
    page,
  }) => {
    const st = await mockApi(page);
    await registerNewUser(page); // u1 — 아무것도 보지 않고 바로 로그아웃
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await page.getByRole("button", { name: "로그아웃" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // /api/me 를 400ms 늦춘 채 u2 로 신규 가입.
    st.userId = "u2";
    st.meDelayMs = 400;
    await fillRegister(page);

    // 지연 창 동안 오버레이가 떠 있어도 ESC 는 이전 계정에 쓰면 안 된다.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);

    const keys = await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((k) => k.startsWith("hmb.tutorial.done."))
          .map((k) => [k, localStorage.getItem(k)]),
      ),
    );
    expect(keys["hmb.tutorial.done.u1"]).toBeUndefined();
  });

  test("재현 B: 세션만료 후 신규 유저는 1스텝부터 시작한다", async ({ page }) => {
    const st = await mockApi(page);
    await newUserLeavesThenSessionExpires(page, st);

    // 같은 탭에서 **완전 신규** u2 가입.
    st.unauthorized = false;
    st.userId = "u2";
    await fillRegister(page);

    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    // u1 의 재개 지점(2/4)을 물려받으면 u2 는 못 본 스텝이 완료 저장된다.
    await expect(page.getByTestId("tutorial-progress")).toHaveText("1 / 7");
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");
    // 이전 계정의 완료 기록도 남기지 않는다.
    expect(await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"))).toBeNull();
  });
});

/**
 * BLK-2 — 진행 상태의 SoT 는 "실제로 보여준 스텝(seen)" 집합이다.
 * 연쇄 스킵이 중간에 끊겨도, 라우트를 떠났다 와도 못 본 스텝은 완료 전에 반드시 나온다.
 */
test.describe("못 본 스텝은 완료를 막는다 (BLK-2 회귀 가드)", () => {
  test("메뉴가 잠깐 사라져 건너뛰어진 스텝은 완료 전에 다시 나온다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");

    // 상점 버튼만 잠깐 감춘다(지연/조건부 렌더) → shop 스텝이 유예 만료로 스킵된다.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="home-tile-recruit"]')!;
      el.style.display = "none";
      setTimeout(() => (el.style.display = ""), 1200);
    });
    await page.getByTestId("tutorial-next").click();

    // shop 을 건너뛰고 codex 로 갔다.
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "codex");

    // 다음 이동은 **못 본 shop**(그새 다시 나타났다) — 순서상 뒤인 league 보다 우선한다.
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");
    expect(await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"))).toBeNull();

    // 남은 로비 스텝(league → deck CTA)을 차례로 보여준다.
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "league");
    expect(await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"))).toBeNull();

    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck");

    // 여기까지가 이 가드의 본체다: **건너뛰어진 shop 이 완료 전에 반드시 다시 나왔다**.
    // (마지막 [다음]으로 유저가 끝내면 그건 완료 저장이다 — #386, 위 AC-B1 테스트가 소유한다.)
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"))).toBe("1");
  });

  test("브라우저 뒤로가기로 돌아와도 못 본 스텝부터 재개된다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");

    await page.getByTestId("home-tile-recruit").click();
    await expect(page).toHaveURL(/\/recruit$/);
    await page.waitForTimeout(2500); // 중단 확정

    await page.goBack();
    await expect(page).toHaveURL(/\/home$/);

    // 인앱 네비 복귀와 동일하게 재개돼야 한다. shop 은 이미 봤으므로 **못 본 codex** 부터다.
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "codex");
    expect(await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"))).toBeNull();
  });
});

test.describe("모달과의 공존 (blocker-2 회귀 가드)", () => {
  test("게임 탭으로 넘어가면 코치마크가 비켜나 모드 옵션을 가리지 않는다", async ({ page }) => {
    // #286: [게임 시작]이 **모달이 아니라 탭 이동**이 됐다. 가리는 주체가 모달 → 라우트로
    // 바뀌었을 뿐, 지키려는 것은 같다 — "코치마크가 다음에 눌러야 할 것을 덮지 않는다".
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");

    // 하이라이트된 '게임 시작'을 그대로 클릭 → 게임 탭.
    await page.getByTestId("home-tile-game").click();
    await expect(page).toHaveURL(/\/game$/);
    await expect(page.getByTestId("mode-practice")).toBeVisible();

    // 코치마크는 사라져 있어야 한다.
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

    // 옵션이 실제로 클릭 가능한지(가려지지 않았는지) 히트테스트로 확인한다.
    const hits = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="mode-practice"]')!;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el.contains(top) || top === el;
    });
    expect(hits, "'연습 경기' 옵션이 최상단이어야 한다").toBe(true);
    await page.screenshot({ path: "test-results/tutorial-modal-coexist.png" });

    // 홈으로 되돌아오면 같은 스텝에서 재개한다 — 나갔다 왔다고 스텝을 잃지 않는다.
    // (#286 이전엔 모달 [닫기]가 그 역할이었다. 모달이 화면으로 승격돼 닫을 것이 없어졌고,
    //  대신 **탭 복귀**가 같은 것을 보장해야 한다.)
    await page.locator('[data-testid="nav-home"]:visible').click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");
  });
});

test.describe("대상 부재 — 깨짐 0", () => {
  test("대상 요소가 사라지면 그 스텝을 건너뛰고 다음으로 간다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");

    // 상점 버튼을 DOM 에서 제거 = 아직 머지되지 않은 기능을 가리키는 상황.
    await page.evaluate(() => document.querySelector('[data-testid="home-tile-recruit"]')?.remove());
    await page.getByTestId("tutorial-next").click();

    // shop 을 건너뛰고 codex 로 — 무한 대기 없음.
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "codex");
    await expectBubblePointsAt(page, "home-tile-players");
  });

  test("모든 대상이 사라지면 오버레이가 종료된다(멈추지 않는다)", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();

    await page.evaluate(() => {
      for (const id of ["home-tile-game", "home-tile-recruit", "home-tile-players", "home-tile-deck"]) {
        document.querySelector(`[data-testid="${id}"]`)?.remove();
      }
      window.dispatchEvent(new Event("resize"));
    });

    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    // 유저가 끝낸 게 아니므로 완료로 저장하지 않는다(blocker-1).
    expect(
      await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1")),
    ).toBeNull();
  });
});

/**
 * 라우트를 넘나드는 스텝(로비 → 덱, #106 머지 후 실연결).
 *
 * 덱 스텝(전술보드·저장)은 /deck 에서만 보여줄 수 있다. 여기서 검증하는 계약:
 *  (a) 골든 패스 — 하이라이트된 '덱 구성'을 누르면 튜토리얼이 따라 들어와 이어진다.
 *  (b) 유저가 로비에서 '다음'으로 지나가도 **완료로 저장되지 않고**(못 본 스텝),
 *      로비를 다시 와도 **다시 뜨지 않으며**(방해 0), 처음 덱 화면에 들어갔을 때 이어진다.
 *      → "덱에 영영 안 가면 완료가 영구히 안 되는" 시나리오가 유저를 괴롭히지 않는지.
 */
test.describe("덱 스텝 — 라우트 넘나듦", () => {
  async function doneFlag(page: Page): Promise<string | null> {
    return page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"));
  }

  /** 로비 스텝 5개를 '다음'으로 지나 마지막(deck CTA)에 선다. */
  async function toDeckCta(page: Page) {
    for (let i = 0; i < 4; i += 1) await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck");
  }

  /**
   * ⚠️ **한때 `test.fail()` 로 박제돼 있었다 — 지웠다(#291 해결).**
   *
   * 증상: 전술보드가 뷰포트보다 커서(1280×720 에서 board 625px, 문서 좌표 188~813) 하이라이트 링이
   * 뷰포트에서 잘리고, `settled` 의 `ring.bottom >= target.bottom` 이 **영영 참이 될 수 없어**
   * 5초를 꽉 채우고 실패했다(#244 덱 재설계 이래 main 상시 red).
   *
   * 고친 것은 **계약**이다(`visibleTarget` 주석 참조). 링의 뷰포트 clamp 는 딤 구멍이 화면 밖으로
   * 나가지 않게 하는 **의도된 동작**이라 제품 쪽이 아니라 기대 쪽이 틀렸다 — 링은 대상 전체가
   * 아니라 **보이는 부분**을 감싸면 된다.
   *
   * ⚠️ **핀 자체가 더 위험했다**: `test.fail()` 은 실패해도 "passed" 로 집계돼, 이 파일을 돌린
   * 사람은 87/87 초록을 보고 **결함이 없다고 읽는다**(실제로 이 자리를 다시 조사하다 그렇게 오판할
   * 뻔했다). 구조적으로 만족 불가인 계약은 핀으로 덮지 말고 **기대를 고쳐라**.
   */
  test("(a) 하이라이트된 '덱 구성'을 누르면 덱 화면에서 그대로 이어진다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await toDeckCta(page);

    await page.getByTestId("home-tile-deck").click();
    await expect(page).toHaveURL(/\/deck$/);

    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck-board");
    await expect(page.getByTestId("tutorial-progress")).toHaveText("6 / 7");
    await expectBubblePointsAt(page, "tactics-board");

    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck-save");
    await expectBubblePointsAt(page, "save-deck");
    expect(await horizontalOverflow(page), "덱 화면 가로 오버플로").toBeLessThanOrEqual(0);

    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    expect(await doneFlag(page)).toBe("1");
  });

  /**
   * ⚠️ **시나리오를 #386 에 맞춰 바꿔 썼다.** 예전 (b) 는 "홈 마지막 스텝에서 [다음]을 눌러
   * 끝냈어도 저장하지 않고, 첫 덱 진입에서 이어진다"였다 — 그 클릭은 이제 **완료 저장**이다
   * (그 성질이 신규 유저에게 코치마크 무한 반복 + 공지 미노출을 만들었다).
   *
   * 지키려던 성질 자체("저장 없이 내려간 튜토리얼은 그 화면에 도착하면 이어진다")는 여전히
   * 살아 있고, 그 문은 이제 **대상 부재 스킵**이다 — 유저의 종료가 아니라 화면 사정으로 내려간
   * 경우. 그래서 그 경로로 다시 세운다.
   */
  test("(b) 대상 부재로 내려간 튜토리얼은 저장 없이, 첫 덱 진입에서 이어져 완료된다", async ({
    page,
  }) => {
    await mockApi(page);
    await registerNewUser(page);
    for (let i = 0; i < 3; i += 1) await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "league");

    // 덱 타일이 잠깐 안 그려진다(지연/조건부 렌더) → 마지막 홈 스텝이 유저 종료가 아니라
    // **화면 사정**으로 건너뛰어진다 → 저장 없이 내려간다.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="home-tile-deck"]')!;
      el.style.display = "none";
      setTimeout(() => (el.style.display = ""), 1500);
    });
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    expect(await doneFlag(page)).toBeNull();

    // 그러다 유저가 스스로 덱 화면에 들어가면 남은 스텝이 이어서 뜬다.
    await page.getByTestId("home-tile-deck").click();
    await expect(page).toHaveURL(/\/deck$/);
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck-board");

    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck-save");
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    expect(await doneFlag(page)).toBe("1");
  });

  test("(c) 덱 화면에서 '건너뛰기' 해도 즉시 종료하고 저장한다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await toDeckCta(page);
    await page.getByTestId("home-tile-deck").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck-board");

    await page.getByTestId("tutorial-skip").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    expect(await doneFlag(page)).toBe("1");
  });
});

/**
 * 덱 화면이 **느리게 뜨는** 경우(쿼리 지연) — 대상이 아직 없으니 덱 스텝은 유예 만료로
 * 스킵된다. 그래도 **완료로 저장하면 안 된다**(못 본 스텝이다). 다음 덱 방문에서 다시 뜬다.
 */
test.describe("덱 스텝 — 느린 로딩", () => {
  test("덱 화면이 늦게 그려지면 스킵하되 완료로 저장하지 않고, 재방문에서 다시 뜬다", async ({
    page,
  }) => {
    await mockApi(page);
    await registerNewUser(page);
    for (let i = 0; i < 4; i += 1) await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck");

    // 이 시점부터 /api/deck 이 아주 느리다(나중에 등록한 핸들러가 우선).
    let slow = true;
    await page.route(
      (url) => url.pathname === "/api/deck",
      async (route) => {
        if (slow) await new Promise((r) => setTimeout(r, 3000));
        return route.fulfill(json(DECK));
      },
    );

    await page.getByTestId("home-tile-deck").click();
    await expect(page).toHaveURL(/\/deck$/);
    // 대상이 없는 동안 덱 스텝들이 유예를 소진하고 오버레이가 내려간다.
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    await expect(page.getByTestId("tactics-board")).toBeVisible(); // 뒤늦게 로드됨
    expect(
      await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1")),
      "못 본 덱 스텝이 완료로 저장되면 안 된다",
    ).toBeNull();

    // 로비에 다녀와 다시 들어오면(이번엔 빠르다) 덱 스텝이 다시 뜬다.
    slow = false;
    await page.getByTestId("deck-back").click();
    await expect(page).toHaveURL(/\/home$/);
    await page.getByTestId("home-tile-deck").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "deck-board");
  });
});
