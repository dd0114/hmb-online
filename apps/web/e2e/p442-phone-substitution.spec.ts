import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { openCandidatesTab, openCandidatesTabIfPresent, selectBoardPlayer } from "./deck-tabs";

/** 실화면 증빙 — DOM 계약이 초록인데 어포던스가 안 보이는 축은 캡처로만 잡힌다(#439 `.tokenDragging`). */
const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

/**
 * #442 R1 — **폰 선수 엔트리 동선**(목록 탭 → [엔트리] → "명단에서 바꿀 선수를 선택하세요" → 슬롯 탭).
 *
 * ⚠️ 용어는 **R3-A** 에서 바뀌었다(hero: *"엔트리나, 명단으로 사용하자. 투입이랑 교체 대신 그
 * 단어가 맞는거 같아."*) — 라벨·안내 문구는 아래 ⑥ 이 리터럴로 박는다.
 * **R3-B**: 이미 명단에 있는 선수는 그 버튼이 **잠긴다**(⑦⑧).
 *
 * ── 왜 이 동선이 필요한가 (구조적 부재, #439 1R 독립검증이 "정당한 이월"로 판정한 항목) ──────
 * 폰에서 선수 목록은 **아래에서 올라오는 시트가 보드를 완전히 덮는다**(#244 프롬프트-우선 전환의
 * 귀결). 그래서 `PlayerPicker` 의 `useDraggable`(리스트 → 슬롯 드래그)은 **드롭 대상이 화면에
 * 없어 원리적으로 도달 불가능한 죽은 코드**다. 목록에서 고른 선수가 갈 수 있는 자리는
 * `sheetSlot ?? firstEmptySlot` 하나뿐이었고, 스쿼드가 꽉 찬 상태(=경기전 명단 교체의 정의)에서는
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

/** 지금 "엔트리 대상"으로 활성화된 슬롯 목록. */
async function assignTargets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-assign-target="true"]')].map((e) => e.getAttribute("data-testid")!),
  );
}

/**
 * 목록 시트를 열고 그 선수의 [엔트리] 를 실터치로 누른다 → 안내 상태 진입.
 * ⚠️ 이 헬퍼는 **덱셋팅과 경기전을 둘 다** 태운다. #455 A1 이후 덱셋팅(폰)에서는 여는 버튼이
 *    [👥 후보] 탭 안이고 경기전은 종전 그대로라, 탭이 있을 때만 연다.
 */
async function startAssign(page: Page, playerId: string) {
  await openCandidatesTabIfPresent(page);
  await page.getByTestId("pool-sheet-open").tap();
  await expect(page.getByTestId("player-pool")).toBeVisible();
  await page.getByTestId(`pool-assign-${playerId}`).tap();
  await expect(page.getByTestId("pool-sheet"), "엔트리를 누르면 시트가 닫혀 보드가 보여야 한다").toHaveCount(0);
}

