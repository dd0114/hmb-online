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
