import { expect, test, type Page } from "@playwright/test";

/**
 * #455 A1 — **전술보드 전체화면·세로 확장**(메가에픽2-A, 덱셋팅 화면 전면 개편).
 *
 * ── 이 계약의 출처 ────────────────────────────────────────────────────────────
 * A-0 정적 목업(`docs/plan-v5/mock/455-decka/index.html`)을 hero 가 직접 만져 보고
 * **"지금 프로토타입 좋다 이대로 가자"** 로 확정한 모양이다(#455 comment 5196070445).
 * 그 목업의 `check.mjs` 53건이 **기대동작의 실행 가능한 명세**이고, 이 파일은 그중
 * **A1 범위**를 제품(apps/web)으로 옮긴 것이다. 확정 계약:
 *
 *   ③ 경기장 세로 = **68 상한**(고정 아님. 폰 390 실측 374×374 = 68:68)
 *   ⑤ 경기장 아래 = **1안 책갈피 탭** `[📣 전체 지시][👥 후보 N][⚙ 세부 전술]`
 *      · 전체 지시가 **기본 펼침**(프롬프트가 우리 핵심이라 "눌러야 보이는 것"이면 안 된다, #244 원칙)
 *      · 후보(벤치)는 그 탭 **안**
 *   여백 ≈ 0 — 68 상한이 남긴 세로(목업 R4 실측 249px = 화면의 30%)를 탭이 가져간다
 *
 * ⚠️ **측정은 추론하지 않는다**(루트 §2-2). 비율·여백·겹침은 전부 `getBoundingClientRect`
 *    실측이고, "보이나"는 `toBeVisible()` 이 아니라 **`elementFromPoint` 히트**로 판정한다
 *    (뷰포트 밖도 `toBeVisible()` 은 통과한다 — apps/web/CLAUDE.md "초록으로 거짓말하는 방식" ③).
 * ⚠️ 자기 전제 단언: `test.use` 에서 `viewport` 키가 빠지면 Playwright 는 조용히 데스크탑으로
 *    돌리고 **그래도 전부 초록**이다(#386 실적). 그래서 매 테스트가 뷰포트를 먼저 단언한다.
 * ⚠️ 실행: 전체 e2e 금지(:8080 데모 충돌) — 이 스펙만 지정 + 빈 포트.
 *    `CI=1 WEB_E2E_PORT=5599 npx playwright test e2e/p455-a1-deck-fullscreen.spec.ts`
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  expect(page.viewportSize(), "이 계약은 실제 폰 뷰포트에서만 유효하다").toEqual({ width: 390, height: 844 });
});

// ── 픽스처 ────────────────────────────────────────────────────────────────────
const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const P = (id: string, name: string, position: string, grade: string, ov: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(ov), personality: "CALM",
});

const PLAYERS = [
  P("GK1", "골리원", "GK", "GOLD", 70), P("GK2", "골리투", "GK", "SILVER", 62),
  P("DF1", "수비하나", "DF", "GOLD", 76), P("DF2", "수비둘", "DF", "SILVER", 68),
  P("DF3", "수비셋", "DF", "SILVER", 64), P("DF4", "수비넷", "DF", "BRONZE", 55),
  P("MF1", "미드하나", "MF", "DIA", 84), P("MF2", "미드둘", "MF", "GOLD", 74),
  P("MF3", "미드셋", "MF", "SILVER", 66), P("MF4", "미드넷", "MF", "SILVER", 61),
  P("FW1", "공격하나", "FW", "LEGEND", 90), P("FW2", "공격둘", "FW", "GOLD", 72),
  P("FW3", "공격셋", "FW", "SILVER", 69), P("FW4", "공격넷", "FW", "GOLD", 80),
];

/** 선발 11 — **제품이 저장할 수 있는 상태**(`validateDraft` STARTER_COUNT=11). */
const ELEVEN = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1", "FW2"];
const BENCH = ["FW3", "GK2"];

function deckSlots() {
  return [
    ...ELEVEN.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
    ...BENCH.map((playerId, i) => ({ playerId, role: "bench", slotIndex: i, promptText: null })),
  ];
}

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function bootstrap(page: Page, slots: unknown[], teamPrompt: string | null = null) {
  const state = { deck: { formation: "4-4-2", slots, teamPrompt } };
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (r) => r.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/presets", (r) => r.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/presets/team", (r) =>
    r.fulfill(json([1, 2, 3].map((slot) => ({ slot, name: null, snapshot: null })))));
  await page.route((url) => url.pathname === "/api/relations", (r) =>
    r.fulfill(json({ morale: 60, streak: 0, players: [] })));
  await page.route((url) => url.pathname === "/api/conditions/today", (r) =>
    r.fulfill(json(Object.fromEntries(ELEVEN.map((id, i) => [id, 0.3 + (i % 5) * 0.15])))));
  await page.route((url) => url.pathname === "/api/me", (r) => r.fulfill(json({
    user: { id: "u1", nickname: "테스터", provider: "guest", tutorialDone: true },
    wallet: { points: 1000 }, records: { played: 0, wins: 0, draws: 0, losses: 0 },
  })));
  await page.route((url) => url.pathname === "/api/me/active-match", (r) =>
    r.fulfill(json({ match: null, locked: false, abandonable: false })));
  await page.route((url) => url.pathname === "/api/deck", (r) => {
    if (r.request().method() === "PUT") {
      const b = r.request().postDataJSON();
      state.deck = { formation: b.formation, slots: b.slots, teamPrompt: b.teamPrompt ?? null };
    }
    return r.fulfill(json(state.deck));
  });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
}

