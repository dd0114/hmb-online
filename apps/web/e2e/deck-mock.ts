/**
 * 덱셋팅(`/deck`) 목 부트스트랩 — #455.
 *
 * `p455-a1-deck-fullscreen.spec.ts` 안에 있던 픽스처를 **두 스펙이 같이 쓰려고** 뺐다.
 * 폰 계약(390×844 고정)과 **폭 밴드 계약**(여러 폭을 훑는다)은 `test.use({viewport})` 가
 * 달라 한 파일에 못 있는다 — 그런데 같은 화면·같은 목이어야 비교가 성립한다.
 * ⚠️ 스펙 파일에서 import 하지 마라(그 파일의 `test()` 가 같이 등록돼 중복 실행된다).
 */
import { expect, type Page } from "@playwright/test";

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const P = (id: string, name: string, position: string, grade: string, ov: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(ov), personality: "CALM",
});

export const PLAYERS = [
  P("GK1", "골리원", "GK", "GOLD", 70), P("GK2", "골리투", "GK", "SILVER", 62),
  P("DF1", "수비하나", "DF", "GOLD", 76), P("DF2", "수비둘", "DF", "SILVER", 68),
  P("DF3", "수비셋", "DF", "SILVER", 64), P("DF4", "수비넷", "DF", "BRONZE", 55),
  P("MF1", "미드하나", "MF", "DIA", 84), P("MF2", "미드둘", "MF", "GOLD", 74),
  P("MF3", "미드셋", "MF", "SILVER", 66), P("MF4", "미드넷", "MF", "SILVER", 61),
  P("FW1", "공격하나", "FW", "LEGEND", 90), P("FW2", "공격둘", "FW", "GOLD", 72),
  P("FW3", "공격셋", "FW", "SILVER", 69), P("FW4", "공격넷", "FW", "GOLD", 80),
];

/** 선발 11 — **제품이 저장할 수 있는 상태**(`validateDraft` STARTER_COUNT=11). */
export const ELEVEN = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1", "FW2"];
export const BENCH = ["FW3", "GK2"];

export function deckSlots() {
  return [
    ...ELEVEN.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
    ...BENCH.map((playerId, i) => ({ playerId, role: "bench", slotIndex: i, promptText: null })),
  ];
}

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

export async function bootstrap(page: Page, slots: unknown[], teamPrompt: string | null = null) {
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
  /**
   * `GET /api/growth/card/{id}` — **강화 시트가 열리려면 있어야 한다** (#455 A2 ⑥).
   *
   * ⚠️ 이 목이 없던 동안 덱 화면의 강화 진입점은 **구조적으로 도달 불가능**이었다: 캐치올이 `{}`
   * 를 주면 `CardGrowthDetail` 이 `card.potential.unlocked` 에서 던지고 컴포넌트가 통째로
   * 언마운트된다(실측 `pageerror: Cannot read properties of undefined (reading 'unlocked')`).
   * 레일의 [선수 강화]도 **같은 증상**이라 A2 가 만든 문제가 아니고, 그래서 이 목이 없으면
   * 그 동선은 어느 덱 스펙에서도 검증할 수 없었다. **목은 계약의 일부다**(#342 의 교훈) —
   * 모양은 서버 실물(`growth-mock.spec.ts` 픽스처)을 따른다.
   */
  await page.route(
    (url) => url.pathname.startsWith("/api/growth/card/"),
    (r) => {
      const id = new URL(r.request().url()).pathname.split("/").pop()!;
      const p = PLAYERS.find((x) => x.id === id) ?? PLAYERS[0]!;
      const a = p.attributes as unknown as Record<string, number>;
      const keys = Object.keys(a);
      return r.fulfill(
        json({
          playerId: p.id,
          grade: p.grade,
          star: 1,
          attributes: a,
          prePotential: a,
          base: a,
          caps: Object.fromEntries(keys.map((k) => [k, 73])),
          statAdd: {},
          cardLevel: 1,
          cardXp: 0,
          xpToNext: 200,
          maxLevel: 40,
          growCeil: 72,
          starCeilBonus: 1,
          attrHardCap: 99,
          startLo: 50,
          pendingChoices: [],
          statLevels: Object.fromEntries(keys.map((k) => [k, { lv: 0, xp: 0 }])),
          potential: { unlocked: false, tier: "RARE", maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 9 },
          ovr: 60,
          completion: 0.3,
        }),
      );
    },
  );
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
}

