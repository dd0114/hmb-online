import { expect, test, type Page } from "@playwright/test";
import { bootstrap, deckSlots, hitAt } from "./deck-mock";
import { selectBoardPlayer } from "./deck-tabs";

/**
 * #455 **A3 — 오토 → 자동 채우기**.
 *
 * ── 이 웨이브가 하는 일 (그리고 하지 **않는** 일) ────────────────────────────────
 * `fillEmptySlots`(`src/deck/fill-empty.ts`)는 **이미** 빈 칸만 채운다(#439, hero Q1=ⓑ).
 * A3 이 바꾸는 것은 **동작이 아니라 노출과 자리** 셋뿐이다:
 *   ① 버튼 3곳 산재(`auto-fill-top` 시트 바 · `board-empty-auto` 빈 상태 · `auto-fill` 보드 바) → **하나**
 *   ② **빈칸이 있을 때만** 노출 — 벤치는 **앞 3칸**만 "채워야 할 칸"(hero 확정 계약)
 *   ③ 자리 = **경기장 우측 하단**(목업 `docs/plan-v5/mock/455-decka` `.autoFill`)
 * 채우기 규칙(무엇이 어디로 가나 · 프롬프트 보존)은 `p439-phone-deck-ux.spec.ts` ④ 가 소유한다 —
 * 여기서는 **A3 이 그 규칙을 깨지 않았다**는 것만 AC4 로 재확인한다.
 *
 * ── 왜 벤치 "앞 3칸"인가 ──────────────────────────────────────────────────────
 * hero 확정(#455 comment 5196070445): *"7칸 전부로 잡으면 [자동 채우기]가 상시 노출"*.
 * 벤치는 7칸인데 유저가 7명을 다 채우는 일은 드물어서, 7칸 기준이면 ②가 사실상 무효가 된다.
 *
 * ── "초록으로 거짓말" 방어 ────────────────────────────────────────────────────
 * ⚠️ **`toBeVisible()` 을 도달 판정에 쓰지 않는다** — 뷰포트 밖도 통과한다(apps/web/CLAUDE.md ③,
 *    A1 2R blocker-B 가 그것이었다). AC3 은 `elementFromPoint` 히트로 잰다.
 * ⚠️ **`toHaveCount(0)` 은 앵커와 같이 쓴다**(같은 표 ⑥) — AC2 는 같은 화면에서 보드·벤치 칸이
 *    실제로 그려진 것을 먼저 단언하고 나서 부재를 잰다.
 * ⚠️ **"버튼이 하나뿐"을 testid 나열로만 재면 4번째 버튼이 새로 생겨도 통과한다.** 그래서
 *    AC1 은 화면 안 `<button>` 전수에서 **접근 이름**으로도 센다(나열은 회귀 방향만 막는다).
 *
 * ⚠️ 실행: 전체 e2e 금지(:8080 데모 충돌) — 스펙 지정 + 빈 포트.
 *    `CI=1 WEB_E2E_PORT=5951 npx playwright test e2e/p455-a3-auto-fill.spec.ts --timeout=25000`
 */

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, hasTouch: true });

test.beforeEach(async ({ page }) => {
  expect(page.viewportSize(), "이 계약은 실제 폰 뷰포트에서만 유효하다").toEqual(PHONE);
});

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** 확정 계약의 벤치 기준 — **앞 3칸**. 리터럴로 박는다(앱 상수를 import 하면 임계 변이가 통과한다). */
const BENCH_GAP = 3;

/** 선발 11 + 벤치 **앞 3칸까지** 찬 덱 = 이 화면에 "채워야 할 칸"이 하나도 없는 상태. */
function noGapSlots() {
  const s = deckSlots();
  return [...s, { playerId: "FW4", role: "bench", slotIndex: 2, promptText: null }];
}

async function openDeck(page: Page, slots: unknown[] = deckSlots(), anchor = "token-MF1") {
  await bootstrap(page, slots);
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await expect(page.getByTestId(anchor)).toBeVisible();
}

const MATCH = {
  id: "m455a3",
  createdAt: "2026-08-06T00:00:00Z",
  state: "BRIEFING",
  conditions: {},
  opponent: { name: "역습 봇", analysisText: "빠른 역습.", deck: [] },
};