// ── ① 안내 상태 진입 ─────────────────────────────────────────────────────────
test("① 경기전 — [엔트리] 를 누르면 '명단에서 바꿀 선수를 선택하세요' + 선발·후보 슬롯이 활성화된다", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await openBriefing(page);
  await page.screenshot({ path: `${SMOKE_DIR}p442-idle-390.png` }); // ← 대조군(대기 아님)
  await startAssign(page, "FW3");

  const bar = page.getByTestId("assign-bar");
  await expect(bar).toBeVisible();
  await expect(bar, "R3-A 확정 문구 그대로").toContainText("명단에서 바꿀 선수를 선택하세요");
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

// ── ② 슬롯 탭 = 명단 맞바꾸기 ────────────────────────────────────────────────
test("② 선발 슬롯을 탭하면 그 자리 선수와 맞바뀐다(실터치)", async ({ page }) => {
  await openBriefing(page);
  await startAssign(page, "FW3");

  // 슬롯 10 = ELEVEN 의 마지막 = FW2 가 앉아 있는 자리(맞바꿀 대상).
  await page.getByTestId("board-slot-starter-10").tap();

  await expect(
    page.getByTestId("board-slot-starter-10").getByTestId("token-FW3"),
    "엔트리한 선수가 그 자리에 들어가야 한다",
  ).toBeVisible();
  await expect(
    page.getByTestId("board-slot-bench-0").getByTestId("token-FW2"),
    "밀려난 선발은 올라온 선수가 있던 벤치 자리로 내려가야 한다(스쿼드에서 사라지지 않는다)",
  ).toBeVisible();
  await expect(page.getByTestId("starter-count"), "맞바꾸기는 선발 수를 바꾸지 않는다").toHaveText(/11\/11/);
  await expect(page.getByTestId("assign-bar"), "자리가 정해지면 안내 상태도 끝난다").toHaveCount(0);
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

  // 취소 뒤에 슬롯을 눌러도 **자리가 바뀌지 않는다**(상태가 진짜로 끝났나).
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
  console.log(`[#442-④] 경기전 [엔트리] 제공 선수 = ${JSON.stringify(offered)} (스쿼드 밖 ${OUTSIDE.length}명)`);
  // 후보 산출을 두 번 적으면(=poolScope 를 우회하면) 여기가 벌어진다.
  expect([...offered].sort()).toEqual([...BENCH].sort());
  for (const id of OUTSIDE) {
    await expect(page.getByTestId(`pool-assign-${id}`), `스쿼드 밖 ${id} 에 엔트리 손잡이가 있다`).toHaveCount(0);
  }

  await page.getByTestId("pool-sheet-close").tap();
  await expect(page.getByTestId(`token-FW4`), "스쿼드 밖 선수는 보드에 없다").toHaveCount(0);
});

// ── ⑤ 빈 슬롯 = 맞바꾸기가 아니라 배치 ──────────────────────────────────────
test("⑤ 덱셋팅 — 빈 슬롯을 탭하면 맞바꾸기가 아니라 **배치**다(아무도 밀려나지 않는다)", async ({ page }) => {
  await openDeck(page);
  // 빈 자리는 **제품 경로로** 만든다(선발 11 저장 가능 상태에서 출발 → 레일에서 제거).
  // #455 A2 — 폰 덱셋팅은 토큰 탭이 **선수 메뉴**를 연다. 지시 칸으로 가는 경로는 그 메뉴의
  // [한마디 쓰기] 이고, 헬퍼가 화면의 `data-layout` 을 읽어 그 화면에서 참인 경로를 단언한다.
  // (실터치 유지 — `touch: true` 는 `.tap()` 만 쓴다. 이 파일에 `page.mouse` 는 여전히 없다.)
  await selectBoardPlayer(page, "MF4", { touch: true });
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
  expect(moved, "빈 자리 배치는 그 한 칸만 바꾼다 — 맞바꾸기가 아니다").toEqual(["board-slot-starter-8"]);
});

// ── ⑥ R3-A/R4-A 용어 — 엔트리 / 벤치 / 명단 ──────────────────────────────────
/**
 * hero(R3-A): *"엔트리나, 명단으로 사용하자. 투입이랑 교체 대신 그 단어가 맞는거 같아."*
 * hero(R4-A): *"투입할도 명단에 넣을로 다 바꿔. 투입, 벤치, 명단만 단어 사용하자."*
 * ⚠️ **문자열을 리터럴로 박는다** — 앱과 같은 상수를 import 하면 상수를 바꾸는 변이가 통과한다
 * (`apps/web/CLAUDE.md` "초록으로 거짓말하는 방식" ②).
 */
test("⑥ 용어 — 행 버튼은 [엔트리], 후보 목록은 [벤치], 안내는 '명단에서 바꿀 선수를 선택하세요'", async ({ page }) => {
  await openBriefing(page);
  // R4-A — 경기전 후보 목록의 이름은 `벤치` 다(구 `교체 선수`).
  await expect(page.getByTestId("pool-sheet-open")).toHaveText(/^벤치 \(\d+\)$/);

  await page.getByTestId("pool-sheet-open").tap();
  await expect(page.getByTestId("player-pool")).toBeVisible();
  await expect(page.getByTestId("pool-assign-FW3")).toHaveText("엔트리");

  await page.getByTestId("pool-assign-FW3").tap();
  const bar = page.getByTestId("assign-bar");
  await expect(bar).toContainText("명단에서 바꿀 선수를 선택하세요");
  // 구 용어가 이 동선 어디에도 남아 있지 않다(배너는 "…선수 엔트리" + 안내 + [취소]).
  expect(await bar.innerText(), "구 용어 잔재").not.toMatch(/투입|교체/);
});

// ── ⑨ R4-A 전수 스캔 — 한 화면에 `투입`·`교체` 가 0건 ────────────────────────
/**
 * hero 가 실제로 본 결함은 낱말 하나가 아니라 **한 화면에 네 단어가 같이 뜬다**였다
 * (`엔트리` 배너 바로 윗줄이 *"…투입할 교체 선수가 없습니다"*, 시트 제목은 `교체 선수 (3)`).
 * 그래서 계약도 낱말 하나가 아니라 **화면 전수 스캔**이다.
 *
 * hero 확정 용어축: **엔트리**(= 벤치 또는 선발) · **벤치** · **명단** · **투입**(= 경기장에
 * 들어가는 것). *"투입은 경기장 투입이여서 구분되어야해."* → 덱·경기전 화면에는 경기장이 없으므로
 * `투입` 이 뜨면 그 자체가 결함이고, `교체` 도 여기서는 축구의 교체가 아니다.
 *
 * ⛔ **하프타임(감독시간)은 이 스캔에서 제외한다** — 거긴 진짜 경기장 교체다(≤3명 · GK≥1 ·
 * `subs` 전송, `match-logic.ts`). 그 화면까지 쓸어버리면 축구 규칙을 말하는 유일한 이름이 사라진다.
 * 이 스캔의 대상은 **덱셋팅 `/deck` 과 경기전 `BRIEFING`** 두 화면뿐이다.
 *
 * ⚠️ `innerText` 만 보면 부족하다 — Auto 버튼의 힌트는 `title` 속성으로도 산다(`TeamSheetBar`).
 * 스크린리더 문자열(`aria-label`)도 UI 다.
 *
 * ⚠️ **스캔 영역 = 스쿼드 구성 UI**(`deck-editor` 서브트리 + 시트 `pool-sheet` — 시트는 Modal 이라
 * 포털로 밖에 산다). 그 밖의 경기 화면 부품은 대상이 아니다: 경기전 하단 [오토] 토글의 힌트가
 * *"…감독시간(3분) 동안 후반 지시와 **교체**를 할 수 있습니다"* 인데 그건 **경기장에서 일어날 일**을
 * 미리 말하는 문장이라 hero 축에서 `교체` 가 맞는 말이다. 다만 그 예외가 **조용히 넓어지지 않게**
 * 아래 두 번째 단언이 "영역 밖 잔재는 전부 감독시간 문장뿐"임을 같이 잠근다.
 */
const SCAN_ROOTS = ["deck-editor", "pool-sheet"];

async function bannedWords(page: Page, roots: string[] | null): Promise<string[]> {
  return page.evaluate((rootIds) => {
    const hits: string[] = [];
    const push = (where: string, text: string | null) => {
      if (text && /투입|교체/.test(text)) hits.push(`${where}: ${text.trim().replace(/\s+/g, " ").slice(0, 80)}`);
    };
    const scopes: Element[] = rootIds
      ? rootIds
          .map((id) => document.querySelector(`[data-testid="${id}"]`))
          .filter((e): e is Element => Boolean(e))
      : [document.body];
    for (const scope of scopes) {
      // ⚠️ **줄 단위로 쪼개서 본다** — 통짜 `innerText` 를 한 건으로 담으면 잔재 하나가 화면 전체를
      //    한 문자열로 만들어 "어느 문장이 걸렸나"를 못 읽는다(예외 판별도 못 한다).
      for (const line of (scope as HTMLElement).innerText.split("\n")) push("text", line);
      for (const attr of ["title", "aria-label", "placeholder"]) {
        for (const el of scope.querySelectorAll(`[${attr}]`)) push(attr, el.getAttribute(attr));
      }
    }
    return hits;
  }, roots);
}

test("⑨ 경기전 화면 전수 — `투입`·`교체` 가 한 글자도 없다(엔트리/벤치/명단만)", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await openBriefing(page);
  expect(await bannedWords(page, SCAN_ROOTS), "경기전 기본 상태").toEqual([]);
  /** ★ 눈 판정용 — hero 가 본 결함이 "한 화면에 네 단어가 같이 뜬다"였다. 스캔은 문자열만 보므로
   *  **한 화면에 무엇이 같이 서 있나**는 사람이 본다(루트 §2-2). */
  await page.screenshot({ path: `${SMOKE_DIR}p442-r4-briefing-390.png` });

  await page.getByTestId("pool-sheet-open").tap();
  await expect(page.getByTestId("player-pool")).toBeVisible();
  expect(await bannedWords(page, SCAN_ROOTS), "벤치 시트가 열린 상태(제목·행·손잡이)").toEqual([]);
  await page.screenshot({ path: `${SMOKE_DIR}p442-r4-briefing-sheet-390.png` });

  await page.getByTestId("pool-assign-FW3").tap();
  await expect(page.getByTestId("assign-bar")).toBeVisible();
  expect(await bannedWords(page, SCAN_ROOTS), "엔트리 대기 상태(배너 + 보드)").toEqual([]);

  // 영역 **밖**의 잔재는 감독시간(=경기장)을 말하는 문장뿐이다 — 예외가 조용히 넓어지면 여기서 죽는다.
  const outside = await bannedWords(page, null);
  console.log(`[#442-⑨] 영역 밖 잔재 ${outside.length}건 = ${JSON.stringify(outside)}`);
  for (const hit of outside) {
    expect(hit, "덱·경기전 UI 에 새 '투입/교체' 문자열이 생겼다").toContain("감독시간");
  }
});

