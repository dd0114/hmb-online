/**
 * 팀 시트 바 지표 (이슈 #106 R1) — 순수/결정론 함수.
 *
 * 재설계된 덱 화면은 "팀 시트 하나"다. 시트 바(sticky)는 상태를 **세 지표**로만 요약한다:
 *   선발 n/11 · 벤치 n/7 · 지시 n/11
 * "지시"는 **선발 중 프롬프트(감독 지시)가 실제로 얹힌 선수 수** — 우리 차별점(자연어 주문)이
 * 얼마나 채워졌는지를 기존 축구 전술 포맷의 카운터와 같은 언어로 보여준다(#106 "기존 전략
 * 포맷 위에 프롬프트가 extend").
 *
 * 분모 11 = STARTER_COUNT (벤치 프롬프트는 세지 않는다 — 경기에 나가는 11명 기준).
 */
import {
  BENCH_MAX,
  DEFAULT_FORMATION,
  FORMATION_LAYOUTS,
  STARTER_COUNT,
  type DeckDraft,
  type Position,
  type SlotRole,
} from "./deck-logic";

export interface SheetMetrics {
  starters: number;
  starterMax: number;
  bench: number;
  benchMax: number;
  /** 선발 중 프롬프트가 비어있지 않은 선수 수 */
  directives: number;
  directiveMax: number;
}

function hasDirective(promptText: string | null | undefined): boolean {
  return typeof promptText === "string" && promptText.trim().length > 0;
}

export function sheetMetrics(draft: DeckDraft): SheetMetrics {
  const starters = draft.slots.filter((s) => s.role === "starter");
  const bench = draft.slots.filter((s) => s.role === "bench");
  return {
    starters: starters.length,
    starterMax: STARTER_COUNT,
    bench: bench.length,
    benchMax: BENCH_MAX,
    directives: starters.filter((s) => hasDirective(s.promptText)).length,
    directiveMax: STARTER_COUNT,
  };
}

/**
 * 슬롯이 요구하는 포지션. 선발 = 포메이션 행 라벨(FORMATION_LAYOUTS SoT), 벤치 = 제한 없음(null).
 * 탭-투-플레이스에서 "슬롯 탭 → 리스트가 그 포지션 추천순으로 자동 필터"의 근거가 된다.
 */
export function slotPosition(formation: string, role: SlotRole, slotIndex: number): Position | null {
  if (role !== "starter") return null;
  const layout = FORMATION_LAYOUTS[formation] ?? FORMATION_LAYOUTS[DEFAULT_FORMATION]!;
  for (const row of layout) {
    if (row.slotIndexes.includes(slotIndex)) return row.label;
  }
  return null;
}