async function openBriefing(page: Page, slots: unknown[] = deckSlots()) {
  await bootstrap(page, slots);
  await page.route((url) => url.pathname === "/api/matches/m455a3", (r) => r.fulfill(json(MATCH)));
  await page.goto("/match/m455a3");
  await expect(page.getByTestId("briefing-panel")).toBeVisible();
  await expect(page.getByTestId("tactics-board")).toBeVisible();
}

/** 이 화면에서 auto 를 발화시킬 수 있는 손잡이 전부(구 3곳 포함) — AC1 의 분모. */
const AUTO_TESTIDS = ["auto-fill", "auto-fill-top", "board-empty-auto"] as const;

async function autoHandleCount(page: Page) {
  let n = 0;
  for (const id of AUTO_TESTIDS) n += await page.getByTestId(id).count();
  return n;
}

/**
 * 화면 안 `<button>` 중 **auto/자동 을 말하는 것** 의 수 — testid 나열이 못 보는 축.
 * (문구는 조정 포인트라 넓게 잡는다: 새 버튼이 다른 testid 로 들어와도 여기서 걸린다.)
 */
async function autoLabelledButtons(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter((b) => {
        const st = getComputedStyle(b);
        if (st.display === "none" || st.visibility === "hidden") return false;
        return /auto|자동\s*채우기/i.test(`${b.textContent ?? ""} ${b.getAttribute("aria-label") ?? ""}`);
      })
      .map((b) => `${b.getAttribute("data-testid") ?? "(no-testid)"}:${(b.textContent ?? "").trim()}`),
  );
}

/** 그 요소의 중심이 **실제로 화면에 있고 그 지점의 최상단이 자기 자신인가**. */
async function reachable(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) return { box: null, onScreen: false, hit: false };
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const onScreen = cx > 0 && cy > 0 && cx < PHONE.width && cy < PHONE.height;
  return { box, onScreen, hit: onScreen ? await hitAt(page, cx, cy, testId) : false };
}

/** 슬롯 → 앉아 있는 선수(없으면 null). 자리 이동을 재는 스냅샷. */
const seatMap = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid^="board-slot-"]')].map((s) => [
        s.getAttribute("data-testid")!,
        s.querySelector('[data-testid^="token-"]')?.getAttribute("data-testid") ?? null,
      ]),
    ),
  );

// ── AC1 ─────────────────────────────────────────────────────────────────────
test.describe("AC1 손잡이는 하나", () => {
  for (const width of [390, 1280] as const) {
    test(`폭 ${width} — auto 손잡이가 정확히 1개`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await openDeck(page);
      // 앵커: 이 상태에는 채워야 할 칸이 있다(벤치 3번째 칸이 비었다) = 노출 조건 충족.
      await expect(page.getByTestId("auto-fill")).toHaveCount(1);
      expect(await autoHandleCount(page), "구 3곳 중 살아남은 것은 하나여야 한다").toBe(1);
      const labelled = await autoLabelledButtons(page);
      console.log(`[a3] ${width}px auto 라벨 버튼 = ${JSON.stringify(labelled)}`);
      expect(labelled).toHaveLength(1);
    });
  }
});

test("AC1 그 하나는 **경기장 안 우측 하단**에 있다", async ({ page }) => {
  await openDeck(page);
  const pitch = (await page.getByTestId("tactics-board").boundingBox())!;
  const btn = (await page.getByTestId("auto-fill").boundingBox())!;
  console.log(`[a3] pitch=${JSON.stringify(pitch)} btn=${JSON.stringify(btn)}`);
  // 경기장 사각형 안
  expect(btn.x).toBeGreaterThanOrEqual(pitch.x);
  expect(btn.y).toBeGreaterThanOrEqual(pitch.y);
  expect(btn.x + btn.width).toBeLessThanOrEqual(pitch.x + pitch.width + 1);
  expect(btn.y + btn.height).toBeLessThanOrEqual(pitch.y + pitch.height + 1);
  // 우측 하단 사분면(중심이 경기장 중앙보다 오른쪽·아래)
  expect(btn.x + btn.width / 2).toBeGreaterThan(pitch.x + pitch.width / 2);
  expect(btn.y + btn.height / 2).toBeGreaterThan(pitch.y + pitch.height / 2);
});

