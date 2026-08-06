import { expect, test, type Page } from "@playwright/test";
import { openCandidatesTab, selectBoardPlayer } from "./deck-tabs";

/**
 * #439 — 폰 덱·선발 UX 근본 수리. **실제 폰 크기 + 실터치**로만 판정한다.
 *
 * 왜 이 파일이 새로 필요한가: 선발(경기전 브리핑) 화면은 **실터치 계약이 0건**이었다.
 * 리포 유일의 실터치 스펙(`deck-list-dnd-touch.spec.ts`)은 덱 화면만 보고,
 * `p276-halftime-shape` 의 드래그는 `page.mouse` + 가짜 세로 뷰포트라 이 부류를
 * **구조적으로 못 잡는다**(메모리 `e2e-touch-not-mouse`).
 *
 * hero 확정 결정(#439 STATE 5):
 *   Q1 auto = **빈 자리만 채운다**(덱셋팅·경기전 공통) — 이미 놓인 선수는 안 건드린다
 *   Q2 선수풀 = **벤치만 투입 가능**(경기전) — 시트에 나머지가 **DOM 에도 없다**
 *   Q3 드래그 = **롱프레스 유지 + 어포던스 신설** — 리스트 스크롤은 살린다
 *
 * ⚠️ 자기 전제 단언: `test.use` 에서 `viewport` 키가 빠지면 Playwright 는 조용히 데스크탑으로
 * 돌리고 **그래도 전부 초록**이다(#386 에서 실제로 4/4 통과했다). 그래서 매 테스트가 뷰포트를
 * 먼저 단언한다.
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
  P("FW3", "공격셋", "FW", "SILVER", 69),
];
/**
 * 선발 **11명** (#442 R2-ⓐ).
 *
 * ⚠️ 이 픽스처는 한때 선발 **10명**이었다 — 그리고 그건 **제품이 저장할 수 없는 상태**다
 * (`deck-logic.validateDraft` STARTER_COUNT · `DeckPage.saveDisabled`). 유저가 도달할 수 없는
 * 덱으로 auto 를 태우면 그 계약은 **진입 조건(`canFillEmptySlots` 활성 판정 · 빈 자리를 만드는
 * 제품 경로)이 깨지는 회귀를 원리적으로 못 잡는다**(#439 1R 독립검증 minor-2).
 * 그래서 지금은 **저장 가능한 덱에서 출발해, 빈 자리도 제품 손잡이([덱에서 제거])로 만든다**.
 */
const ELEVEN = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1", "FW3"];
/** auto 가 채워야 할 빈 자리를 만들 선수 — 4-4-2 의 **슬롯 10(FW 자리)** 주인. */
const VACATE = "FW3";
const BENCH = ["FW2", "GK2"];
/** 이 두 프롬프트가 auto 뒤에도 살아 있어야 한다(hero Q1=ⓑ 의 존재 이유). */
const MF1_PROMPT = "안쪽으로 파고들어라";
const FW2_PROMPT = "교체로 들어가면 측면을 넓게 써라";

function deckSlots() {
  return [
    ...ELEVEN.map((playerId, i) => ({
      playerId, role: "starter", slotIndex: i,
      promptText: playerId === "MF1" ? MF1_PROMPT : null,
    })),
    { playerId: "FW2", role: "bench", slotIndex: 0, promptText: FW2_PROMPT },
    { playerId: "GK2", role: "bench", slotIndex: 1, promptText: null },
  ];
}

const MATCH = {
  id: "m439", createdAt: "2026-08-04T00:00:00Z", state: "BRIEFING",
  conditions: Object.fromEntries(ELEVEN.map((id, i) => [id, 0.3 + (i % 5) * 0.15])),
  opponent: { name: "역습 봇", analysisText: "빠른 역습.", deck: [] },
};

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** `navigator.vibrate` 스텁 — 헤드리스에는 진동 장치가 없다. 호출 자체를 기록해 계약이 본다. */
async function bootstrap(page: Page, slots: unknown[]) {
  const state = { deck: { formation: "4-4-2", slots, teamPrompt: null as string | null } };
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
  await page.route((url) => url.pathname === "/api/matches/m439", (r) => r.fulfill(json(MATCH)));
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
    const w = window as unknown as { __vibes: unknown[] };
    w.__vibes = [];
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (pattern: unknown) => { w.__vibes.push(pattern); return true; },
    });
  });
}

