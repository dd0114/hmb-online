import type { SlotRef } from "./TacticsBoard";

/**
 * 보드 선택 상태.
 *
 * ⚠️ #244: 여기 있던 **2단계 탭-투-플레이스**(`tapSlot` / `tapPoolPlayer` / `autoFilterFor`)는
 * 은퇴했다. "슬롯을 고르고 → 리스트에서 고르기"를 **보유 선수 시트**가 통째로 흡수했다 —
 * 빈 슬롯 탭 = 그 자리에 넣을 선수 고르기이고, 포지션 자동 필터는 시트를 여는 쪽이 건다
 * (`DeckEditor.sheetFilter` ← `sheet-metrics.slotPosition`). 배치는 시트에서 한 번 고르면 끝나므로
 * "집어든 채 다음 탭을 기다리는" 중간 상태(`source: "pool"`)도 더는 생기지 않는다.
 *
 * 남은 것은 **선택 상태 타입**뿐이다(레일이 누구를 보여줄지). 되살리려면 계약만이 아니라
 * 그 UI(리스트가 본문에 상주하는 배치)부터 되살려야 한다.
 */
export interface TapSelection {
  /** 배치 대기 중인 타깃 슬롯 — 시트 모델에서는 항상 null 이다(호환을 위해 유지). */
  slot: SlotRef | null;
  /** 지금 지시(프롬프트)를 편집 중인 선수. */
  playerId: string | null;
  source: "board" | "pool" | null;
}

export const NO_SELECTION: TapSelection = { slot: null, playerId: null, source: null };