// ── AC2 ─────────────────────────────────────────────────────────────────────
test("AC2 빈칸이 없으면 **존재하지 않는다**(disabled 로 남기지 않는다)", async ({ page }) => {
  await openDeck(page, noGapSlots());
  // 앵커 — 이 화면은 다 그려졌다(공허한 toHaveCount(0) 방지).
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  await expect(page.getByTestId("board-card")).toBeVisible();

  expect(await autoHandleCount(page), "빈칸이 없으면 auto 손잡이는 0개").toBe(0);
  expect(await autoLabelledButtons(page)).toHaveLength(0);
});

test(`AC2 벤치 ${BENCH_GAP + 1}~7번째 칸이 비어 있는 것은 "빈칸 있음"이 아니다`, async ({ page }) => {
  await openDeck(page, noGapSlots());
  // 전제 박제 — 앞 3칸은 찼고 그 뒤는 **실제로 비어 있다**(그래야 이 계약이 공허하지 않다).
  const bench = await page.evaluate(() =>
    [...Array(7).keys()].map(
      (i) =>
        !!document
          .querySelector(`[data-testid="board-slot-bench-${i}"]`)
          ?.querySelector('[data-testid^="token-"]'),
    ),
  );
  console.log(`[a3] 벤치 점유 = ${JSON.stringify(bench)}`);
  expect(bench.slice(0, BENCH_GAP), "앞 3칸은 차 있다").toEqual([true, true, true]);
  expect(bench.slice(BENCH_GAP).some(Boolean), "뒤 4칸은 비어 있다").toBe(false);
  expect(await autoHandleCount(page), "뒤 4칸이 비어도 노출되지 않는다").toBe(0);
});

// ── AC3 ─────────────────────────────────────────────────────────────────────
test("AC3 벤치 앞 3칸에 빈칸이 있으면 노출되고 **눌러서 닿는다**", async ({ page }) => {
  await openDeck(page); // 벤치 2명 = 3번째 칸이 비었다
  const r = await reachable(page, "auto-fill");
  console.log(`[a3] 벤치 빈칸 → ${JSON.stringify(r)}`);
  expect(r.onScreen, "버튼 중심이 폰 화면 안에 있어야 한다").toBe(true);
  expect(r.hit, "그 지점의 최상단 요소가 이 버튼이어야 한다").toBe(true);
});

test("AC3 선발에 빈칸이 있으면 노출되고 눌러서 닿는다(빈 덱)", async ({ page }) => {
  await openDeck(page, [], "board-empty");
  await expect(page.getByTestId("starter-count")).toHaveText(/0\/11/);
  const r = await reachable(page, "auto-fill");
  console.log(`[a3] 빈 덱 → ${JSON.stringify(r)}`);
  expect(r.onScreen).toBe(true);
  expect(r.hit, "빈 상태 안내 카드가 버튼을 덮으면 안 된다").toBe(true);
  // 그리고 실제로 눌리면 채워진다(도달 = 동작까지).
  await page.getByTestId("auto-fill").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
});

/**
 * **AC3-b — `.corner { z-index: 4 }` 가 INERT 라는 *전제* 를 박제한다** (A3 독립검증 minor-1).
 *
 * 그 값을 2 로 내려도 위 AC3 이 11/11 통과한다 = **이 계약이 z-index 를 재지 못한다**. 그런데
 * CSS 주석은 *"계약이 `elementFromPoint` 로 그 순서를 잰다"* 고 적고 있었다 — 검사하는 척한 것이다.
 * 같은 커밋이 m-1 로 `.growBadge{z-index:3}` 를 이 부류라고 박제해 놓고 자기가 다시 만들었다.
 *
 * 못 재는 이유는 **둘 다 z-index 와 무관**하고, 그래서 여기서 재는 것도 z-index 가 아니라 그 둘이다:
 *   ① `.empty` 가 `pointer-events: none` → 히트테스트는 **원리적으로** 페인트 순서를 못 본다
 *   ② 출하 기하에서 두 사각형이 **애초에 안 겹친다**
 * 둘 중 하나라도 깨지면 z-index 가 INERT 가 아니게 되고, 그때 이 단언이 **먼저** red 가 된다
 * (= "여기 결정이 있었다"는 신호). 값을 지우지 않은 이유는 롤백 자산이라서다.
 */
