import { expect, test, type Page } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * #493 W6 — **덱 인터랙티브 가이드**(행동 완료형) E2E. route-mock 전용, 백엔드 무접촉.
 *
 * hero 리플랜 v2: *"덱셋팅도 하나씩 움직여보게해서 auto누르게하고 한마디 써보게하고 그다음
 * 저장하면 보상주고."* — 다른 화면 가이드가 [다음] 클릭으로 넘어가는 설명형인 것과 달리,
 * 덱만은 **유저가 그 행동을 실제로 해야** 다음 스텝으로 간다.
 *
 * 보는 것:
 *  · ① pending 래치 유저의 첫 /deck = 행동 스텝 1 (**[다음] 없음** + `data-advance-on`)
 *  · ② 선수 이동 → 스텝 2 자동 진행
 *  · ③ [⚡ 자동 채우기] → 스텝 3
 *  · ④ 한마디 입력(blur) → 스텝 4
 *  · ⑤ [저장] → PUT /api/deck 1회 + 마지막 **보상 안내**(설명형, [확인])
 *  · ⑥ [건너뛰기] 는 행동 스텝에서도 산다(못/안 하는 유저의 탈출구) + 재진입 무노출
 *  · ⑦ 래치 없는 유저(= tutorialDone:true 목 38개 스펙)에게는 안 뜬다
 *
 * ⚠️ 이동은 **클릭 기반 동선**으로 태운다(데스크탑 기본 뷰포트). 폰 롱프레스 드래그는
 * `p439`/`p442` 가 이미 자기 하네스(CDP 실터치)로 재는 축이고, 여기서 재고 싶은 것은
 * 제스처가 아니라 **"이동이 일어나면 가이드가 넘어간다"** 이다. 세 동선(드래그·엔트리·목록
 * 선택)이 `DeckEditor.moveToSlot` 한 곳으로 모이는 것은 그 파일이 계약으로 들고 있다.
 */

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const P = (id: string, name: string, position: string, ov: number) => ({
  id, name, position, grade: "SILVER", owned: true, ownedCount: 1,
  attributes: attrs(ov), personality: "CALM",
});

/** 보유 13명 — 선발 11 + 벤치 1 로 시작해 **빈 자리를 남긴다**(그래야 [⚡ 자동 채우기]가 뜬다). */
const PLAYERS = [
  P("GK1", "골리원", "GK", 70), P("GK2", "골리투", "GK", 62),
  P("DF1", "수비하나", "DF", 76), P("DF2", "수비둘", "DF", 68),
  P("DF3", "수비셋", "DF", 64), P("DF4", "수비넷", "DF", 55),
  P("MF1", "미드하나", "MF", 84), P("MF2", "미드둘", "MF", 74),
  P("MF3", "미드셋", "MF", 66), P("MF4", "미드넷", "MF", 61),
  P("FW1", "공격하나", "FW", 90), P("FW2", "공격둘", "FW", 72),
  P("FW3", "공격셋", "FW", 69),
];
const ELEVEN = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1", "FW2"];

