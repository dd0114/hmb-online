import { expect, test, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { skipSplash } from "./splash-mock";
import { appConfigPayload, mockAppConfig } from "./app-config-mock";

/**
 * #493 W9 — 온레일이 **못 하는 일 앞에서 멈추지 않는다**(skip-when-disabled).
 *
 * W8-v3 독립 검증 2(엣지케이스)가 낸 blocker 3건(B2·B6·B3)은 한 부류다: **대상이 화면에
 * 렌더되는데 유저가 그걸 수행할 수 없다**. 온레일의 기본 규율("대상이 없으면 기다린다")이
 * 이 자리에서는 정확히 반대로 작동한다 — 대상은 **있으므로** 영원히 기다린다.
 *
 *  ⓐ 쿠폰도 잔액도 없는 유저의 S6 [단축]  — 버튼은 뜨는데 `disabled`
 *  ⓑ 보유를 다 배치한 유저의 S2 [자동 채우기] — 버튼은 뜨는데 `disabled`
 *  ⓒ 진행 중 매치가 있는 유저의 S5 `/players` — 그 화면 자체에 못 간다(MatchLockGate)
 *
 * 이 스펙이 지키는 것은 **"끝까지 닿는다"** 하나다: 어떤 조합에서도 S7 완주(`finish`)에
 * 도달하고, 무엇을 왜 건너뛰었는지가 **튜토리얼 상태에 남는다**(콘솔이 아니라 — 나중에
 * "어느 유저가 어디서 무엇을 못 했나"를 세려면 그 기록이 SoT 다).
 *
 * ⚠️ 라우트 매칭은 오리진 앵커(pathname 술어)로 한다 — glob 은 vite 소스까지 먹는다(모듈 규율).
 */

const USER_ID = "u493w9";
const MATCH_ID = "m493w9";
/** 서버 `hmb.tutorial.starter.card-id` 의 현재 값 — W9 부터 `/api/config` 가 공개한다. */
const STARTER_CARD = "P122";

const HALF_LOG = JSON.parse(
  readFileSync(new URL("./fixtures/p388-half1.json", import.meta.url).pathname, "utf8"),
) as unknown;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const P = (id: string, name: string, position: string, grade: string, ov: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(ov), active: true,
});

/**
 * 보유 **13명**. ⓑ 의 조건은 "빈 칸은 있는데 넣을 후보가 없다"이므로 로스터 크기가 곧 전제다 —
 * 선발 11 + 벤치 2 를 전부 배치하면 벤치 3번 칸이 비어 [자동 채우기]는 **뜨고**(`hasEmptySlotGap`),
 * 후보가 0 이라 **비활성**(`canFillEmptySlots`)이다.
 */
const ROSTER = [
  P("GK1", "골리원", "GK", "GOLD", 70), P("DF1", "수비하나", "DF", "GOLD", 76),
  P("DF2", "수비둘", "DF", "SILVER", 68), P("DF3", "수비셋", "DF", "SILVER", 64),
  P("DF4", "수비넷", "DF", "BRONZE", 55), P("MF1", "미드하나", "MF", "DIA", 84),
  P("MF2", "미드둘", "MF", "GOLD", 74), P("MF3", "미드셋", "MF", "SILVER", 66),
  P("MF4", "미드넷", "MF", "SILVER", 61), P("FW1", "공격하나", "FW", "LEGEND", 90),
  P("FW2", "공격둘", "FW", "GOLD", 72), P("FW3", "공격셋", "FW", "SILVER", 69),
  P(STARTER_CARD, "스타터", "FW", "DIA", 80),
];

/** 선발 11 + 벤치 2 = 보유 13 전원 배치(빈 후보 0). */
const STARTERS = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1", "FW2"];
const BENCH = ["FW3", STARTER_CARD];

function fullDeck() {
  return {
    formation: "4-4-2",
    slots: [
      ...STARTERS.map((playerId, i) => ({
        playerId, role: "starter", slotIndex: i, promptText: "이미 적어 둔 한마디",
      })),
      ...BENCH.map((playerId, i) => ({
        playerId, role: "bench", slotIndex: i, promptText: null,
      })),
    ],
    teamPrompt: "우리 팀 문장",
  };
}

