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

const LOGIN_ID = "newbie01";
const PASSWORD = "sup3rs3cret";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

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
  await page.getByTestId("local-login-id").fill(LOGIN_ID);
  await page.getByTestId("local-password").fill(PASSWORD);
  await page.getByTestId("local-nickname").fill("신규감독");
  await page.getByTestId("local-submit").click();
  await page.getByRole("button", { name: "확인" }).click();
  await expect(page).toHaveURL(/\/lobby$/);
}

async function fillLogin(page: Page) {
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-login-id").fill(LOGIN_ID);
  await page.getByTestId("local-password").fill(PASSWORD);
  await page.getByTestId("local-submit").click();
  await expect(page).toHaveURL(/\/lobby$/);
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

/** 아래 개별 단언과 같은 기준 — 폴링용 요약 술어. */
function settled(g: Geometry | null): boolean {
  if (!g) return false;
  const { target, bubble, arrowCenter, ring, vp, gap } = g;
  return (
    gap >= -2 &&
    gap < 40 &&
    arrowCenter >= target.x - 2 &&
    arrowCenter <= target.x + target.width + 2 &&
    bubble.x >= 0 &&
    bubble.y >= 0 &&
    bubble.x + bubble.width <= vp.width &&
    bubble.y + bubble.height <= vp.height &&
    ring.x <= target.x &&
    ring.y <= target.y &&
    ring.x + ring.width >= target.x + target.width &&
    ring.y + ring.height >= target.y + target.height
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

  // 하이라이트 링은 대상을 감싼다.
  expect(ring.x).toBeLessThanOrEqual(target.x);
  expect(ring.y).toBeLessThanOrEqual(target.y);
  expect(ring.x + ring.width).toBeGreaterThanOrEqual(target.x + target.width);
  expect(ring.y + ring.height).toBeGreaterThanOrEqual(target.y + target.height);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.describe("AC-B1 — 신규 유저 온보딩", () => {
  test("신규 가입 → 로비 진입 시 튜토리얼이 자동으로 시작한다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);

    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await expect(page.getByTestId("tutorial-progress")).toHaveText("1 / 4");
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");
    await expectBubblePointsAt(page, "play-cta");
  });

  test("'다음' 으로 상점·도감·리그 스텝을 지나 완료하면 오버레이가 닫힌다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);

    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");
    await page.getByTestId("tutorial-next").click();

    // deck 스텝은 enabled:false (TODO(#106)) 라 아예 실행 목록에 없다.
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");
    await expectBubblePointsAt(page, "lobby-shop");
    await page.getByTestId("tutorial-next").click();

    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "codex");
    await expectBubblePointsAt(page, "lobby-codex");
    await page.getByTestId("tutorial-next").click();

    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "league");
    await expect(page.getByTestId("tutorial-progress")).toHaveText("4 / 4");
    await expect(page.getByTestId("tutorial-next")).toHaveText("시작하기");
    await page.getByTestId("tutorial-next").click();

    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    // 로비는 그대로 조작 가능하다.
    await expect(page.getByTestId("play-cta")).toBeVisible();
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
    await expect(page.getByTestId("play-cta")).toBeVisible();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

    // 로그아웃 → 재로그인해도 마찬가지.
    await page.getByRole("button", { name: "로그아웃" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await loginExistingUser(page);
    await expect(page.getByTestId("play-cta")).toBeVisible();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  });

  test("기존 유저 무회귀: 서버 필드 미발행 + isNew 아님 + 무기록 → 미노출", async ({ page }) => {
    await mockApi(page); // tutorialDone 필드 자체가 없다(구 서버)
    await loginExistingUser(page);
    await expect(page.getByTestId("play-cta")).toBeVisible();
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
    await expect(page.getByTestId("play-cta")).toBeVisible();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  });

  test("서버 tutorialDone=false 면 신규 신호 없이 로그인해도 시작한다", async ({ page }) => {
    await mockApi(page, { tutorialDone: false });
    await loginExistingUser(page);
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  });

  test("로비의 '튜토리얼 다시 보기' 로 언제든 다시 시작한다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await page.getByTestId("tutorial-skip").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

    await page.getByTestId("tutorial-replay").click();
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await expect(page.getByTestId("tutorial-progress")).toHaveText("1 / 4");
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

      const steps: [string, string][] = [
        ["play", "play-cta"],
        ["shop", "lobby-shop"],
        ["codex", "lobby-codex"],
        ["league", "play-cta"],
      ];

      for (const [stepId, targetId] of steps) {
        await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", stepId);
        await expectBubblePointsAt(page, targetId);
        expect(await horizontalOverflow(page), `${stepId} 가로 오버플로`).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: `test-results/tutorial-${vp.name}-${stepId}.png`,
          fullPage: false,
        });
        await page.getByTestId("tutorial-next").click();
      }

      await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    });
  }

  test("리사이즈(방향전환)하면 말풍선이 대상을 다시 따라간다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await registerNewUser(page);
    await expectBubblePointsAt(page, "play-cta");

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();
    await expectBubblePointsAt(page, "play-cta");
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

    // 코치마크는 대상 클릭을 통과시킨다 — 유저가 그대로 상점으로 이동.
    await page.getByTestId("lobby-shop").click();
    await expect(page).toHaveURL(/\/shop$/);
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

    // ⚠️ 오버레이는 유예 중에도 렌더를 멈추므로 count 0 만으로는 중단이 확정된 게 아니다.
    // 남은 스텝이 각자 유예를 소진할 때까지 기다린 뒤에 저장 여부를 봐야 한다
    // (안 기다리면 "중단도 저장한다"는 회귀를 이 가드가 놓친다).
    await page.waitForTimeout(2500);

    // 유저가 끝낸 적이 없으므로 완료 기록이 있으면 안 된다.
    expect(await doneFlag(page)).toBeNull();
  });

  test("떠났다가 로비로 돌아오면 온보딩이 재개된다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");
    await page.getByTestId("lobby-shop").click();
    await expect(page).toHaveURL(/\/shop$/);

    // 네비는 하단탭(모바일)/사이드바(데스크탑) 두 벌이 DOM 에 있고 CSS 로 하나만 보인다
    // → 보이는 쪽을 집는다(.first() 는 뷰포트에 따라 숨은 쪽을 잡는다).
    await page.locator('[data-testid="nav-home"]:visible').click();
    await expect(page).toHaveURL(/\/lobby$/);

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

  test("마지막 스텝 '시작하기'(명시적 완료)도 저장한다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    for (let i = 0; i < 3; i += 1) await page.getByTestId("tutorial-next").click();
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

    await page.getByTestId("lobby-shop").click(); // 이탈(저장 없음, resumeIndex 남음)
    await expect(page).toHaveURL(/\/shop$/);
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

    await expect(page.getByTestId("play-cta")).toBeVisible();
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
    await expect(page.getByTestId("tutorial-progress")).toHaveText("1 / 4");
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
      const el = document.querySelector<HTMLElement>('[data-testid="lobby-shop"]')!;
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

    // 남은 league 까지 보여준 뒤에야 저장된다.
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "league");
    expect(await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"))).toBeNull();

    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"))).toBe("1");
  });

  test("브라우저 뒤로가기로 돌아와도 못 본 스텝부터 재개된다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await page.getByTestId("tutorial-next").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "shop");

    await page.getByTestId("lobby-shop").click();
    await expect(page).toHaveURL(/\/shop$/);
    await page.waitForTimeout(2500); // 중단 확정

    await page.goBack();
    await expect(page).toHaveURL(/\/lobby$/);

    // 인앱 네비 복귀와 동일하게 재개돼야 한다. shop 은 이미 봤으므로 **못 본 codex** 부터다.
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "codex");
    expect(await page.evaluate(() => localStorage.getItem("hmb.tutorial.done.u1"))).toBeNull();
  });
});