async function openBriefing(page: Page, slots: unknown[] = deckSlots()) {
  await bootstrap(page, slots);
  await page.goto("/match/m439");
  await expect(page.getByTestId("briefing-panel")).toBeVisible();
  await expect(page.getByTestId("tactics-board")).toBeVisible();
  await expect(page.getByTestId("token-MF1")).toBeVisible();
}

/**
 * `anchor` = 보드가 다 그려진 것을 보장하는 앵커. 빈 덱에는 토큰이 하나도 없으므로 호출부가
 * 바꿔 준다 — 이걸 고정으로 두면 "측정 시점 경합"이 계약 실패로 위장한다(W0 프로브가 당했다).
 */
async function openDeck(page: Page, slots: unknown[] = deckSlots(), anchor = "token-MF1") {
  await bootstrap(page, slots);
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await expect(page.getByTestId(anchor)).toBeVisible();
}

// ── 실터치 하네스 (CDP — Playwright touchscreen 은 tap 만 된다) ────────────────
const pts = (x: number, y: number) => [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
interface Box { x: number; y: number; width: number; height: number }
const center = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

const slotOf = (page: Page, id: string) =>
  page.evaluate((pid) => {
    const tok = document.querySelector(`[data-testid="token-${pid}"]`);
    return tok?.closest("[data-testid^='board-slot-']")?.getAttribute("data-testid") ?? null;
  }, id);

/** 부드러운 스크롤이 멎을 때까지(#318 하네스 경합) — 카운터는 매번 리셋한다. */
async function waitForScrollSettled(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __lastY?: number; __stable?: number };
    w.__lastY = undefined; w.__stable = 0;
  });
  await page.waitForFunction(() => {
    const w = window as unknown as { __lastY?: number; __stable?: number };
    const y = window.scrollY;
    w.__stable = w.__lastY === y ? (w.__stable ?? 0) + 1 : 0;
    w.__lastY = y;
    return (w.__stable ?? 0) >= 3;
  }, undefined, { polling: 50, timeout: 5000 });
}