test("AC3-b 빈 상태 안내 카드는 히트테스트에 안 잡히고, 버튼과 겹치지도 않는다", async ({ page }) => {
  await openDeck(page, [], "board-empty");
  const m = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-testid="board-empty"]');
    const btn = document.querySelector<HTMLElement>('[data-testid="auto-fill"]');
    if (!card || !btn) return null;
    const c = card.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return {
      pe: getComputedStyle(card).pointerEvents,
      overlaps: !(c.right <= b.left || c.left >= b.right || c.bottom <= b.top || c.top >= b.bottom),
      card: [Math.round(c.top), Math.round(c.bottom)],
      btn: [Math.round(b.top), Math.round(b.bottom)],
    };
  });
  console.log(`[a3] z-index INERT 전제 → ${JSON.stringify(m)}`);
  expect(m, "두 요소가 다 있어야 이 전제를 잴 수 있다").not.toBeNull();
  expect(m!.pe, "`.empty` 는 포인터를 안 받는다 — 이게 참인 한 히트테스트는 겹침을 못 본다").toBe("none");
  expect(m!.overlaps, `안내 카드와 버튼은 겹치지 않는다 (card ${m!.card} vs btn ${m!.btn})`).toBe(false);
});

// ── AC4 ─────────────────────────────────────────────────────────────────────
/**
 * ⚠️ **규칙 하나당 표본 하나** (apps/web/CLAUDE.md "초록으로 거짓말" ④).
 * AC4 는 두 갈래이고 **한 표본으로는 둘 다 못 잰다**:
 *   ⓐ *자리* — 이미 앉아 있는 선수는 안 움직인다
 *   ⓑ *문장* — 써 둔 한마디는 안 덮인다(ㄷ안 영구 기각)
 * ⚠️ ⓑ 를 "선발에 앉아 있는 선수의 문장"으로만 재면 **안 죽는다** — 그 선수는 auto 가 아예
 * 손대지 않아서(`fillEmptySlots` 는 자리를 준 선수에게만 문구를 넣는다) 덮어쓰기 변이가 그
 * 코드에 **도달하지 않는다**. 실제로 그 형태로 먼저 써 봤고 변이가 살아남았다.
 * 문장 규칙이 실제로 일하는 자리는 **벤치 → 선발 승격**이다(#439 3R, hero *"승격되는 선수도
 * 넣어줘"* 가 만든 경계). 그래서 ⓑ 표본은 승격이 일어나도록 짠다.
 */
test("AC4-a 이미 앉아 있는 선수는 자리를 안 옮긴다 — 빈 칸만 채워진다", async ({ page }) => {
  const WRITTEN = "안쪽으로 파고들어라";
  const slots = deckSlots().map((s) =>
    s.playerId === "MF1" ? { ...s, promptText: WRITTEN } : s,
  );
  await openDeck(page, slots);

  // 빈 자리는 **제품 손잡이**로 만든다(#442 R2-ⓐ — 저장 가능한 덱에서 출발한다).
  await selectBoardPlayer(page, "FW2");
  await page.getByTestId("rail-remove-player").click();
  await expect(page.getByTestId("token-FW2")).toHaveCount(0);
  await expect(page.getByTestId("starter-count")).toHaveText(/10\/11/);

  const before = await seatMap(page);
  await page.getByTestId("auto-fill").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  const after = await seatMap(page);

  const moved = Object.keys(before).filter((k) => before[k] !== after[k]);
  console.log(`[a3] 자리가 바뀐 슬롯 = ${JSON.stringify(moved.map((k) => [k, before[k], after[k]]))}`);
  // 비어 있던 자리들만 채워진다 — 이미 앉아 있던 선수는 한 명도 안 움직인다.
  for (const k of moved) expect(before[k], `${k} 는 비어 있던 자리여야 한다`).toBeNull();

  // 이미 앉아 있던 선수의 문장도 그대로다(이 축은 auto 가 그 코드에 도달조차 않는다 — 위 머리말).
  await selectBoardPlayer(page, "MF1");
  await expect(page.getByTestId("rail-prompt-input")).toHaveValue(WRITTEN);
});

