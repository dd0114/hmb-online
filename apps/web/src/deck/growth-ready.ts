import type { PendingChoice } from "../api/growth";

/**
 * **선택 대기(3지선다)가 남아 있는 선수 id 집합** — 덱 화면의 `↑` 뱃지 판정 (#455 A2-2).
 *
 * ── 왜 이 함수가 따로 있나 ────────────────────────────────────────────────────
 * 신호의 출처는 `usePendingChoices()`(= `GET /api/growth/choices`, **전체 목록 1회**)다.
 * 화면은 "몇 개 남았나"가 아니라 **"남아 있나"** 만 쓰므로, 배열 → 집합 변환을 한 곳에 두고
 * 그 경계 규칙(중복·미도착·더러운 항목)을 계약으로 박는다.
 *
 * ⚠️ **`undefined` 는 "없다"가 아니라 "아직 모른다"다.** `usePendingChoices` 는 `retry:false`
 * 라 구 서버·조회 실패에서 그대로 `undefined` 로 남는다. 여기서는 **fail-closed**(안 그린다) —
 * 반대로 눕히면 "모른다"가 "전원 강화 가능"으로 새 나가고, 그건 화면이 없는 사실을 말하는 것이다.
 * (같은 부류의 사고 = `deckMissing(undefined)` 를 '덱 없음'으로 읽던 것, apps/web/CLAUDE.md.)
 *
 * ⚠️ **`CardEffective.pendingChoices` 나 보상 봉투의 `pendingChoices` 를 여기 먹이지 마라.**
 * 봉투 쪽은 **정산 시점 스냅샷**이라 유저가 고른 뒤에도 남는다(`api/growth-hooks.ts:92`) —
 * 그걸로 뱃지를 그리면 이미 고른 선택이 덱 화면에 **영원히** 붙는다.
 */
export function growthReadyIdsOf(choices: PendingChoice[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(choices)) return out;
  for (const c of choices) {
    // 한 선수에 여러 레벨이 밀려 있어도 Set 이라 한 명이다(뱃지는 개수가 아니라 유무).
    if (c && typeof c.playerId === "string" && c.playerId !== "") out.add(c.playerId);
  }
  return out;
}