/** 홀드 없이 바로 미는 제스처(= 사람이 실제로 먼저 해 보는 것). */
async function flickDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(from.x, from.y) });
  for (let i = 1; i <= 16; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: pts(from.x + ((to.x - from.x) * i) / 16, from.y + ((to.y - from.y) * i) / 16),
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function longPressDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(from.x, from.y) });
  await page.waitForTimeout(300);
  for (let i = 1; i <= 16; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: pts(from.x + ((to.x - from.x) * i) / 16, from.y + ((to.y - from.y) * i) / 16),
    });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(60);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** 보드로 되돌아온 뒤 토큰/슬롯 좌표를 잰다(#318 — 화면이 움직이는 동안 좌표를 재지 않는다). */
async function boxOf(page: Page, testId: string): Promise<Box> {
  await page.getByTestId(testId).scrollIntoViewIfNeeded();
  await waitForScrollSettled(page);
  return (await page.getByTestId(testId).boundingBox())!;
}

// ── ① R1: 롱프레스 드래그 + 어포던스 ─────────────────────────────────────────
test("① 선발 화면 — 롱프레스로 토큰을 끌면 자리가 바뀐다(실터치)", async ({ page }) => {
  await openBriefing(page);

  const from = await slotOf(page, "MF1");
  const to = await slotOf(page, "MF2");
  expect(from).toBe("board-slot-starter-5");
  expect(to).toBe("board-slot-starter-6");

  const src = await boxOf(page, "token-MF1");
  const dst = await boxOf(page, to!);
  await longPressDrag(page, center(src), center(dst));
  await page.waitForTimeout(250);

  expect(await slotOf(page, "MF1"), "롱프레스 드래그로 MF1 이 MF2 자리로 가야 한다").toBe(to);
  expect(await slotOf(page, "MF2"), "밀려난 선수는 원래 자리로 교체돼야 한다").toBe(from);
});

test("① R1 어포던스 — 손가락을 대면 '잡히는 중'이 화면에 뜨고, 떼면 사라진다", async ({ page }) => {
  await openBriefing(page);
  const src = await boxOf(page, "token-MF1");
  const c = center(src);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(c.x, c.y) });
  // ⚠️ 활성화(150ms) **전에** 읽는다 — 신호가 활성화 뒤에만 뜬다면 그건 어포던스가 아니다
  //    (유저는 "얼마나 더 눌러야 하나"를 활성화 전에 알아야 한다).
  await page.waitForTimeout(60);
  const holding = await page.evaluate(() =>
    document.querySelector('[data-testid="token-hold-MF1"]')?.getAttribute("data-phase") ?? null);
  console.log(`[#439-R1] touchstart +60ms → data-phase = ${holding}`);
  expect(holding, "롱프레스 대기 중임을 화면이 말해야 한다").toBe("holding");

  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await expect(page.getByTestId("token-hold-MF1"), "손을 떼면 신호가 사라진다").toHaveCount(0);
  // 잡히기만 하고 끝난 제스처가 자리를 바꾸면 안 된다.
  expect(await slotOf(page, "MF1")).toBe("board-slot-starter-5");
});

test("① R1 어포던스 — 잡히는 순간 '잡혔다'로 바뀌고 진동한다", async ({ page }) => {
  await openBriefing(page);
  const src = await boxOf(page, "token-MF1");
  const c = center(src);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(c.x, c.y) });
  await page.waitForTimeout(300); // 150ms 활성화 지연을 넘긴다
  const grabbed = await page.evaluate(() => ({
    phase: document.querySelector('[data-testid="token-hold-MF1"]')?.getAttribute("data-phase") ?? null,
    token: document.querySelector('[data-testid="token-MF1"]')?.getAttribute("data-grabbed") ?? null,
    vibes: ((window as unknown as { __vibes: unknown[] }).__vibes ?? []).length,
  }));
  console.log(`[#439-R1] 활성화 후 = ${JSON.stringify(grabbed)}`);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();

  expect(grabbed.token, "잡힌 토큰이 스스로 그렇다고 말해야 한다").toBe("true");
  expect(grabbed.phase).toBe("grabbed");
  expect(grabbed.vibes, "잡히는 순간 짧게 진동한다(hero Q3=ⓐ)").toBeGreaterThan(0);
});

test("① R1 — 홀드 없이 바로 미는 제스처는 여전히 자리를 바꾸지 않는다(정책 유지 · Q3=ⓐ)", async ({ page }) => {
  /**
   * hero 는 ⓑ(즉시 드래그)를 **기각**했다 — 그 대가가 리스트 터치 스크롤 사망이기 때문.
   * 그래서 이건 결함이 아니라 **선택한 정책**이고, 계약으로 박아 다음 사람이 "고치는" 것을 막는다.
   * (수리한 것은 센서가 아니라 어포던스다 — 위 두 계약.)
   */
  await openBriefing(page);
  const from = await slotOf(page, "MF1");
  const to = await slotOf(page, "MF2");
  const src = await boxOf(page, "token-MF1");
  const dst = await boxOf(page, to!);
  await flickDrag(page, center(src), center(dst));
  await page.waitForTimeout(250);
  expect(await slotOf(page, "MF1")).toBe(from);
});

