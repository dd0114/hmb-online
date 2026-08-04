import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/** 실화면 증빙 — DOM 계약이 초록인데 어포던스가 안 보이는 축은 캡처로만 잡힌다(#439 `.tokenDragging`). */
const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

/**
 * #442 R1 — **폰 선수 투입 동선**(목록 탭 → [투입] → "교체할 선수를 선택해주세요" → 슬롯 탭).
 *
 * ── 왜 이 동선이 필요한가 (구조적 부재, #439 1R 독립검증이 "정당한 이월"로 판정한 항목) ──────
 * 폰에서 선수 목록은 **아래에서 올라오는 시트가 보드를 완전히 덮는다**(#244 프롬프트-우선 전환의
 * 귀결). 그래서 `PlayerPicker` 의 `useDraggable`(리스트 → 슬롯 드래그)은 **드롭 대상이 화면에
 * 없어 원리적으로 도달 불가능한 죽은 코드**다. 목록에서 고른 선수가 갈 수 있는 자리는
 * `sheetSlot ?? firstEmptySlot` 하나뿐이었고, 스쿼드가 꽉 찬 상태(=경기전 교체의 정의)에서는
 * **막다른 안내문**이 전부였다.
 *
 * ⛔ **드래그를 대체하는 것이 아니다** — 데스크탑 포인터 드래그 경로는 그대로 살아 있고
 * (`deck-list-dnd.spec.ts` 가 실제 드래그로 지킨다) 이 동선이 그 위에 **더해진다**.
 *
 * ⚠️ 판정은 **실제 폰 뷰포트 + 실터치**로만 한다(메모리 `e2e-touch-not-mouse`).
 *    `page.mouse` 를 쓰면 이 부류를 구조적으로 못 잡는다. 여기서는 Playwright `.tap()`
 *    (= `Input.dispatchTouchEvent`)만 쓴다 — 이 파일에 `page.mouse` 는 한 번도 안 나온다.
 * ⚠️ 자기 전제 단언: `test.use` 에서 `viewport` 키가 빠지면 Playwright 는 조용히 데스크탑으로
 *    돌리고 **그래도 전부 초록**이다(#386 에서 실제로 4/4 통과했다). 그래서 매 테스트가 뷰포트를
 *    먼저 단언한다.
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
  /** ★ **스쿼드 밖** — 보유했지만 선발도 벤치도 아니다. R2(경기전 = 벤치만)의 시험지다. */
  P("FW4", "공격넷", "FW", "GOLD", 80),
];

/** 선발 11 — **제품이 저장할 수 있는 상태**다(`validateDraft` STARTER_COUNT=11). */
const ELEVEN = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1", "FW2"];
const BENCH = ["FW3", "GK2"];
/** 스쿼드(선발+벤치) 밖 = 경기전에 절대 들어오면 안 되는 선수. */
const OUTSIDE = PLAYERS.map((p) => p.id).filter((id) => !ELEVEN.includes(id) && !BENCH.includes(id));

function deckSlots() {
  return [
    ...ELEVEN.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
    ...BENCH.map((playerId, i) => ({ playerId, role: "bench", slotIndex: i, promptText: null })),
  ];
}

const MATCH = {
  id: "m442", createdAt: "2026-08-05T00:00:00Z", state: "BRIEFING",
  conditions: Object.fromEntries(ELEVEN.map((id, i) => [id, 0.3 + (i % 5) * 0.15])),
  opponent: { name: "역습 봇", analysisText: "빠른 역습.", deck: [] },
};

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

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
  await page.route((url) => url.pathname === "/api/matches/m442", (r) => r.fulfill(json(MATCH)));
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

async function openBriefing(page: Page, slots: unknown[] = deckSlots()) {
  await bootstrap(page, slots);
  await page.goto("/match/m442");
  await expect(page.getByTestId("briefing-panel")).toBeVisible();
  await expect(page.getByTestId("token-FW1")).toBeVisible();
}