test.describe("모달과의 공존 (blocker-2 회귀 가드)", () => {
  test("모드 선택 모달이 열리면 코치마크가 비켜나 옵션을 가리지 않는다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");

    // 하이라이트된 '게임 시작'을 그대로 클릭 → 모드 선택 모달.
    await page.getByTestId("play-cta").click();
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

    // 모달을 닫으면 같은 스텝으로 돌아온다.
    await page.getByRole("button", { name: "닫기" }).click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");
  });
});

test.describe("대상 부재 — 깨짐 0", () => {
  test("대상 요소가 사라지면 그 스텝을 건너뛰고 다음으로 간다", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");

    // 상점 버튼을 DOM 에서 제거 = 아직 머지되지 않은 기능을 가리키는 상황.
    await page.evaluate(() => document.querySelector('[data-testid="lobby-shop"]')?.remove());
    await page.getByTestId("tutorial-next").click();

    // shop 을 건너뛰고 codex 로 — 무한 대기 없음.
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "codex");
    await expectBubblePointsAt(page, "lobby-codex");
  });

  test("모든 대상이 사라지면 오버레이가 종료된다(멈추지 않는다)", async ({ page }) => {
    await mockApi(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-overlay")).toBeVisible();

    await page.evaluate(() => {
      for (const id of ["play-cta", "lobby-shop", "lobby-codex"]) {
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