// ── ② R2: 경기전 선수풀 = 벤치만 ─────────────────────────────────────────────
test("② 경기전 시트에는 벤치 선수만 뜬다 — 나머지는 DOM 에도 없다", async ({ page }) => {
  await openBriefing(page);
  await page.getByTestId("pool-sheet-open").click();
  await expect(page.getByTestId("player-pool")).toBeVisible();

  for (const id of BENCH) {
    await expect(page.getByTestId(`pick-${id}`), `벤치 ${id} 는 고를 수 있어야 한다`).toBeVisible();
  }
  const nonBench = PLAYERS.map((p) => p.id).filter((id) => !BENCH.includes(id));
  for (const id of nonBench) {
    await expect(page.getByTestId(`pick-${id}`), `벤치가 아닌 ${id} 가 시트에 있다`).toHaveCount(0);
  }
  console.log(`[#439-R2] 시트 노출 = 벤치 ${BENCH.length}명 · 비벤치 ${nonBench.length}명 중 0명`);
});

test("② 덱셋팅은 그대로 — 보유 선수 전원이 시트에 있다(대조군)", async ({ page }) => {
  await openDeck(page);
  await openCandidatesTab(page); // #455 A1: 폰에서 여는 버튼은 [👥 후보] 탭 안
  await page.getByTestId("pool-sheet-open").click();
  await expect(page.getByTestId("player-pool")).toBeVisible();
  for (const id of ["DF1", "MF1", "FW1", "GK1"]) {
    await expect(page.getByTestId(`pick-${id}`)).toBeVisible();
  }
});