async function openDeck(page: Page, slots: unknown[] = deckSlots()) {
  await bootstrap(page, slots);
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await expect(page.getByTestId("token-FW1")).toBeVisible();
}

/** 보드 전체 배치(슬롯 → 그 자리 선수) — 스냅샷 비교용. */
async function boardMap(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid^="board-slot-"]')].map((s) => [
        s.getAttribute("data-testid")!,
        s.querySelector('[data-testid^="token-"]')?.getAttribute("data-testid") ?? null,
      ]),
    ),
  );
}

/** 지금 "투입 대상"으로 활성화된 슬롯 목록. */
async function assignTargets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-assign-target="true"]')].map((e) => e.getAttribute("data-testid")!),
  );
}

/** 목록 시트를 열고 그 선수의 [투입] 을 실터치로 누른다 → 안내 상태 진입. */
async function startAssign(page: Page, playerId: string) {
  await page.getByTestId("pool-sheet-open").tap();
  await expect(page.getByTestId("player-pool")).toBeVisible();
  await page.getByTestId(`pool-assign-${playerId}`).tap();
  await expect(page.getByTestId("pool-sheet"), "투입을 누르면 시트가 닫혀 보드가 보여야 한다").toHaveCount(0);
}

// ── ① 안내 상태 진입 ─────────────────────────────────────────────────────────
test("① 경기전 — [투입] 을 누르면 '교체할 선수를 선택해주세요' + 선발·후보 슬롯이 활성화된다", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await openBriefing(page);
  await page.screenshot({ path: `${SMOKE_DIR}p442-idle-390.png` }); // ← 대조군(대기 아님)
  await startAssign(page, "FW3");

  const bar = page.getByTestId("assign-bar");
  await expect(bar).toBeVisible();
  await expect(bar, "hero 설계 문구 그대로").toContainText("교체할 선수를 선택해주세요");
  await expect(bar, "누구를 넣는 중인지 말해야 한다").toContainText("공격셋");

  const targets = await assignTargets(page);
  console.log(`[#442-①] 활성 슬롯 ${targets.length}개 = ${JSON.stringify(targets.slice(0, 4))}…`);
  // 선발 11 + 후보(벤치) 7 — hero 설계의 "선발군 + 후보군"이 둘 다 열린다.
  expect(targets.filter((t) => t.startsWith("board-slot-starter-"))).toHaveLength(11);
  expect(targets.filter((t) => t.startsWith("board-slot-bench-"))).toHaveLength(7);

  /** ⚠️ **DOM 이 초록이어도 눈에 안 보일 수 있다** — 활성 표시가 다른 레이어에 눌리는 축은
   *  계약이 원리적으로 못 잡는다(#439 `.tokenDragging{opacity:.4}` 가 홀드 링을 눌렀던 전례).
   *  그래서 이 상태를 캡처로 남긴다 — 사람이 눈으로 본다. */
  await page.screenshot({ path: `${SMOKE_DIR}p442-assign-390.png` });

  // 안내 상태 밖에서는 활성 표시가 하나도 없다(= 이 표시가 상태를 실제로 말한다).
  await page.getByTestId("assign-cancel").tap();
  expect(await assignTargets(page)).toEqual([]);
});

// ── ② 슬롯 탭 = 교체 ────────────────────────────────────────────────────────
test("② 선발 슬롯을 탭하면 그 자리 선수와 교체된다(실터치)", async ({ page }) => {
  await openBriefing(page);
  await startAssign(page, "FW3");

  // 슬롯 10 = ELEVEN 의 마지막 = FW2 가 앉아 있는 자리(교체 대상).
  await page.getByTestId("board-slot-starter-10").tap();

  await expect(
    page.getByTestId("board-slot-starter-10").getByTestId("token-FW3"),
    "투입한 선수가 그 자리에 들어가야 한다",
  ).toBeVisible();
  await expect(
    page.getByTestId("board-slot-bench-0").getByTestId("token-FW2"),
    "밀려난 선발은 투입 선수가 있던 벤치 자리로 내려가야 한다(스쿼드에서 사라지지 않는다)",
  ).toBeVisible();
  await expect(page.getByTestId("starter-count"), "교체는 선발 수를 바꾸지 않는다").toHaveText(/11\/11/);
  await expect(page.getByTestId("assign-bar"), "교체가 끝나면 안내 상태도 끝난다").toHaveCount(0);
  expect(await assignTargets(page)).toEqual([]);
});