async function openDeck(page: Page, teamPrompt: string | null = null) {
  await bootstrap(page, deckSlots(), teamPrompt);
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await expect(page.getByTestId("token-FW1")).toBeVisible();
}

/** 이 지점이 **실제로 화면에 있나** — `toBeVisible()` 은 뷰포트 밖을 통과한다. */
async function hitAt(page: Page, x: number, y: number, testId: string) {
  return page.evaluate(
    ({ x, y, testId }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      return !!el.closest(`[data-testid="${testId}"]`);
    },
    { x, y, testId },
  );
}

// ── ① 경기장이 상한 68 에 닿는다 ─────────────────────────────────────────────
/**
 * hero 확정 ③. 지금은 폰에서 `aspect-ratio: 68/52`(`TacticsBoard.module.css`)라 **세로가 짧다** —
 * A1 의 첫 요구가 정확히 이것이다("경기장이 너무 작다").
 * ⚠️ **고정이 아니라 상한**이다: 세로가 모자란 창에서는 더 낮아도 되고, 넘지만 않으면 된다.
 * 폰 390×844 는 남는 세로가 충분해 상한에 **닿아야** 한다(목업 실측 374×374).
 */
test("① 폰에서 경기장이 상한 68 에 닿는다 (실측 w:h)", async ({ page }) => {
  await openDeck(page);
  const box = (await page.getByTestId("tactics-board").boundingBox())!;
  const ratio = (68 * box.height) / box.width;
  expect.soft(box.width, "폰 폭에서 보드가 화면을 쓴다").toBeGreaterThan(300);
  // 상한 68 — 넘지 않고(±1 반올림 여유), 남는 세로가 있으면 닿는다.
  expect(ratio, `실측 68 : ${ratio.toFixed(1)}`).toBeLessThanOrEqual(69);
  expect(ratio, `실측 68 : ${ratio.toFixed(1)} — 상한에 닿아야 한다`).toBeGreaterThanOrEqual(66);
});

// ── ② 이름표 겹침 0 ───────────────────────────────────────────────────────────
/**
 * 경기장을 키우면 줄 간격이 늘어 겹침은 **더** 안 나야 한다. 68/52 하한을 잡을 때
 * 실측 여유가 2px 뿐이었으므로(`TacticsBoard.module.css` 주석) 이 축은 회귀 가드로 남긴다.
 * ⚠️ 판정은 **사각형 교차 실측**이다 — "겹쳐 보인다"는 눈으로만 알 수 있는 게 아니라 잴 수 있다.
 */
test("② 선수 이름표가 서로 겹치지 않는다 (사각형 교차 0)", async ({ page }) => {
  await openDeck(page);
  const rects = await page.$$eval('[data-testid^="token-name-"]', (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-testid")!, x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
  expect(rects.length, "이름표에 안정적인 손잡이가 있어야 잴 수 있다").toBeGreaterThanOrEqual(11);
  const hits: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlap) hits.push(`${a.id} ↔ ${b.id}`);
    }
  }
  expect(hits, `겹친 쌍: ${hits.join(", ")}`).toEqual([]);
});

// ── ③ 경기장 아래 책갈피 탭 3개 ──────────────────────────────────────────────
/**
 * hero 확정 ⑤(1안). **2안(하단 버튼 + 아이콘 강조)은 기각됐다** — 버튼은 아무리 강조해도
 * "여기에 프롬프트가 있다"까지만 보이고 **내가 뭐라고 써놨는지**는 안 보인다. 요구는 강조가
 * 아니라 **위계**였고, 위계는 펼침 ↔ 접힘으로 갈린다.
 */
test("③ 경기장 아래에 책갈피 탭 3개 — 전체 지시 · 후보 · 세부 전술", async ({ page }) => {
  await openDeck(page);
  const tabs = page.getByTestId("deck-tabs");
  await expect(tabs).toBeVisible();
  await expect(page.getByTestId("deck-tab-team")).toBeVisible();
  await expect(page.getByTestId("deck-tab-sub")).toBeVisible();
  await expect(page.getByTestId("deck-tab-tune")).toBeVisible();
  // 탭은 경기장 **아래**다(위에 붙으면 보드를 더 밀어낸다).
  const board = (await page.getByTestId("tactics-board").boundingBox())!;
  const bar = (await tabs.boundingBox())!;
  expect(bar.y, "탭 줄이 경기장 아래에 있다").toBeGreaterThanOrEqual(board.y + board.height - 1);
});