// ── ③ R3-a/b: 초기화 제거 · auto 신설 ────────────────────────────────────────
test("③ 경기전에는 [초기화]가 없고 [auto]가 폰에서 보인다", async ({ page }) => {
  await openBriefing(page);
  await expect(page.getByTestId("board-reset"), "경기전 초기화는 복구 부담이 과대하다(hero)").toHaveCount(0);

  /* ⚠️ **#455 A3**: 구판은 `auto-fill-top`(폰) / `auto-fill`(데스크탑) 중 보이는 쪽을 골랐다.
     이제 자리가 **경기장 우측 하단 하나**라 그 분기가 없다 — 분기를 되살리면 그것이 곧 회귀다. */
  const visible = page.getByTestId("auto-fill");
  await expect(visible, "폰에서 실제로 보이는 auto 버튼이 있어야 한다").toBeVisible();
  await expect(page.getByTestId("auto-fill-top"), "구 시트 바 AUTO 는 은퇴했다").toHaveCount(0);
  const box = (await visible.boundingBox())!;
  console.log(`[#439-R3] 경기전 auto 버튼 박스 = ${JSON.stringify(box)}`);
  expect(box.width).toBeGreaterThan(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test("③ 덱셋팅에는 [초기화]가 남아 있다(대조군 — 없앤 것은 경기전 뿐이다)", async ({ page }) => {
  await openDeck(page);
  await expect(page.getByTestId("board-reset")).toHaveCount(1);
});

// ── ④ auto = 빈 자리만 채운다 + 프롬프트 보존 ────────────────────────────────
async function clickAuto(page: Page) {
  // #455 A3 — 손잡이는 하나(경기장 우측 하단). "보이는 쪽을 누른다" 관용구는 은퇴했다.
  const target = page.getByTestId("auto-fill");
  await expect(target).toBeEnabled();
  await target.click();
}

/**
 * **제품 손잡이로** 빈 자리를 만든다 (#442 R2-ⓐ) — 토큰 탭 → 레일 [덱에서 제거].
 *
 * 픽스처에 "선발 10명"을 그려 넣는 대신 이 경로를 타는 것이 이 수리의 전부다: 저장 가능한
 * 덱(선발 11)에서 출발해 유저가 실제로 밟는 경로로 자리를 비운다. 그래야 계약이 **auto 의
 * 진입 조건 + 그 조건을 만드는 경로**를 같이 태운다(구 픽스처는 둘 다 건너뛰었다).
 */
async function vacateSlot(page: Page, playerId: string) {
  // #455 A2: 폰 덱셋팅은 토큰 탭이 **선수 메뉴**를 연다(경기전은 예전 그대로). 화면이 선언한
  // `data-layout` 을 읽어 **그 화면에서 참인 경로**를 단언하며 밟는다 — `deck-tabs.ts` 머리말.
  await selectBoardPlayer(page, playerId);
  await expect(page.getByTestId("rail-remove-player")).toBeVisible();
  await page.getByTestId("rail-remove-player").click();
  await expect(page.getByTestId(`token-${playerId}`), `${playerId} 가 덱에서 빠져야 한다`).toHaveCount(0);
}

/** 레일에서 그 선수의 프롬프트 원문을 읽는다(토큰 탭 → 입력칸 value). */
async function promptOf(page: Page, playerId: string): Promise<string> {
  await selectBoardPlayer(page, playerId); // #455 A2 — 위 `vacateSlot` 과 같은 이유
  await expect(page.getByTestId("rail-prompt-input")).toBeVisible();
  return page.getByTestId("rail-prompt-input").inputValue();
}

test("④ 경기전 auto — 빈 자리는 벤치 선수로 채우고, 이미 놓인 선수·프롬프트는 그대로", async ({ page }) => {
  await openBriefing(page);
  await expect(page.getByTestId("starter-count"), "저장 가능한 덱에서 출발한다").toHaveText(/11\/11/);
  await vacateSlot(page, VACATE); // ← 빈 자리는 **제품 경로**로 만든다(#442 R2-ⓐ)
  await expect(page.getByTestId("starter-count")).toHaveText(/10\/11/);
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="board-slot-"]')].map((s) => ({
      slot: s.getAttribute("data-testid"),
      player: s.querySelector('[data-testid^="token-"]')?.getAttribute("data-testid") ?? null,
    })));

  await clickAuto(page);
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);

  // 빈 FW 자리(슬롯 10)는 벤치 FW2 가 채운다 — GK2 는 GK 라 적합도에서 진다.
  await expect(page.getByTestId("board-slot-starter-10").getByTestId("token-FW2")).toBeVisible();
  // 이미 벤치에 앉아 있던 GK2 는 재배치되지 않는다.
  await expect(page.getByTestId("board-slot-bench-1").getByTestId("token-GK2")).toBeVisible();
  /**
   * ★ **R2 가 auto 에도 걸린다**: FW2 가 떠난 벤치 0 은 **빈 채로 남아야 한다**.
   * 후보를 보유 전체로 되돌리면 여기에 FW3(벤치 아님)이 들어온다 = 경기전에 스쿼드 밖 선수가
   * 투입되는 것. 시트(DOM 부재)만 막고 auto 를 안 막으면 규칙에 구멍이 생긴다.
   */
  await expect(page.getByTestId("board-slot-bench-0").locator('[data-testid^="token-"]')).toHaveCount(0);

  const after = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="board-slot-"]')].map((s) => ({
      slot: s.getAttribute("data-testid"),
      player: s.querySelector('[data-testid^="token-"]')?.getAttribute("data-testid") ?? null,
    })));
  const moved = before.filter((b, i) => b.player !== after[i]!.player);
  console.log(`[#439-auto] 바뀐 자리 = ${JSON.stringify(moved)}`);
  // 바뀐 자리는 딱 둘 — 비어 있던 선발 10 과 FW2 가 떠난 벤치 0.
  expect(moved.map((m) => m.slot).sort()).toEqual(["board-slot-bench-0", "board-slot-starter-10"]);

  // ★ Q1=ⓑ 의 존재 이유: auto 가 기존 프롬프트를 덮지 않는다.
  expect(await promptOf(page, "MF1")).toBe(MF1_PROMPT);
  expect(await promptOf(page, "FW2")).toBe(FW2_PROMPT);
});

