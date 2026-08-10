import { expect, test, type Page } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * #493 W1 — 첫 경험 미니게임 E2E (route-mock 전용, 백엔드/데모 8080 무접촉).
 *
 * hero C(하이브리드) 확정: 신규 가입의 기본 착지 = `/welcome` 1분 미니게임(저장 리플레이 주입,
 * AI 대기 0·실패 모드 0) → CTA/건너뛰기 → 홈(온보딩 시작). 보는 것:
 *  · ① 가입 → 스타터 확인 → `/welcome` 착지, 재생이 **실제로 흐른다**(틱 전진 — 캔버스 존재만으로는
 *       autoplay 가 죽은 변이를 못 잡는다)
 *  · ② 미니게임 자산은 정적 번들이다 — 체류 중 `/api/*` 접촉이 부트스트랩(config·me) 밖에 없다
 *  · ③ [건너뛰기] → 홈 + 온보딩 코치마크 자동 시작(미니게임이 튜토리얼을 소모하지 않는다)
 *  · ④ 끝까지 재생 → 종료 오버레이(컷 시점 스코어 1:1) + CTA → 홈
 *  · ⑤ 딥링크 가입은 미니게임을 건너뛴다(#298 — 링크로 온 사람의 목적은 그 목적지다)
 *  · ⑥ 390px 가로 오버플로 0
 *
 * ⚠️ 라우트 매칭은 glob 이 아니라 **pathname 술어**로(p4-starter-onboarding.spec.ts 선례) —
 *    glob('**\/api/**') 은 vite 소스(/src/api/*)까지 잡아 흰 화면이 된다.
 * ⚠️ 재생 압축은 `window.__viewer.seek()` 로 한다(#177 QA 훅) — 58초 실재생을 기다리면 스위트가
 *    그 시간만큼 물리적으로 느려진다. ④ 가 "끝 근처 → 자연 재생 → 종료" 경로는 실제로 태운다.
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mockApi(page: Page) {
  // catch-all 먼저 — Playwright 는 나중에 등록한 핸들러가 우선한다.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: "u493", nickname: "신규감독", tutorialDone: false },
          wallet: { points: 3000 },
          records: { wins: 0, draws: 0, losses: 0 },
        }),
      ),
  );
  await page.route(
    (url) => url.pathname === "/api/me/starter-grant",
    (route) => route.fulfill(json({ granted: false, player: null })),
  );
  await page.route(
    (url) => url.pathname === "/api/auth/register",
    (route) =>
      route.fulfill(json({ token: "tok_493", user: { id: "u493", nickname: "신규감독" }, isNew: true })),
  );
  await page.route(
    (url) => url.pathname === "/api/deck",
    (route) => route.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404)),
  );
}

/** 가입 → 스타터 안내 닫기까지(지급 없는 계정 — 카드 연출 없이 문구만). */
async function register(page: Page, path = "/login") {
  await skipSplash(page);
  await page.goto(path);
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-mode-toggle").click();
  await page.getByTestId("local-nickname").fill("mini493");
  await page.getByTestId("local-password").fill("sup3rs3cret");
  await page.getByTestId("local-submit").click();
  await expect(page.getByTestId("starter-reveal")).toBeVisible();
  await page.getByTestId("starter-reveal-close").click();
}

// ⚠️ page.evaluate 안에서는 Node 스코프 함수를 참조할 수 없다(직렬화 경계) — window 접근을 인라인한다.
type ViewerHooks = { ready?: () => boolean; cur?: () => { tick: number }; seek?: (t: number) => void; play?: () => void };

async function waitViewerReady(page: Page) {
  await page.waitForFunction(() => {
    const v = (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer;
    return Boolean(v?.ready?.());
  });
}

test("① 신규 가입 착지 = /welcome, 재생이 실제로 흐른다", async ({ page }) => {
  await mockApi(page);
  await register(page);
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByTestId("minigame-stage")).toBeVisible();

  await waitViewerReady(page);
  const t1 = await page.evaluate(
    () => (window as unknown as { __viewer?: ViewerHooks }).__viewer!.cur!().tick,
  );
  await page.waitForFunction(
    (prev) => {
      const v = (window as unknown as { __viewer?: { cur?: () => { tick: number } } }).__viewer;
      return (v?.cur?.().tick ?? 0) > prev;
    },
    t1,
    { timeout: 10000 },
  );
});

test("② 체류 중 서버 접촉 0 — 자산은 정적 번들이다", async ({ page }) => {
  await mockApi(page);
  await register(page);
  await expect(page).toHaveURL(/\/welcome$/);
  await waitViewerReady(page);

  const apiCalls: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) apiCalls.push(u.pathname);
  });
  // 재생 구간을 실제로 통과시킨다(초반 → 끝 근처 → 종료 오버레이).
  await page.evaluate(() => {
    const v = (window as unknown as { __viewer?: ViewerHooks }).__viewer!;
    v.seek!(340);
    v.play!();
  });
  await expect(page.getByTestId("minigame-end")).toBeVisible({ timeout: 15000 });

  // 앱 부트스트랩(런타임 config·세션 갱신) 밖의 어떤 API 도 부르지 않는다 — 특히 매치/덱 계열 0.
  const outside = apiCalls.filter((p) => p !== "/api/config" && p !== "/api/me");
  expect(outside, `미니게임 체류 중 API 호출: ${outside.join(", ")}`).toEqual([]);
});

test("③ [건너뛰기] → 홈, 온보딩이 이어서 시작된다", async ({ page }) => {
  await mockApi(page);
  await register(page);
  await expect(page).toHaveURL(/\/welcome$/);

  await page.getByTestId("minigame-skip").click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
});

test("④ 끝까지 재생 → 종료 오버레이(1:1) + CTA → 홈", async ({ page }) => {
  await mockApi(page);
  await register(page);
  await waitViewerReady(page);

  await page.evaluate(() => {
    const v = (window as unknown as { __viewer?: ViewerHooks }).__viewer!;
    v.seek!(340);
    v.play!();
  });
  const end = page.getByTestId("minigame-end");
  await expect(end).toBeVisible({ timeout: 15000 });
  // 컷 시점 스코어와 정합(AC1 계약과 같은 축) — 원본 90분 스코어(4:4)가 새면 여기서 죽는다.
  await expect(end).toContainText("1 : 1");

  await page.getByTestId("minigame-cta").click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
});

test("⑤ 딥링크 가입은 미니게임을 건너뛴다(#298)", async ({ page }) => {
  await mockApi(page);
  await register(page, "/login?returnTo=%2Fdeck");
  await expect(page).toHaveURL(/\/deck$/);
});

test("⑥ 390px — 가로 오버플로 0, 무대·CTA 가 화면 안", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await register(page);
  await expect(page.getByTestId("minigame-stage")).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "가로 오버플로").toBeLessThanOrEqual(0);

  const skip = await page.getByTestId("minigame-skip").boundingBox();
  expect(skip).not.toBeNull();
  expect(skip!.x).toBeGreaterThanOrEqual(0);
  expect(skip!.x + skip!.width).toBeLessThanOrEqual(390);
});
