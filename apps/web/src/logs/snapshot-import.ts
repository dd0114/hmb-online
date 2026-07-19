/**
 * "경기 후 과거 세팅 로그 → 프리셋으로 저장" 순수 로직 (이슈 #98 요구 2, W5).
 *
 * 서버는 매치 상세(GET /api/matches/{id})에 그 경기에 실제로 쓴 덱 스냅샷을 `userDeckSnapshot`
 * (openapi-v2 TeamSnapshot, additive)으로 돌려준다. 이 모듈은 그 스냅샷을 **기존 프리셋 저장
 * 파이프라인 그대로** 태우기 위한 얇은 어댑터다 — 직렬화는 `snapshotToEditor` →
 * `editorToSaveRequest`(덱 화면이 쓰는 canonical serializer)를 재사용하고, 저장 슬롯 선택은
 * `nextEmptySlot`(빈 슬롯 우선, 3슬롯 규약)을 재사용한다. 중복 구현 없음 = 저장 포맷 드리프트 없음.
 */
import type { TeamPresetSlot, TeamSnapshot, TeamSnapshotSaveRequest } from "../api/v2";
import { editorToSaveRequest, snapshotSaveable, snapshotToEditor } from "../deck/tactics-logic";
import { nextEmptySlot } from "../deck/preset-selector-logic";

/** 매치 스냅샷 → PUT /api/presets/team/{slot} 바디(덱 화면과 동일 직렬화). */
export function matchSnapshotToSaveRequest(snap: TeamSnapshot, name: string): TeamSnapshotSaveRequest {
  return editorToSaveRequest(snapshotToEditor(snap), name);
}

/**
 * 프리셋으로 가져올 수 있는 스냅샷인가 — 없거나(구 매치·미완) 선발 11이 아니면 불가.
 * (서버 PUT 도 선발 11을 요구하므로 화면에서 먼저 막고 안내한다.)
 */
export function canImportSnapshot(snap: TeamSnapshot | null | undefined): boolean {
  if (!snap) return false;
  return snapshotSaveable(snapshotToEditor(snap).draft);
}

/**
 * 기본 저장 대상 슬롯 — 빈 슬롯 우선. **전부 차 있으면 null**(기본 선택 없음).
 *
 * 전 슬롯 full 일 때 아무 슬롯이나 미리 선택해 두면 저장 1탭으로 기존 프리셋이 되돌릴 수 없이
 * 덮어써진다(모바일엔 hover 툴팁 경고가 보이지도 않는다). 파괴적 저장은 유저가 슬롯을 **명시적으로
 * 탭**해야만 가능하게 한다.
 */
export function defaultImportSlot(slots: TeamPresetSlot[]): number | null {
  return nextEmptySlot(slots);
}

/**
 * 기본 프리셋 이름 — "vs {상대} {MM.DD}". createdAt(ISO)에서 문자열로 잘라 쓴다(로케일/시계 비의존).
 * 이름은 유저가 저장 전에 수정할 수 있다.
 */
export function defaultImportName(opponentName: string, createdAt?: string): string {
  const day = createdAt && createdAt.length >= 10 ? createdAt.slice(5, 10).replace("-", ".") : "";
  const base = `vs ${opponentName}${day ? ` ${day}` : ""}`;
  return base.length > 16 ? base.slice(0, 16) : base;
}

/** 스냅샷 요약 표시용 — 선발 playerId 순서(슬롯 인덱스 오름차순). */
export function starterIdsInOrder(snap: TeamSnapshot): string[] {
  return [...(snap.starters ?? [])].sort((a, b) => a.slotIndex - b.slotIndex).map((s) => s.playerId);
}