export async function openDeck(page: Page, teamPrompt: string | null = null) {
  await bootstrap(page, deckSlots(), teamPrompt);
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await expect(page.getByTestId("token-FW1")).toBeVisible();
}

/**
 * **유저가 할 수 있는 스크롤만 써서** 그 요소에 닿는지 본다 — #455 A1 2R blocker-A/B 의 처방.
 *
 * ⚠️ `scrollIntoView`·`scrollIntoViewIfNeeded`·`toBeVisible()` 을 도달 판정에 쓰지 마라:
 * - 앞의 둘은 **프로그램적 스크롤**이라 `overflow: hidden` 컨테이너도 그냥 굴린다. 덱셋팅의
 *   전체화면 셸(`.app-container--fill`)이 정확히 그것이라, BL-2(문서 스크롤 0 이라 프롬프트가
 *   창 밖 y915 에 갇힘)를 되살리는 변이(M-H)를 먹여도 계약이 **11/11 통과**했다.
 * - `toBeVisible()` 은 뷰포트 **밖**도 통과한다. 팀 사기를 `left:-9999px` 로 숨기는 변이(M-G)가
 *   45/45 통과했다(그 상태가 "아무 데나 숨겨 둔 것"의 정의다).
 *
 * 그래서 **휠 이벤트**를 굴리고 매번 `elementFromPoint` 로 잰다. 마우스 위치가 *어느 스크롤러가
 * 휠을 받는지* 정하므로 기본 지점은 **화면 아래쪽 80%** 다 — 탭 레이아웃에서는 그 자리가
 * 탭 패널(=이 화면의 스크롤러)이고, stack 에서는 문서다. 다른 스크롤러를 굴려야 하면 `over` 로
 * 그 요소를 찍어라.
 */
export async function wheelUntilHit(
  page: Page,
  testId: string,
  opts: { over?: string; maxWheels?: number; step?: number } = {},
) {
  const { over, maxWheels = 16, step = 240 } = opts;
  const vp = page.viewportSize()!;

  /**
   * 휠을 굴릴 지점. `over` 를 주면 **존재를 먼저 단언**한다 — 그 셀렉터가 스테일해지면
   * `boundingBox()` 가 조용히 **행**해서 180s 테스트 타임아웃이 된다(3R n-3 실측: 8초에도
   * 미반환, `actionTimeout` 미설정). 거짓 통과는 아니지만 진단이 나쁘다: "계약이 깨졌다"가
   * "테스트가 멈췄다"로 보인다. 한 번만 재고 루프 안에서 다시 묻지 않는다(구판은 17회 왕복).
   */
  let px = vp.width / 2;
  let py = vp.height * 0.8;
  if (over) {
    await expect(page.locator(over), `휠을 굴릴 스크롤러 \`${over}\` 가 없다`).toHaveCount(1);
    const b = await page.locator(over).boundingBox();
    if (b) {
      px = b.x + b.width / 2;
      py = b.y + b.height / 2;
    }
  }

  for (let i = 0; i <= maxWheels; i++) {
    const box = await page.getByTestId(testId).first().boundingBox();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const inside = cx > 0 && cy > 0 && cx < vp.width && cy < vp.height;
      if (inside && (await hitAt(page, cx, cy, testId))) {
        return { hit: true, wheels: i, h: Math.round(box.height), y: Math.round(box.y) };
      }
    }
    await page.mouse.move(
      Math.min(Math.max(px, 1), vp.width - 1),
      Math.min(Math.max(py, 1), vp.height - 1),
    );
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(60);
  }
  const last = await page.getByTestId(testId).first().boundingBox();
  return { hit: false, wheels: maxWheels, h: Math.round(last?.height ?? 0), y: Math.round(last?.y ?? -1) };
}

/** 이 지점이 **실제로 화면에 있나** — `toBeVisible()` 은 뷰포트 밖을 통과한다. */
export async function hitAt(page: Page, x: number, y: number, testId: string) {
  return page.evaluate(
    ({ x, y, testId }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      return !!el.closest(`[data-testid="${testId}"]`);
    },
    { x, y, testId },
  );
}