interface Harness {
  deck: { formation: string; slots: unknown[]; teamPrompt: string | null };
  /** `PUT /api/deck` 횟수 — "서버 저장 덱은 건드리지 않는다"의 증거. */
  deckWrites: number;
  /** `POST /api/matches` 바디. */
  creates: unknown[];
  /** 진행 중 매치(잠금) — ⓒ 전용. */
  activeLocked: boolean;
  /** 남은 무료 단축권. ⓐ 는 0. */
  freeRush: number;
  /** 지갑 무료재화 — ⓐ 는 단축비보다 적다. */
  points: number;
  /** 대기 중 3지선다(구 추론 경로의 입력). ⓓ 는 비운다. */
  pendingChoices: unknown[];
  /** `/api/config` 가 스타터 카드 id 를 공개하나. */
  declareStarterCard: boolean;
}

const SPEEDUP_COST = 5000;

function matchDetail(state: string) {
  return {
    id: MATCH_ID, state, mode: "practice", tutorial: true, auto: false,
    opponent: { name: "봇 FC", analysisText: "", deck: [] },
    createdAt: "2026-08-13T00:00:00Z",
    scoreH1Home: null, scoreH1Away: null, scoreHome: null, scoreAway: null, result: null,
  };
}

function idleSlot(slot: number) {
  return {
    slot, state: "IDLE", offerKind: null, target: null, demand: null, targetGrade: null,
    targetValue: null, acceptProbability: null, opensAt: null, remainingSec: 0,
    speedupCost: null, speedupCurrency: null,
  };
}

/** 1번 슬롯은 **접촉 중**(WAITING) — [단축]이 뜨는 유일한 상태이고, 그래서 ⓐ 의 무대다. */
function waitingSlot() {
  return {
    slot: 1, state: "WAITING", offerKind: "TRADE", target: null, demand: null,
    targetGrade: "DIA", targetValue: null, acceptProbability: null,
    opensAt: "2026-08-15T00:00:00Z", remainingSec: 48 * 3600,
    speedupCost: SPEEDUP_COST, speedupCurrency: "POINT",
  };
}

async function mockApi(page: Page, over: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = {
    deck: fullDeck(),
    deckWrites: 0,
    creates: [],
    activeLocked: false,
    freeRush: 1,
    points: 50_000,
    pendingChoices: [],
    declareStarterCard: false,
    ...over,
  };

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const req: Request = route.request();
    const p = new URL(req.url()).pathname;

    if (p === "/api/me") {
      return route.fulfill(json({
        user: { id: USER_ID, nickname: "온레일", tutorialDone: true },
        wallet: { points: h.points, gems: 0 },
        rating: 1000,
        coupons: { FREE_ENHANCE: 1, FREE_TRADE_RUSH: h.freeRush, FIRST_TRADE_EPIC: 1 },
        mail: { total: 0, unread: 0 },
      }));
    }
    if (p === "/api/players") return route.fulfill(json(ROSTER));
    if (p === "/api/presets") return route.fulfill(json([]));
    if (p === "/api/presets/team") {
      return route.fulfill(json([1, 2, 3].map((slot) => ({ slot, name: null, snapshot: null }))));
    }
    if (p === "/api/relations") return route.fulfill(json({ morale: 60, streak: 0, players: [] }));
    if (p === "/api/conditions/today") {
      return route.fulfill(json(Object.fromEntries(ROSTER.map((x, i) => [x.id, 0.3 + (i % 5) * 0.1]))));
    }
    if (p === "/api/growth/choices") return route.fulfill(json({ choices: h.pendingChoices }));
    if (p === "/api/me/active-match") {
      return route.fulfill(json(
        h.activeLocked
          ? { match: { id: MATCH_ID, state: "FIRST_HALF" }, locked: true, abandonable: false }
          : { match: null, locked: false, abandonable: false },
      ));
    }
    if (p === "/api/deck") {
      if (req.method() === "PUT") {
        h.deckWrites += 1;
        const b = req.postDataJSON();
        h.deck = { formation: b.formation, slots: b.slots, teamPrompt: b.teamPrompt ?? null };
      }
      return route.fulfill(json(h.deck));
    }
    if (p === "/api/trade" && req.method() === "GET") {
      return route.fulfill(json({
        wallet: { points: h.points, gems: 0 },
        slots: [waitingSlot(), idleSlot(2), idleSlot(3)],
      }));
    }
    if (p === "/api/matches" && req.method() === "POST") {
      h.creates.push(req.postDataJSON() ?? {});
      return route.fulfill(json(matchDetail("FIRST_HALF"), 201));
    }
    if (p === `/api/matches/${MATCH_ID}`) return route.fulfill(json(matchDetail("FIRST_HALF")));
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(p)) return route.fulfill(json(HALF_LOG));
    return route.fulfill(json({}));
  });

  await mockAppConfig(page, {});
  if (h.declareStarterCard) {
    // ⚠️ 캐치올·`mockAppConfig` **뒤에** 등록한다(나중에 등록한 핸들러가 이긴다).
    // ⚠️ `route.fetch()` 로 원본을 받아 오지 마라 — 그건 목을 우회해 **vite dev 프록시**로 나가고
    //    그 타깃은 데모 백엔드(`localhost:8080`)다. 데모가 떠 있던 세션에서는 초록이었다가
    //    없는 세션에서는 핸들러가 던져 `/api/config` 가 영영 안 오고 S5 가 그리드로 내려앉는다
    //    (실측: 데모를 내린 뒤 이 한 건만 red). 목 스펙은 **백엔드 없이** 성립해야 하므로
    //    같은 페이로드 소스(`appConfigPayload`)에 필드만 얹는다.
    await page.route(
      (url) => url.pathname === "/api/config",
      (route) =>
        route.fulfill(
          json({ ...appConfigPayload({}), tutorial: { starterCardId: STARTER_CARD } }),
        ),
    );
  }
  return h;
}