test("⑨-b 덱셋팅 화면 전수 — 같은 규칙(빈 자리·Auto 힌트 포함)", async ({ page }) => {
  await openDeck(page);
  expect(await bannedWords(page, SCAN_ROOTS), "덱셋팅 기본 상태").toEqual([]);

  /**
   * ★ **새 UI 면은 스캔 영역에 들어와야 한다** (#455 A2 — 선수 메뉴 시트).
   * `SCAN_ROOTS` 는 `deck-editor` + `pool-sheet` 인데 메뉴는 **또 다른 모달**이라 그 둘 밖에 산다.
   * 스캔 영역을 안 넓히면 새 화면이 생길 때마다 용어 규칙이 조용히 적용되지 않는다 —
   * 아래 "화면 **전체**" 단언이 그것을 덮지만, 그건 **메뉴가 열려 있을 때만** 참이므로
   * 여기서 한 번 열어 둔 채로 잰다.
   */
  await page.getByTestId("token-MF4").tap();
  await expect(page.getByTestId("player-menu")).toHaveCount(1);
  expect(await bannedWords(page, ["player-menu"]), "선수 메뉴가 열린 상태").toEqual([]);
  expect(await bannedWords(page, null), "선수 메뉴를 포함한 화면 전체").toEqual([]);
  await page.getByTestId("pmenu-close").tap();
  await expect(page.getByTestId("player-menu")).toHaveCount(0);

  // 빈 자리를 만들어 Auto 힌트가 **활성 문구**로 갈리는 갈래도 태운다(둘 다 문구가 다르다).
  // #455 A2 — 폰 덱셋팅은 토큰 탭이 **선수 메뉴**를 연다. 지시 칸으로 가는 경로는 그 메뉴의
  // [한마디 쓰기] 이고, 헬퍼가 화면의 `data-layout` 을 읽어 그 화면에서 참인 경로를 단언한다.
  // (실터치 유지 — `touch: true` 는 `.tap()` 만 쓴다. 이 파일에 `page.mouse` 는 여전히 없다.)
  await selectBoardPlayer(page, "MF4", { touch: true });
  await page.getByTestId("rail-remove-player").tap();
  await expect(page.getByTestId("starter-count")).toHaveText(/10\/11/);
  expect(await bannedWords(page, SCAN_ROOTS), "빈 자리 있는 상태").toEqual([]);

  await openCandidatesTab(page); // #455 A1: 폰 덱셋팅에서 여는 버튼은 [👥 후보] 탭 안
  await page.getByTestId("pool-sheet-open").tap();
  await expect(page.getByTestId("player-pool")).toBeVisible();
  expect(await bannedWords(page, SCAN_ROOTS), "보유 선수 시트가 열린 상태").toEqual([]);
  // ★ 눈 판정용 — 잠긴 [엔트리]와 열린 [엔트리]가 한 화면에 서는 시트(FW4 만 열려 있다).
  await page.getByTestId("pool-sheet").screenshot({ path: `${SMOKE_DIR}p442-r4-deck-sheet.png` });

  // 덱셋팅은 경기 부품이 없다 → 화면 **전체**가 깨끗해야 한다(경기전보다 강한 단언).
  expect(await bannedWords(page, null), "덱셋팅 화면 전체").toEqual([]);
});

