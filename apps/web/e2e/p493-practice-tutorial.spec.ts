import { expect, test, type Page } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * #493 W5 — **게임 시작 = 연습경기 튜토리얼 제안** E2E (route-mock 전용, 백엔드 무접촉).
 *
 * hero 판정으로 W1 의 미니게임(`/welcome` 60초 관전)이 통째로 걷혔다. 대신 첫 경험은
 * *"게임 시작을 눌렀을 때 연습경기로 튜토리얼을 해보겠냐고 묻고, 미리 준비한 덱으로 곧바로
 * 돌려서 보여준다"* 가 됐다 — 관전이 아니라 **진짜 경기**이고, 유저가 스스로 눌러서 시작한다.
 *
 * 보는 것:
 *  · ① 온보딩을 끝낸 신규 유저(pending 래치)가 홈 [게임 시작]을 누르면 제안 모달이 뜬다
 *  · ② 수락 = **온레일 시작**(덱 화면으로 이동) — 매치 생성은 덱 저장 뒤로 옮겨졌다(리플랜 v3)
 *  · ③ 거절 = 일반 흐름(/game)으로 가고 **다시 묻지 않는다**
 *  · ④ **래치 없는 유저(기존 유저·목 유저)에게는 절대 안 뜬다** — GuideProvider 와 같은 게이트다.
 *       이 게이트가 무너지면 토큰만 심는 다른 스펙 전부가 이 모달에 막힌다.
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const USER_ID = "u493p";

const DECK = {
  formation: "4-3-3",
  slots: Array.from({ length: 11 }, (_, i) => ({
    playerId: `P${String(i + 1).padStart(3, "0")}`,
    role: "starter",
    order: i,
    promptText: "",
  })),
};

interface St {
  createCalls: number;
}

async function mockApi(page: Page): Promise<St> {
  const st: St = { createCalls: 0 };
  // ⚠️ 라우트 글롭은 **오리진 앵커**다(pathname 판정) — 안 그러면 vite 자산까지 먹어 흰 화면이 된다.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: USER_ID, nickname: "연습감독", tutorialDone: true },
          wallet: { points: 3000, gems: 0 },
          records: { wins: 0, draws: 0, losses: 0 },
          rating: 1000,
        }),
      ),
  );
  await page.route((url) => url.pathname === "/api/deck", (route) => route.fulfill(json(DECK)));
  await page.route(
    (url) => url.pathname === "/api/players",
    (route) =>
      route.fulfill(
        json(
          Array.from({ length: 14 }, (_, i) => ({
            id: `P${String(i + 1).padStart(3, "0")}`,
            name: `선수${i + 1}`,
            shortName: `S${i + 1}`,
            position: "MF",
            grade: "C",
            attributes: {},
            owned: true,
            ownedCount: 1,
            active: true,
          })),
        ),
      ),
  );
  await page.route(
    (url) => url.pathname === "/api/matches" && url.href.length > 0,
    (route) => {
      if (route.request().method() !== "POST") return route.fulfill(json({}));
      st.createCalls++;
      return route.fulfill(json({ id: "m493", state: "BRIEFING" }));
    },
  );
  return st;
}

/** 온보딩을 막 끝낸 계정 = 토큰 + **가이드 pending 래치**(TutorialProvider.persistIfOwner 가 심는 것). */
async function seedNewUser(page: Page) {
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_user");
    window.localStorage.setItem(`hmb.guide.pending.${uid}`, "1");
  }, USER_ID);
}

/** 토큰만 있는 기존 유저(리포의 38개 스펙과 같은 상태). */
async function seedExistingUser(page: Page) {
  await skipSplash(page);
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
}

test("① 온보딩 직후 [게임 시작] = 연습경기 튜토리얼 제안 모달", async ({ page }) => {
  await mockApi(page);
  await seedNewUser(page);

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();

  const dialog = page.getByTestId("practice-tutorial-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("연습경기");
  // 모달이 뜬 동안에는 아직 아무 데도 가지 않았다.
  await expect(page).toHaveURL(/\/home$/);
});

test("② 수락 = **덱 화면부터**(온레일 시작) — 여기서 매치를 만들지 않는다", async ({ page }) => {
  const st = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("practice-tutorial-accept").click();

  /*
   * ⚠️ **W5 계약이 뒤집힌 자리다**(#493 리플랜 v3). 구 계약은 *"수락 = 그 자리에서 연습경기 생성
   * + `/match/:id` 직행"* 이었고, 그 근거는 hero 리플랜 v2 의 *"미리 준비한 덱으로 돌려서 보여줘야"*
   * 였다. 리플랜 v3 이 그 앞에 셋팅을 넣으면서 순서가 바뀌었다 — *"게임 시작하면 **셋팅부터**
   * 알려줘야하는데 지금 너무 자유도가 높아"*.
   *
   * 서버도 같은 순서를 요구한다: 튜토리얼 매치 생성은 덱 검증을 그대로 지나므로 덱이 없으면
   * 400 `DECK_REQUIRED` 다. 즉 "수락 즉시 매치"는 **신규 유저에게 성립할 수 없는 순서**였다.
   * 매치는 온레일이 S2(덱 저장)를 마친 뒤 [경기 시작] CTA 에서 만든다 —
   * 그 계약은 `p493-onrail.spec.ts` ④ 가 소유한다(`{tutorial:true}` 바디까지 본다).
   */
  await expect(page).toHaveURL(/\/deck$/);
  expect(st.createCalls, "이 화면은 더 이상 매치를 만들지 않는다").toBe(0);
  await expect(page.getByTestId("onrail-overlay")).toBeVisible();
});

test("③ 거절 = 일반 흐름(/game)으로 가고 다시 묻지 않는다", async ({ page }) => {
  const st = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("practice-tutorial-decline").click();

  await expect(page).toHaveURL(/\/game$/);
  expect(st.createCalls).toBe(0);

  // 재발화 없음 — 홈으로 돌아와 다시 눌러도 곧바로 /game 이다.
  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByTestId("practice-tutorial-dialog")).toHaveCount(0);
});

test("④ 래치 없는 기존 유저에게는 뜨지 않는다", async ({ page }) => {
  const st = await mockApi(page);
  await seedExistingUser(page);

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();

  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByTestId("practice-tutorial-dialog")).toHaveCount(0);
  expect(st.createCalls).toBe(0);
});