/**
 * 토큰(+ 필요하면 가이드 pending 래치).
 *
 * ⚠️ **래치는 홈에서 시작하는 경로에만 심는다.** 그 값은 제안 모달(`shouldOfferPracticeTutorial`)의
 * 발화 조건이면서 **화면별 첫 진입 가이드**(`GuideProvider`)의 조건이기도 하다 — 각본 중간에서
 * 재개하는 유저에게 심으면 도착한 화면마다 코치마크가 먼저 뜨고, 그건 `role="dialog"` 라
 * 온레일이 규칙대로 **비켜난다**(`shieldFor`). 그 상태를 이 스펙의 무대로 쓰면 검사 대상이
 * 스킵 규칙이 아니라 두 오버레이의 양보 규칙이 된다.
 */
async function seedUser(page: Page, opts: { guidePending?: boolean } = {}) {
  await skipSplash(page);
  await page.addInitScript(
    ({ uid, guidePending }) => {
      window.localStorage.setItem("hmb.auth.token", "tok_user");
      if (guidePending) window.localStorage.setItem(`hmb.guide.pending.${uid}`, "1");
    },
    { uid: USER_ID, guidePending: opts.guidePending === true },
  );
}

/** 각본 중간에서 재개한다 — 온레일 저장 단위가 스텝이라 이게 정상 경로다. */
async function seedRailAt(page: Page, stepId: string, matchId: string | null = null) {
  await page.addInitScript(
    ({ uid, stepId, matchId }) => {
      window.localStorage.setItem(
        `hmb.onrail.${uid}`,
        JSON.stringify({ status: "running", stepId, matchId }),
      );
    },
    { uid: USER_ID, stepId, matchId },
  );
}

interface SkipRecord { stepId: string; reason: string; to: string | null }
interface RailState { status?: string; stepId?: string | null; skips?: SkipRecord[] }

/** 진행 상태 = **저장된 것**(localStorage). 화면이 못 그리는 상태도 여기선 보인다. */
async function railState(page: Page): Promise<RailState> {
  return page.evaluate((uid) => {
    const raw = window.localStorage.getItem(`hmb.onrail.${uid}`);
    return raw ? (JSON.parse(raw) as RailState) : {};
  }, USER_ID);
}

async function skipLog(page: Page): Promise<SkipRecord[]> {
  return (await railState(page)).skips ?? [];
}

const step = (page: Page) => page.getByTestId("onrail-bubble");

// ── ⓐ 쿠폰도 잔액도 없는 유저의 [단축] ────────────────────────────────────