test("④ 덱셋팅 auto 도 같은 규칙 — 빈 자리만 채우고 프롬프트는 보존한다", async ({ page }) => {
  await openDeck(page);
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  await vacateSlot(page, VACATE); // #442 R2-ⓐ — 빈 자리도 제품 경로로
  await expect(page.getByTestId("starter-count")).toHaveText(/10\/11/);

  await clickAuto(page);
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);

  // 이미 배치된 선수는 자기 자리 그대로.
  for (const [i, id] of ELEVEN.slice(0, 10).entries()) {
    await expect(page.getByTestId(`board-slot-starter-${i}`).getByTestId(`token-${id}`)).toBeVisible();
  }
  // 빈 FW 자리는 적합도 최고(FW2, GOLD 72 > FW3 SILVER 69)가 가져간다.
  const filled = await page.getByTestId("board-slot-starter-10").locator('[data-testid^="token-"]').getAttribute("data-testid");
  console.log(`[#439-auto] 덱셋팅 빈 자리를 채운 선수 = ${filled}`);
  expect(filled).toBe("token-FW2");

  /**
   * ★ **같은 함수, 다른 후보 목록**이라는 사실이 화면에 드러나는 지점.
   * 경기전(위 테스트)에서는 FW2 가 떠난 벤치 0 이 **빈 채로 남는다**(후보가 벤치뿐이고 그들은
   * 이미 앉아 있다). 덱셋팅에서는 후보가 보유 전체라 **미배치 FW3 가 그 자리로 들어온다**.
   * 규칙을 auto 안에 if 로 넣었다면 이 두 결과를 한 코드로 낼 수 없다.
   */
  // #455 A1: 폰 덱셋팅에서 벤치 줄은 [👥 후보] 탭 안이다(그리는 코드는 하나 — 포털).
  await openCandidatesTab(page);
  await expect(page.getByTestId("board-slot-bench-0").getByTestId("token-FW3")).toBeVisible();

  expect(await promptOf(page, "MF1")).toBe(MF1_PROMPT);
});

test("④ 빈 덱 + AUTO — 선발 11 과 **지시 11/11** 이 같이 채워진다(hero 결정 ⓐ)", async ({ page }) => {
  /**
   * ⚠️ **이 계약이 없어서 회귀가 통과했다.** 1R 은 `fillEmptySlots` 가 프롬프트를 만들지 않게
   * 짰고, 그 결과 빈 덱 AUTO 의 지시가 `4e99e12` **11/11** → `4e493c7` **0/11** 로 죽었다.
   * AC 7건도 기존 e2e 36건도 전부 green 이었다 — **아무도 지시 *개수* 를 안 쟀기 때문이다**
   * (선발 수·프롬프트 보존은 쟀다. 없던 것은 "auto 가 지시를 만드나" 축 하나였다).
   *
   * 온보딩(`common/tutorial-steps.ts` `setup-auto` → `setup-motto`)이 *"AUTO 로 선발을 채우고
   * 감독 한마디만 직접 타이핑"* 을 전제하므로, 지시칸이 전부 빈칸이면 그 동선이 거짓말이 된다.
   */
  await openDeck(page, [], "board-empty"); // 진짜 빈 덱(토큰이 0개라 앵커가 다르다)
  await expect(page.getByTestId("starter-count")).toHaveText(/0\/11/);
  await expect(page.getByTestId("directive-count")).toContainText("지시 0/11");

  await clickAuto(page);
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  await expect(page.getByTestId("directive-count"), "AUTO 는 지시도 같이 채운다").toContainText("지시 11/11");

  // 개수만 세면 공백 한 칸으로도 통과한다 — **문구가 그 자리의 포지션 지시인지**까지 본다.
  const gkPrompt = await promptOf(page, "GK1");
  console.log(`[#439-auto] 빈 덱 AUTO → GK 슬롯 지시 = ${JSON.stringify(gkPrompt)}`);
  expect(gkPrompt).toContain("골문");
});