// ── ⑩ R4-B 드롭 semantics — 밀려난 선수는 벤치로 ────────────────────────────
/**
 * hero: *"벤치 자리있으면 벤치 벤치 자리없으면 빼자."*
 *
 * 구 동작은 **무조건 덱에서 뺐다** — 미배치 선수를 찬 자리에 넣으면 앉아 있던 선수가 **프롬프트째**
 * 사라졌고(빈 벤치 칸이 남아 있어도) 되돌리기가 없었다(#442 독립검증 minor-2).
 *
 * 스코프는 **덱셋팅뿐**이다 — 경기전 후보는 정의상 전원 벤치 선수라(#439 R2) 이 갈래에 도달할
 * 수 없다(그 화면의 모든 이동은 맞바꾸기다, ② 가 그걸 잰다). 로직 3갈래 =
 * `src/deck/tactics-logic.test.ts` "#442 R4-B".
 */
test("⑩ 덱셋팅 — 미배치 선수를 찬 자리에 넣으면 밀려난 선수가 **벤치로 내려간다**(지시도 따라간다)", async ({ page }) => {
  await openDeck(page);

  // 밀려날 선수(MF4, 선발 8)에 지시를 남긴다 — 그 문장이 살아남는지가 이 결정의 취지다.
  // #455 A2 — 폰 덱셋팅은 토큰 탭이 **선수 메뉴**를 연다. 지시 칸으로 가는 경로는 그 메뉴의
  // [한마디 쓰기] 이고, 헬퍼가 화면의 `data-layout` 을 읽어 그 화면에서 참인 경로를 단언한다.
  // (실터치 유지 — `touch: true` 는 `.tap()` 만 쓴다. 이 파일에 `page.mouse` 는 여전히 없다.)
  await selectBoardPlayer(page, "MF4", { touch: true });
  await page.getByTestId("rail-prompt-input").fill("측면을 넓게 벌려라");
  await expect(page.getByTestId("rail-prompt-input")).toHaveValue("측면을 넓게 벌려라");

  // 벤치는 FW3(0)·GK2(1) 뿐 → 첫 빈 자리는 벤치 2.
  await expect(page.getByTestId("board-slot-bench-2").locator('[data-testid^="token-"]')).toHaveCount(0);

  await startAssign(page, "FW4"); // 스쿼드 밖(미배치) — 이 갈래의 유일한 입구
  await page.getByTestId("board-slot-starter-8").tap();

  await expect(page.getByTestId("board-slot-starter-8").getByTestId("token-FW4")).toBeVisible();
  // #455 A1: 배치되면 그 선수 지시로 넘어가느라 탭이 [전체 지시]로 간다(#244 A′) → 벤치를 보려면
  // [👥 후보] 탭을 연다. ⚠️ 정원 초과 변이는 토큰 부재로 위장하므로 아래 `bench-count` 도 같이 본다
  // (이 파일 R4-B 절이 그 이유를 적어 두었다).
  await openCandidatesTab(page);
  await expect(
    page.getByTestId("board-slot-bench-2").getByTestId("token-MF4"),
    "빈 벤치가 있는데 덱에서 사라지면 안 된다",
  ).toBeVisible();
  await expect(page.getByTestId("board-slot-bench-0").getByTestId("token-FW3"), "기존 벤치는 안 밀린다").toBeVisible();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);

  // 지시 보존 — 밀려난 선수를 다시 눌러 그 문장이 그대로인지 본다.
  // #455 A2 — 폰 덱셋팅은 토큰 탭이 **선수 메뉴**를 연다. 지시 칸으로 가는 경로는 그 메뉴의
  // [한마디 쓰기] 이고, 헬퍼가 화면의 `data-layout` 을 읽어 그 화면에서 참인 경로를 단언한다.
  // (실터치 유지 — `touch: true` 는 `.tap()` 만 쓴다. 이 파일에 `page.mouse` 는 여전히 없다.)
  await selectBoardPlayer(page, "MF4", { touch: true });
  await expect(page.getByTestId("rail-prompt-input")).toHaveValue("측면을 넓게 벌려라");
});