test("AC4-b 써둔 한마디는 **승격돼도** 글자 그대로 남는다 (ㄷ안 영구 기각)", async ({ page }) => {
  const BENCH_WRITTEN = "들어가면 뒷공간부터 노려라";
  /**
   * 승격이 실제로 일어나게 짠 표본: 벤치 0 = **FW1(LEGEND 90)** 이고 선발 FW 두 자리는
   * FW4(80)·FW2(72) 가 쓴다. FW4 를 제품 손잡이로 빼면 그 FW 자리의 최적 후보가 **벤치의 FW1**
   * 이라 auto 가 그를 올린다 — 그 순간 `fillBlankPrompt` 가 그 선수에게 실행되고, 문장을 지키는
   * 가드가 **유일하게 일하는 자리**가 여기다.
   */
  const STARTERS = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW4", "FW2"];
  const slots = [
    ...STARTERS.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
    { playerId: "FW1", role: "bench", slotIndex: 0, promptText: BENCH_WRITTEN },
    { playerId: "GK2", role: "bench", slotIndex: 1, promptText: null },
  ];
  // ⚠️ 앵커는 **선발** 토큰으로 — FW1 은 벤치라 폰 탭 레이아웃에서 [👥 후보] 탭 안에 있다.
  await openDeck(page, slots, "token-MF1");

  await selectBoardPlayer(page, "FW4"); // 슬롯 9 = FW 자리
  await page.getByTestId("rail-remove-player").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/10\/11/);

  await page.getByTestId("auto-fill").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);

  // 전제 박제 — 승격이 **실제로** 일어났다(안 일어나면 아래 단언이 공허해진다).
  await expect(
    page.getByTestId("board-slot-starter-9").getByTestId("token-FW1"),
    "벤치의 FW1 이 빈 FW 자리로 승격돼야 이 계약이 성립한다",
  ).toBeVisible();

  // ★ 그 선수가 들고 올라온 문장이 글자 그대로 남는다 — 기본 문구로 덮이면 red.
  await selectBoardPlayer(page, "FW1");
  await expect(page.getByTestId("rail-prompt-input")).toHaveValue(BENCH_WRITTEN);
});

// ── AC5 ─────────────────────────────────────────────────────────────────────
test("AC5 경기전(BriefingPanel)도 같은 모양 — 손잡이 하나, 경기장 우측 하단", async ({ page }) => {
  await openBriefing(page);
  await expect(page.getByTestId("auto-fill")).toHaveCount(1);
  expect(await autoHandleCount(page)).toBe(1);
  const pitch = (await page.getByTestId("tactics-board").boundingBox())!;
  const btn = (await page.getByTestId("auto-fill").boundingBox())!;
  console.log(`[a3] 경기전 pitch=${JSON.stringify(pitch)} btn=${JSON.stringify(btn)}`);
  expect(btn.x + btn.width / 2).toBeGreaterThan(pitch.x + pitch.width / 2);
  expect(btn.y + btn.height / 2).toBeGreaterThan(pitch.y + pitch.height / 2);
});

test("AC5 경기전에도 빈칸이 없으면 사라진다(같은 규칙이 두 화면에 하나로 산다)", async ({ page }) => {
  await openBriefing(page, noGapSlots());
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  expect(await autoHandleCount(page)).toBe(0);
});

/**
 * **감독시간(`HalftimePanel`)은 이 파일이 재지 않는다 — 이미 세 곳이 잰다.**
 *
 * `p244-prompt-first` AC8 · `p276-halftime-shape` · `src/match/HalftimePanel.shape.test.ts`
 * 가 전부 `auto-fill`(+ 구 3곳)의 **부재**를 단언한다. A3 은 testid `auto-fill` 을 그대로 두므로
 * 그 세 계약이 이 웨이브에도 그대로 걸린다 — 여기 네 번째 사본을 만들면 다음에 화면이 바뀔 때
 * 네 곳이 각자 낡는다(`deck-tabs.ts` 머리말과 같은 이유).
 *
 * 다만 그 셋은 **화면 전체**를 태우는 계약이라 "`!placementLocked` 가드를 지운다"는 변이가
 * 감독시간 목이 갖춰졌을 때만 죽는다 → 그 한 줄은 `src/deck/TeamSheet.test.ts`
 * ("배치 잠금이면 onAuto 를 줘도 손잡이가 없다")가 유닛 층에서 직접 문다.
 */