test("④ 경기전 auto — **지시 없이 출전하는 선발을 남기지 않는다**(승격 선수도 채운다, hero 3R)", async ({ page }) => {
  /**
   * hero: *"승격되는 선수도 넣어줘"*. 2R 은 경계를 *"원래 아무 데도 없던 선수"* 로 좁게 잡아서,
   * 벤치에서 빈 선발 자리로 올라간 선수가 **지시 없이 선발로 출전**할 수 있었다.
   *
   * 표본은 그 구멍만 남긴 덱이다 — 앉아 있는 선발 10명은 전부 지시가 있고, 유일한 빈칸이
   * **승격될 벤치 선수**다. 승격 분기를 되돌리면(=`c8fb4ae`) 여기서 10/11 이 나온다.
   */
  const seeded = deckSlots().map((s) =>
    s.role === "starter"
      ? { ...s, promptText: s.promptText ?? `${s.playerId} 에게 내리는 지시` }
      : s.playerId === "FW2"
        ? { ...s, promptText: "" } // ← 유저가 지운 상태(빈 문자열)로 벤치에 앉아 있다
        : s,
  );
  await openBriefing(page, seeded);
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  await vacateSlot(page, VACATE); // #442 R2-ⓐ — 승격될 자리도 제품 경로로 비운다
  await expect(page.getByTestId("starter-count")).toHaveText(/10\/11/);
  await expect(page.getByTestId("directive-count")).toContainText("지시 10/11");

  await clickAuto(page);
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  await expect(
    page.getByTestId("directive-count"),
    "승격된 선수가 지시 없이 선발로 나가면 안 된다",
  ).toContainText("지시 11/11");

  const promoted = await promptOf(page, "FW2");
  console.log(`[#439-3R] 승격 선수 지시 = ${JSON.stringify(promoted)}`);
  expect(promoted).toContain("전방"); // 슬롯 10 = FW 자리의 기본 문구

  // ⛔ 그래도 **이미 쓴 문장은 안 덮는다** — MF1 은 앉아 있고 원문 그대로여야 한다.
  expect(await promptOf(page, "MF1")).toBe(MF1_PROMPT);
});

// ── ⑤ 배치 직후에도 보드가 남아 있다(연속 배치) ───────────────────────────────
test("⑤ 시트로 한 명 배치한 직후에도 다음 빈 자리를 바로 누를 수 있다", async ({ page }) => {
  /**
   * 구 동작: 배치 직후 화면이 프롬프트 레일로 부드럽게 이동해 **보드가 화면 위로 사라졌다**
   * (W0 실측 4회 중 3회 보드 상단 `y = -228`). 선수 하나 놓을 때마다 스크롤해 올라와야 하면
   * 연속 배치가 불가능하다.
   *
   * 판정은 좌표 추론이 아니라 **히트테스트**다 — "그 자리를 지금 손가락으로 누를 수 있나".
   */
  await openDeck(page);
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  // 빈 자리 둘도 **제품 경로**로 만든다(#442 R2-ⓐ) — 슬롯 9(FW1) 에 다시 놓고 슬롯 10 을 눌러 본다.
  await vacateSlot(page, VACATE);
  await vacateSlot(page, "FW1");
  await expect(page.getByTestId("starter-count")).toHaveText(/9\/11/);

  await page.getByTestId("board-slot-starter-9").click();
  await page.getByTestId("pick-FW1").click();
  await expect(page.getByTestId("board-slot-starter-9").getByTestId("token-FW1")).toBeVisible();
  await page.waitForTimeout(800); // 어떤 스크롤이든 끝나기를 기다린다(있다면)

  const probe = await page.evaluate(() => {
    const board = document.querySelector('[data-testid="tactics-board"]')!.getBoundingClientRect();
    const next = document.querySelector('[data-testid="board-slot-starter-10"]')!;
    const b = next.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      boardTop: Math.round(board.top),
      slotTop: Math.round(b.top),
      reachable: Boolean(hit && next.contains(hit)),
      scrollY: Math.round(window.scrollY),
    };
  });
  console.log(`[#439-⑤] 배치 직후 = ${JSON.stringify(probe)}`);
  expect(probe.reachable, "배치 직후 다음 빈 자리가 화면에서 눌려야 한다").toBe(true);
});