function deckSlots() {
  return [
    ...ELEVEN.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
    { playerId: "FW3", role: "bench", slotIndex: 0, promptText: null },
  ];
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface St {
  deckPuts: number;
  completeCalls: number;
  lastPut: { slots?: { playerId: string; promptText: string | null }[] } | null;
}

async function mockApi(page: Page): Promise<St> {
  const st: St = { deckPuts: 0, completeCalls: 0, lastPut: null };
  const state = { deck: { formation: "4-4-2", slots: deckSlots() as unknown[], teamPrompt: null as string | null } };

  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (r) => r.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/presets", (r) => r.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/presets/team", (r) =>
    r.fulfill(json([1, 2, 3].map((slot) => ({ slot, name: null, snapshot: null })))));
  await page.route((url) => url.pathname === "/api/relations", (r) =>
    r.fulfill(json({ morale: 60, streak: 0, players: [] })));
  await page.route((url) => url.pathname === "/api/conditions/today", (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/growth/choices", (r) => r.fulfill(json({ choices: [] })));
  await page.route((url) => url.pathname === "/api/me", (r) =>
    r.fulfill(json({
      user: { id: "u493d", nickname: "덱감독", tutorialDone: false },
      wallet: { points: 3000 },
      records: { wins: 0, draws: 0, losses: 0 },
    })));
  await page.route((url) => url.pathname === "/api/me/active-match", (r) =>
    r.fulfill(json({ match: null, locked: false, abandonable: false })));
  await page.route((url) => url.pathname === "/api/me/starter-grant", (r) =>
    r.fulfill(json({ granted: false, player: null })));
  await page.route((url) => url.pathname === "/api/me/tutorial-complete", (r) => {
    st.completeCalls++;
    return r.fulfill(json({ tutorialDone: true, deckGranted: false }));
  });
  await page.route((url) => url.pathname === "/api/auth/register", (r) =>
    r.fulfill(json({ token: "tok_d", user: { id: "u493d", nickname: "덱감독" }, isNew: true })));
  await page.route((url) => url.pathname === "/api/deck", (r) => {
    if (r.request().method() === "PUT") {
      const b = r.request().postDataJSON();
      st.deckPuts++;
      st.lastPut = b;
      state.deck = { formation: b.formation, slots: b.slots, teamPrompt: b.teamPrompt ?? null };
    }
    return r.fulfill(json(state.deck));
  });
  return st;
}

/** 가입 → 홈 온보딩 건너뛰기 = **가이드 래치가 서는 지점**까지(`p493-guides` 와 같은 관용구). */
async function newUserPastOnboarding(page: Page) {
  await skipSplash(page);
  await page.goto("/login");
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-mode-toggle").click();
  await page.getByTestId("local-nickname").fill("deck493");
  await page.getByTestId("local-password").fill("sup3rs3cret");
  await page.getByTestId("local-submit").click();
  await page.getByTestId("starter-reveal-close").click();
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await page.getByTestId("tutorial-skip").click();
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
}

async function openDeckWithGuide(page: Page) {
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
}

/** 지금 서 있는 스텝 id. */
function stepId(page: Page) {
  return page.getByTestId("tutorial-bubble");
}

/**
 * 선수 이동 — **엔트리 동선**(선수 메뉴 없는 데스크탑 폭에서는 목록 시트가 자리를 준다).
 * 벤치 선수 FW3 를 선발 자리로 올린다 = `movePlayerToSlot` 스왑.
 */
async function movePlayer(page: Page) {
  await page.getByTestId("token-FW2").click(); // 그 자리(선발 10번)를 지시 대상으로
  await page.getByTestId("rail-swap-player").click(); // 자리 맥락으로 보유 선수 시트
  await page.getByTestId("pick-FW3").click(); // FW3 ↔ FW2 맞바꾸기
}

test("① ~ ⑤ 행동 4개로 완주 → 저장 + 보상 안내", async ({ page }) => {
  const st = await mockApi(page);
  await newUserPastOnboarding(page);
  await openDeckWithGuide(page);

  // ① 행동 스텝 1 — [다음]이 없다(= 클릭으로 못 넘어간다). 양성 앵커는 `data-advance-on`.
  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-move");
  await expect(stepId(page)).toHaveAttribute("data-advance-on", "deck-move");
  await expect(page.getByTestId("tutorial-next")).toHaveCount(0);
  await expect(page.getByTestId("tutorial-await")).toBeVisible();
  await expect(page.getByTestId("tutorial-progress")).toContainText("1 / 5");

  // ② 이동 → 스텝 2 (자동 진행)
  await movePlayer(page);
  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-auto");
  await expect(stepId(page)).toHaveAttribute("data-advance-on", "deck-auto");

  // ③ [⚡ 자동 채우기] → 스텝 3
  await page.getByTestId("auto-fill").click();
  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-prompt");

  // ④ 한마디 입력 → **입력을 마쳐야**(blur) 넘어간다
  const input = page.getByTestId("rail-prompt-input");
  await expect(input).toBeVisible();
  await input.fill("오늘 너만 믿는다");
  await page.waitForTimeout(800);
  console.log("DBG overlay=", await page.getByTestId("tutorial-overlay").count(),
    "bubble=", await page.getByTestId("tutorial-bubble").count(),
    "step=", await page.getByTestId("tutorial-bubble").getAttribute("data-step-id").catch(() => "-"),
    "railInput=", await page.getByTestId("rail-prompt-input").count(),
    "dialogs=", await page.locator('[role="dialog"],[role="alertdialog"]').count());
  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-prompt"); // 타이핑만으론 안 넘어간다
  await input.blur();
  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-save");

  // ⑤ 저장 → PUT 1회 + 마지막 안내(설명형이라 [확인]이 있다)
  await page.getByTestId("save-deck").click();
  await expect.poll(() => st.deckPuts, { timeout: 5000 }).toBe(1);
  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-reward");
  await expect(page.getByTestId("tutorial-body")).toContainText("우편");
  await expect(page.getByTestId("tutorial-next")).toHaveText("확인");
  await page.getByTestId("tutorial-next").click();
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

  // 쓴 한마디가 실제로 저장 본문에 실렸다 — 가이드가 UI 만 넘긴 것이 아니다.
  const saved = (st.lastPut?.slots ?? []).find((s) => (s.promptText ?? "").includes("오늘 너만 믿는다"));
  expect(saved, "쓴 한마디가 PUT 본문에 없다").toBeTruthy();

  // 가이드는 온보딩 완료 저장(= 서버 덱 지급 트리거)을 추가로 부르지 않았다.
  expect(st.completeCalls).toBe(1);

  // 재진입 — 다시 안 뜬다.
  await page.goto("/home");
  await openDeckAgainExpectNone(page);
});

async function openDeckAgainExpectNone(page: Page) {
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
}

test("⑥ 행동 스텝에서도 [건너뛰기] 는 산다 — 재진입 무노출", async ({ page }) => {
  await mockApi(page);
  await newUserPastOnboarding(page);
  await openDeckWithGuide(page);

  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-move");
  await page.getByTestId("tutorial-skip").click();
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

  await page.goto("/home");
  await openDeckAgainExpectNone(page);
});

test("⑦ 래치 없는 유저(기존 유저)에게는 덱에서도 안 뜬다", async ({ page }) => {
  await mockApi(page);
  await skipSplash(page);
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_old"));
  await openDeckAgainExpectNone(page);
});

/**
 * ⑧ **안내를 앞질러 간 유저는 갇히지 않는다.**
 *
 * 저장 클릭 한 번이 blur(한마디 확정) → click 두 신호를 연달아 내는 것과 같은 상황이라,
 * 이 성질이 없으면 스텝 4 가 자기 신호를 놓치고 [건너뛰기] 말고는 길이 없어진다.
 */
test("⑧ 스텝보다 먼저 한 행동은 그 스텝에 도착하는 즉시 통과한다", async ({ page }) => {
  await mockApi(page);
  await newUserPastOnboarding(page);
  await openDeckWithGuide(page);

  // 스텝 1(이동)에 서 있는데 먼저 [자동 채우기]를 눌러 버린다.
  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-move");
  await page.getByTestId("auto-fill").click();
  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-move"); // 아직 이동은 안 했다

  await movePlayer(page);
  // 스텝 2(자동 채우기)는 이미 한 일이라 그대로 지나가고 스텝 3 에 선다.
  await expect(stepId(page)).toHaveAttribute("data-step-id", "guide-deck-prompt");
});