// ── ④ 전체 지시가 기본 펼침 ──────────────────────────────────────────────────
/**
 * **이 계약이 1안의 존재 이유다.** 프롬프트는 이 게임의 핵심이라 "눌러야 보이는 것"이면 안 된다
 * (#244 `DirectiveRail` 이 이미 *"일반 축구게임이 세부조정을 두던 자리를 프롬프트가 차지한다"*).
 *
 * ⚠️ **이 하나는 처음부터 green 이다 — 그래서 red 가 아니라 보존 계약이다.** #244 가 이미 이
 * 성질을 만들어 뒀고(구현 전 실측 통과), A1 이 프롬프트를 탭 ① 안으로 **옮기면서** 그것을
 * 깨뜨리지 않는지가 여기서 걸린다. 2안(버튼 뒤로 접기)으로 되돌리면 이 계약이 먼저 죽는다.
 * ⚠️ `toBeVisible()` 로 쓰면 안 된다 — 접힌 패널 안이나 뷰포트 밖도 통과한다.
 *    **입력칸 한가운데를 `elementFromPoint` 로 찍어** 실제로 그 자리에 있는지 본다.
 */
test("④ 팀 프롬프트가 기본으로 펼쳐져 있다 (눌러야 보이는 게 아니다)", async ({ page }) => {
  await openDeck(page, "높은 라인으로 압박해라");
  // ⚠️ 팀 프롬프트의 손잡이는 `editor-team-prompt` 다 — `rail-prompt-input` 은 **선수** 프롬프트
  //    (`DirectiveRail` 의 선수 분기)라 팀 지시를 재려고 쓰면 항상 element-not-found 로 죽는다.
  const input = page.getByTestId("editor-team-prompt");
  await expect(input).toBeVisible();
  const box = (await input.boundingBox())!;
  expect(box.height, "입력칸이 남는 세로를 먹는다").toBeGreaterThanOrEqual(72);
  const hit = await hitAt(page, box.x + box.width / 2, box.y + box.height / 2, "editor-team-prompt");
  expect(hit, "입력칸 한가운데가 실제로 화면에 있다").toBe(true);
  // 써둔 문장이 **탭을 누르지 않고** 읽힌다.
  await expect(input).toHaveValue("높은 라인으로 압박해라");
});

// ── ⑤ 후보(벤치)가 탭 안 ────────────────────────────────────────────────────
/**
 * 1안의 유일한 대가 = 벤치가 기본 비노출. hero 가 그 대가를 알고 택했다.
 * 되돌리려면 벤치만 탭 밖으로 빼고 탭을 둘로 줄이면 된다(조정 포인트).
 */
test("⑤ 후보(벤치)가 [후보] 탭 안으로 들어간다", async ({ page }) => {
  await openDeck(page);
  // 기본 탭은 [전체 지시] — 벤치는 아직 화면에 없다.
  await expect(page.getByTestId("deck-tabpanel-team")).toBeVisible();
  await expect(page.getByTestId("board-bench")).toBeHidden();

  await page.getByTestId("deck-tab-sub").tap();
  const bench = page.getByTestId("board-bench");
  await expect(bench).toBeVisible();
  // DOM 상 그 탭 패널의 자손이어야 한다(옆에 나란히 그리면 탭이 무의미하다).
  const inside = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="deck-tabpanel-sub"]');
    const el = document.querySelector('[data-testid="board-bench"]');
    return !!panel && !!el && panel.contains(el);
  });
  expect(inside, "벤치가 [후보] 탭 패널 안에 있다").toBe(true);
});

// ── ⑥ 경기장 아래 죽은 여백 ≈ 0 ─────────────────────────────────────────────
/**
 * 68 상한의 대가로 목업 R4 에서 **249px(화면의 30%)** 가 비었다. 1안이 그 자리를 먹는 것이
 * "1안은 공짜로 들어간다"의 실체다 — 그래서 이 계약은 탭이 **바닥까지 닿는지**를 잰다.
 * ⚠️ 하단 네비가 있으면 그 위까지가 바닥이다.
 */
test("⑥ 경기장 아래 죽은 여백이 없다 (탭이 바닥까지)", async ({ page }) => {
  await openDeck(page);
  const gap = await page.evaluate(() => {
    const tabs = document.querySelector('[data-testid="deck-tabs"]');
    if (!tabs) return -1;
    const last = tabs.getBoundingClientRect();
    const nav = document.querySelector('[data-testid="nav-bottom"]');
    const floor = nav ? nav.getBoundingClientRect().top : window.innerHeight;
    return Math.round(floor - last.bottom);
  });
  expect(gap, `경기장 아래 남은 띠 ${gap}px`).toBeGreaterThanOrEqual(0);
  expect(gap, `경기장 아래 남은 띠 ${gap}px — 탭이 바닥까지 채운다`).toBeLessThanOrEqual(8);
});

// ── ⑦ 가로 넘침 0 (회귀 가드) ────────────────────────────────────────────────
test("⑦ 390px 폰에서 가로 넘침이 없다", async ({ page }) => {
  await openDeck(page);
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  expect(over.doc, `문서 ${over.doc} vs 화면 ${over.win}`).toBeLessThanOrEqual(over.win);
});