test("ⓐ 단축을 쓸 수 없는 유저는 그 스텝을 건너뛰고 완주에 닿는다", async ({ page }) => {
  await mockApi(page, { freeRush: 0, points: 100 });
  await seedUser(page);
  await seedRailAt(page, "trade-rush");

  await page.goto("/recruit?tab=trade");

  // 전제: 버튼은 **렌더된다**. 그래서 "대상이 없으면 기다린다"가 이 자리에서 함정이 된다.
  await expect(page.getByTestId("trade-slot-1-speedup")).toBeDisabled();

  // 그래도 레일은 앞으로 간다 — 완주 스텝까지.
  await expect(step(page)).toHaveAttribute("data-step-id", "finish", { timeout: 20_000 });

  /*
   * 두 칸을 **서로 다른 사유로** 넘었다. 그 구분이 곧 이 기능의 값이다 — [단축]은 이 유저에게
   * 영영 안 열려서(`target-disabled`), [수락]은 단축을 안 했으니 오퍼가 공개되지 않아서
   * (`target-missing`, 각본이 그렇게 고른 스텝) 넘어갔다.
   */
  const skips = await skipLog(page);
  expect(skips.map((s) => `${s.stepId}:${s.reason}`)).toEqual([
    "trade-rush:target-disabled",
    "trade-accept:target-missing",
  ]);
  expect(skips[0]!.to).toBe("trade-accept"); // 신 전체가 아니라 한 칸(다음 칸은 성립할 수 있다)
});

// ── ⓑ 보유를 다 배치한 유저의 [자동 채우기] ───────────────────────────────

test("ⓑ [자동 채우기]가 비활성이면 그 스텝만 건너뛰고 S2 는 계속된다", async ({ page }) => {
  await mockApi(page);
  await seedUser(page);
  await seedRailAt(page, "deck-auto");

  /*
   * ⚠️ **덱을 늦게 준다(1.2s)** — 이 지연이 계약의 절반이다. 온레일은 `/api/me` 만 오면 뜨므로
   * 그때 화면은 아직 "불러오는 중…" 이고 대상은 **없다**. "한 번이라도 눌릴 수 있었나" 래치를
   * 대상 유무와 무관하게 세우면 그 빈 프레임이 래치를 세워 **이 기능 전체가 조용히 무효가 된다**
   * (변이로 확인: `if (el)` 를 지우면 여기가 빨개진다). 빠른 목에서는 그 창이 안 열려서
   * 지연 없이는 검사되지 않는다.
   */
  await page.route(
    (url) => url.pathname === "/api/deck",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await new Promise((r) => setTimeout(r, 1200));
      return route.fallback();
    },
  );

  await page.goto("/deck");

  await expect(page.getByTestId("auto-fill")).toBeDisabled();
  // 신 전체가 아니라 **그 스텝만** 넘어간다 — 나머지 S2 는 이 유저도 할 수 있다.
  await expect(step(page)).toHaveAttribute("data-step-id", "deck-player", { timeout: 20_000 });

  const skips = await skipLog(page);
  expect(skips.map((s) => `${s.stepId}:${s.reason}`)).toContain("deck-auto:target-disabled");
});

test("ⓑ ⚠️ 잠깐 잠긴 대상은 건너뛰지 않는다 — [저장]은 저장 중에 스스로 잠긴다", async ({ page }) => {
  /*
   * 스킵의 반대편 위험: `disabled` 를 무조건 '못 한다'로 읽으면 **느린 서버에서 정상 스텝이
   * 날아간다**. [저장]은 저장 중 `busy` 로 잠기므로(`DeckPage.saveDisabled`) 유예보다 느린
   * 저장 한 번이 그 자리를 지나쳐 버린다. 그래서 판정은 "**도착한 뒤 줄곧** 거절했나"다.
   */
  const h = await mockApi(page);
  await seedUser(page, { guidePending: true });

  // 저장 응답을 유예(2.5s)보다 늦게 준다.
  await page.route(
    (url) => url.pathname === "/api/deck",
    async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await new Promise((r) => setTimeout(r, 4000));
      return route.fallback();
    },
  );

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("practice-tutorial-accept").click();
  await page.getByTestId("auto-fill").click();
  await page.getByTestId("token-GK1").click();
  const input = page.getByTestId("rail-prompt-input");
  await input.fill("오늘 너만 믿는다");
  await input.blur();
  await expect(step(page)).toHaveAttribute("data-step-id", "deck-save");

  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("save-deck")).toBeDisabled(); // 저장 중 = 잠김
  // 저장이 끝나면 **행동으로** 넘어간다 — 건너뛴 것이 아니다.
  await expect(step(page)).toHaveAttribute("data-step-id", "deck-done", { timeout: 20_000 });
  expect(await skipLog(page)).toEqual([]);
  expect(h.deckWrites).toBe(1);
});