// ── ⑦ R3-B 잠금 — 이미 명단에 있는 선수 ──────────────────────────────────────
/**
 * hero: *"투입 가능한 선수들만 옆에 띄우거나 이미 있는 선수는 버튼 비활성화 된 모습으로 보이게하자."*
 * → **비활성화** 를 택했다(행을 숨기면 목록의 선수 수가 화면마다 달라져 스캔이 어렵다).
 *
 * ⚠️ 실화면 캡처를 같이 남긴다 — `disabled` 는 DOM 사실이고 **"눈에 구분되나"는 계약이 원리적으로
 * 못 잡는다**(#439 `.tokenDragging` 이 홀드 링을 눌렀던 전례).
 */
test("⑦ 덱셋팅 — 덱에 있는 선수는 [엔트리] 잠김, 미배치 선수는 열려 있다", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await openDeck(page);
  await openCandidatesTab(page); // #455 A1: 폰 덱셋팅에서 여는 버튼은 [👥 후보] 탭 안
  await page.getByTestId("pool-sheet-open").tap();
  await expect(page.getByTestId("player-pool")).toBeVisible();

  const locked: string[] = [];
  for (const id of [...ELEVEN, ...BENCH]) {
    await expect(page.getByTestId(`pool-assign-${id}`), `${id} 는 이미 덱에 있다`).toBeDisabled();
    locked.push(id);
  }
  for (const id of OUTSIDE) {
    await expect(page.getByTestId(`pool-assign-${id}`), `${id} 는 덱 밖이다`).toBeEnabled();
  }
  console.log(`[#442-⑦] 잠긴 선수 ${locked.length}명 / 열린 선수 ${OUTSIDE.length}명 = ${JSON.stringify(OUTSIDE)}`);

  // 잠긴 버튼을 실제로 탭해도 대기 상태로 들어가지 않는다(라벨만 회색인 것이 아니다).
  await page.getByTestId(`pool-assign-${ELEVEN[0]}`).tap({ force: true });
  await expect(page.getByTestId("assign-bar"), "잠긴 손잡이가 동선을 열면 안 된다").toHaveCount(0);
  await expect(page.getByTestId("pool-sheet"), "시트도 그대로 열려 있다").toHaveCount(1);

  // ★ 눈 판정용 — FW 필터는 잠김(FW1·FW2 선발 · FW3 벤치)과 열림(FW4)이 **한 화면에** 선다.
  await page.screenshot({ path: `${SMOKE_DIR}p442-r3b-lock-390.png` });
  await page.getByTestId("picker-filter-FW").tap();
  await expect(page.getByTestId("pool-assign-FW4")).toBeEnabled();
  await page.getByTestId("pool-sheet").screenshot({ path: `${SMOKE_DIR}p442-r3b-lock-sheet.png` });
});

