import { expect, test, type Page } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * #493 W2 — 화면별 첫 진입 가이드 E2E (route-mock 전용, 백엔드 무접촉).
 *
 * 보는 것:
 *  · ① 온보딩을 끝낸 신규 유저가 /game 에 처음 들어가면 가이드가 뜬다(자기 진행표시 1 / 3,
 *       마지막 라벨 "확인") → 완주하면 같은 화면 재진입에 다시 안 뜬다
 *  · ② 가이드는 온보딩 완료 저장(POST /api/me/tutorial-complete)을 **추가로 부르지 않는다**
 *       (분리 프로바이더 — 이 호출은 서버 덱 지급 트리거라 가이드가 만지면 사고다)
 *  · ③ **래치 없는 유저(기존 유저)에게는 어떤 화면에서도 안 뜬다** — tutorialDone:true 목이
 *       38개 스펙에 있다: 이 게이트가 무너지면 e2e 전체가 가이드에 덮인다
 *  · ④ /recruit 가이드 — 건너뛰기도 seen(다시 조르지 않는다)
 *  · ⑤ /me '화면 안내 다시 보기' → seen 이 비워져 그 자리(/me)에서 즉시 재발화
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface St {
  completeCalls: number;
}

async function mockApi(page: Page): Promise<St> {
  const st: St = { completeCalls: 0 };
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: "u493g", nickname: "가이드감독", tutorialDone: false },
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
    (url) => url.pathname === "/api/me/tutorial-complete",
    (route) => {
      st.completeCalls++;
      return route.fulfill(json({ tutorialDone: true, deckGranted: false }));
    },
  );
  await page.route(
    (url) => url.pathname === "/api/auth/register",
    (route) =>
      route.fulfill(json({ token: "tok_g", user: { id: "u493g", nickname: "가이드감독" }, isNew: true })),
  );
  /*
   * ⚠️ **이 404 는 이 스펙을 우연히 지켜 주고 있다**(#504 D1-A 독립 검증 m4 — 기록해 둔다).
   *
   * 이 스펙은 온보딩을 앱 안에서 완주해 **가이드 pending 래치를 실제로 세우는 유일한 스펙**인데,
   * 그 래치는 연습경기 튜토리얼 **제안의 발화 조건과 같다**(`shouldOfferPracticeTutorial`). 그리고
   * 제안 판정은 `/game` **도착**에서 돈다(#504 D1-A) — 즉 여기서 덱을 200 으로 주면 `/game` 스텝에서
   * **제안 모달이 가이드보다 먼저 떠** 진행도 단언(`"1 / 3"` 등)이 흔들릴 수 있다.
   *
   * 지금은 404 라 판정이 `deckless-first` 로 빠져 모달이 안 뜬다. 덱을 주도록 바꿀 일이 생기면
   * **그 사실을 먼저 보고** 바꿔라(모달을 먼저 답하게 하거나, 래치를 심지 않는 경로로 바꾸거나).
   */
  await page.route(
    (url) => url.pathname === "/api/deck",
    (route) => route.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404)),
  );
  return st;
}

/** 가입 → 홈 온보딩 건너뛰기 = 가이드 래치가 서는 지점까지. */
async function newUserPastOnboarding(page: Page) {
  await skipSplash(page);
  await page.goto("/login");
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-mode-toggle").click();
  await page.getByTestId("local-nickname").fill("guide493");
  await page.getByTestId("local-password").fill("sup3rs3cret");
  await page.getByTestId("local-submit").click();
  await page.getByTestId("starter-reveal-close").click();
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await page.getByTestId("tutorial-skip").click();
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
}

test("① 온보딩 뒤 첫 /game 진입 = 가이드(1 / 3, 마지막 '확인') → 완주 후 재진입 무노출", async ({ page }) => {
  const st = await mockApi(page);
  await newUserPastOnboarding(page);

  await page.goto("/game");
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await expect(page.getByTestId("tutorial-progress")).toContainText("1 / 3");

  await page.getByTestId("tutorial-next").click();
  await expect(page.getByTestId("tutorial-progress")).toContainText("2 / 3");
  await page.getByTestId("tutorial-next").click();
  await expect(page.getByTestId("tutorial-next")).toHaveText("확인");
  await page.getByTestId("tutorial-next").click();
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

  // 재진입 — 다시 안 뜬다.
  await page.goto("/home");
  await page.goto("/game");
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

  // ② 가이드는 온보딩 완료 저장을 추가로 부르지 않았다(온보딩 건너뛰기의 1회뿐).
  expect(st.completeCalls).toBe(1);
});

test("③ 래치 없는 유저(기존 유저)에게는 어느 화면에서도 안 뜬다", async ({ page }) => {
  await mockApi(page);
  await skipSplash(page);
  // 온보딩을 거치지 않고 토큰만 심는다 = tutorialDone:true 목 유저들과 같은 상태.
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
  for (const path of ["/game", "/recruit", "/me", "/league", "/away", "/players"]) {
    await page.goto(path);
    await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  }
});

test("④ /recruit 가이드 — 건너뛰기 = seen, 재진입 무노출", async ({ page }) => {
  await mockApi(page);
  await newUserPastOnboarding(page);

  await page.goto("/recruit");
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await page.getByTestId("tutorial-skip").click();
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

  await page.goto("/home");
  await page.goto("/recruit");
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
});

test("⑤ /me '화면 안내 다시 보기' → 그 자리에서 즉시 재발화", async ({ page }) => {
  await mockApi(page);
  await newUserPastOnboarding(page);

  // /me 가이드를 소진해 둔다.
  await page.goto("/me");
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await page.getByTestId("tutorial-skip").click();
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

  await page.getByTestId("guide-replay").click();
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
});