// ── ③ 취소 ──────────────────────────────────────────────────────────────────
test("③ 취소 — 안내 상태에서 빠져나오면 덱은 한 자리도 안 바뀐다", async ({ page }) => {
  await openBriefing(page);
  const before = await boardMap(page);

  await startAssign(page, "FW3");
  await expect(page.getByTestId("assign-bar")).toBeVisible();
  await page.getByTestId("assign-cancel").tap();

  await expect(page.getByTestId("assign-bar")).toHaveCount(0);
  expect(await assignTargets(page)).toEqual([]);
  expect(await boardMap(page), "취소는 아무것도 바꾸지 않는다").toEqual(before);

  // 취소 뒤에 슬롯을 눌러도 **교체가 일어나지 않는다**(상태가 진짜로 끝났나).
  await page.getByTestId("board-slot-starter-10").tap();
  expect(await boardMap(page)).toEqual(before);
});

// ── ④ R2 무회귀 — 새 동선이 뒷문이 되지 않는다 ────────────────────────────────
test("④ 경기전 — 이 동선으로도 벤치 밖 선수는 들어올 수 없다(R2 무회귀)", async ({ page }) => {
  await openBriefing(page);
  await page.getByTestId("pool-sheet-open").tap();
  await expect(page.getByTestId("player-pool")).toBeVisible();

  const offered = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="pool-assign-"]')].map((e) =>
      e.getAttribute("data-testid")!.replace("pool-assign-", "")),
  );
  console.log(`[#442-④] 경기전 [투입] 제공 선수 = ${JSON.stringify(offered)} (스쿼드 밖 ${OUTSIDE.length}명)`);
  // 후보 산출을 두 번 적으면(=poolScope 를 우회하면) 여기가 벌어진다.
  expect([...offered].sort()).toEqual([...BENCH].sort());
  for (const id of OUTSIDE) {
    await expect(page.getByTestId(`pool-assign-${id}`), `스쿼드 밖 ${id} 에 투입 손잡이가 있다`).toHaveCount(0);
  }

  await page.getByTestId("pool-sheet-close").tap();
  await expect(page.getByTestId(`token-FW4`), "스쿼드 밖 선수는 보드에 없다").toHaveCount(0);
});

// ── ⑤ 빈 슬롯 = 교체가 아니라 배치 ───────────────────────────────────────────
test("⑤ 덱셋팅 — 빈 슬롯을 탭하면 교체가 아니라 **배치**다(아무도 밀려나지 않는다)", async ({ page }) => {
  await openDeck(page);
  // 빈 자리는 **제품 경로로** 만든다(선발 11 저장 가능 상태에서 출발 → 레일에서 제거).
  await page.getByTestId("token-MF4").tap();
  await page.getByTestId("rail-remove-player").tap();
  await expect(page.getByTestId("starter-count")).toHaveText(/10\/11/);
  const before = await boardMap(page);
  expect(before["board-slot-starter-8"], "MF4 자리가 비었다").toBeNull();

  await startAssign(page, "FW4"); // 스쿼드 밖 선수 — 덱셋팅에서는 후보다(대조군)
  await page.getByTestId("board-slot-starter-8").tap();

  await expect(page.getByTestId("board-slot-starter-8").getByTestId("token-FW4")).toBeVisible();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);

  const after = await boardMap(page);
  const moved = Object.keys(before).filter((k) => before[k] !== after[k]);
  console.log(`[#442-⑤] 빈 슬롯 배치로 바뀐 자리 = ${JSON.stringify(moved)}`);
  expect(moved, "빈 자리 배치는 그 한 칸만 바꾼다 — 교체가 아니다").toEqual(["board-slot-starter-8"]);
});