// ── ⓒ 진행 중 매치가 잠근 화면 ────────────────────────────────────────────

test("ⓒ 잠긴 화면의 스텝은 신 단위로 건너뛴다(그 화면에 갈 방법이 없다)", async ({ page }) => {
  await mockApi(page, { activeLocked: true });
  await seedUser(page);
  await seedRailAt(page, "growth-open");

  await page.goto("/players");
  // MatchLockGate 가 되돌린다 — 즉 이 유저에게 `/players` 는 **없는 화면**이다.
  await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`), { timeout: 20_000 });

  await expect(step(page)).toHaveAttribute("data-step-id", "finish", { timeout: 20_000 });

  const skips = await skipLog(page);
  expect(skips.map((s) => `${s.stepId}:${s.reason}`)).toContain("growth-open:screen-locked");
  // 한 번의 판정으로 잠긴 화면의 **연속 스텝 전체**를 넘긴다(스텝마다 유예를 다시 기다리지 않는다).
  expect(skips.filter((s) => s.reason === "screen-locked")).toHaveLength(1);
});

// ── ⓓ S2 전제 — 레일 시작이 로컬 드래프트를 비운다 ────────────────────────

test("ⓓ 레일 시작 = 빈 보드에서 출발한다(서버 덱은 무접촉)", async ({ page }) => {
  const h = await mockApi(page);
  await seedUser(page, { guidePending: true }); // 제안 모달의 발화 조건

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("practice-tutorial-accept").click();
  await expect(page).toHaveURL(/\/deck$/);

  // 11명이 이미 저장된 덱인데도 AUTO 가 **살아 있다** — 이게 S2 각본의 전제다.
  await expect(page.getByTestId("auto-fill")).toBeEnabled();
  await expect(step(page)).toHaveAttribute("data-step-id", "deck-auto");
  // 보드는 비어 있다(드래프트만 비웠다 — 서버 덱은 그대로).
  await expect(page.getByTestId("token-GK1")).toHaveCount(0);
  expect(h.deckWrites).toBe(0);

  await page.getByTestId("auto-fill").click();
  await expect(step(page)).toHaveAttribute("data-step-id", "deck-player");
  await expect(page.getByTestId("token-GK1")).toHaveCount(1);
});

test("ⓓ 레일에 안 들어온 유저의 덱 화면은 그대로다(부작용 0)", async ({ page }) => {
  await mockApi(page);
  await seedUser(page);

  await page.goto("/deck");

  await expect(page.getByTestId("token-GK1")).toHaveCount(1);
  await expect(page.getByTestId("onrail-overlay")).toHaveCount(0);
});

// ── ⓔ S5 대상 — `/api/config` 의 스타터 카드 id ───────────────────────────

test("ⓔ 스타터 카드 id 를 서버가 알려 주면 추론 없이 그 카드를 겨눈다", async ({ page }) => {
  // 대기 중 3지선다가 **없다** — 구 추론(`usePendingChoices`)은 여기서 null 이라 그리드로 착지했다.
  await mockApi(page, { declareStarterCard: true, pendingChoices: [] });
  await seedUser(page);
  await seedRailAt(page, "growth-open");

  await page.goto("/players");
  await expect(step(page)).toHaveAttribute("data-step-id", "growth-open");

  const card = await page.getByTestId(`codex-card-${STARTER_CARD}`).boundingBox();
  const hole = await page.getByTestId("onrail-highlight").boundingBox();
  expect(card).not.toBeNull();
  expect(hole).not.toBeNull();
  // 구멍이 그 카드다(그리드로 착지하면 폭이 몇 배로 벌어진다).
  expect(Math.abs(hole!.width - card!.width)).toBeLessThan(20);
  expect(Math.abs(hole!.x - card!.x)).toBeLessThan(20);
});