// ── ⑧ 잠금이 R2 동선을 죽이지 않는다 ─────────────────────────────────────────
/**
 * ⛔ 경기전 후보는 **전원 벤치 선수**다. 잠금 판정을 "덱에 자리가 있나"로 적으면 여기서 **전부**
 * 잠겨 hero 가 요구한 경기전 엔트리 동선이 통째로 죽는다. 그래서 "명단"의 뜻이 화면마다 다르고
 * (덱셋팅 = 덱 전체 / 경기전 = 선발), 그 판정은 `poolScope` 를 아는 `DeckEditor` 한 곳에만 있다.
 */
test("⑧ 경기전 — 벤치 선수의 [엔트리] 는 열려 있고 끝까지 동작한다", async ({ page }) => {
  await openBriefing(page);
  await page.getByTestId("pool-sheet-open").tap();
  await expect(page.getByTestId("player-pool")).toBeVisible();
  for (const id of BENCH) {
    await expect(
      page.getByTestId(`pool-assign-${id}`),
      `${id} 가 잠기면 경기전 엔트리 동선이 통째로 죽는다`,
    ).toBeEnabled();
  }

  // 열려 있다는 것이 라벨이 아니라 **동작**임을 끝까지 확인한다.
  await page.getByTestId("pool-assign-FW3").tap();
  await expect(page.getByTestId("assign-bar")).toBeVisible();
  await page.getByTestId("board-slot-starter-10").tap();
  await expect(page.getByTestId("board-slot-starter-10").getByTestId("token-FW3")).toBeVisible();
});
