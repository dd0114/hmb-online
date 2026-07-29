/**
 * 감독시간 배치(포메이션 + 선발 슬롯) — 보드 상태를 서버 필드로 옮기는 **순수 로직** (#276 W2 웹).
 *
 * hero 결정: *"덱구성이랑 비슷하게 사용할수있도록 유지해서 가져가. 중요한건 통일성이야."*
 * → 감독시간도 덱과 같은 `DeckEditor`(#244)를 쓰고, 이번 웨이브는 그 위에서 **포메이션 변경 +
 *   선발끼리 자리 바꾸기**를 연다. 서버 `POST /halftime` 이 받는 것은 제스처가 아니라 서로 독립인
 *   세 필드이므로(substitutions · teamTactics · formation+starters), 그 변환을 컴포넌트에 묻지 않고
 *   여기에 순수 함수로 둔다.
 *
 * ── ① 시작점은 **매치 스냅샷**이다 (취향이 아니라 서버 계약) ─────────────────────────────
 * `useDeck()`(**현재 덱**)이 아니라 `match.userDeckSnapshot`(그 경기에 실제로 쓴 라인업)이 기준이다.
 * 서버는 `starters` 를 **매치 스냅샷의 전반 선발 − out + in** 과 대조하므로(`MatchService`
 * ROSTER_MISMATCH), 전반 시작 후 유저가 덱을 고쳤으면 둘이 달라 **400** 이 난다.
 * 스냅샷이 없거나 선발이 11명이 아닌 구 매치는 `boardUsable` 이 false → 배치 필드를 **아예 보내지
 * 않고** #244 의 현행 동작(덱 파생 + 교체만)을 그대로 유지한다(기능 소실 금지).
 *
 * ── ② 교체는 #244 의 `subs` 가 SoT, 배치는 슬롯 치환 ───────────────────────────────────
 * #244 의 교체 UI 는 선수를 **옮기지 않는다** — out 선수는 자기 슬롯에 OUT 뱃지를 달고 그대로 서 있고
 * 확정 교체는 명시 `subs` 목록으로 남는다. 그래서 실효 선발은 보드 슬롯을 그대로 두고 **out 선수를
 * 그 자리에서 in 선수로 치환**해 만든다. 남길 불변식은 하나다:
 *
 *     **보낼 `starters` 의 선수 집합 == 전반 선발 − outs + ins**
 *
 * 서버가 정확히 이 식으로 검사하므로(ROSTER_MISMATCH) 어긋나면 400 이고 감독시간이 통째로 날아간다.
 *
 * ── ③ 보드 모드에서는 배치를 **항상** 싣는다 (1R blocker 2건의 뿌리) ─────────────────────
 * 처음엔 "배치가 실제로 바뀐 경우에만" 실었다(#215 콜0을 웹에서 지키려던 것). `substitutions` 는
 * **항상** 싣는데 배치만 **조건부**인 그 **비대칭**이 두 방향으로 무너졌다 — 서버 `COALESCE` 는
 * 미첨부를 "손대지 않음"으로 읽으므로 `h2_shape_json` 에 **"배치를 원래대로 되돌린다"를 표현할 값이
 * 없었다**:
 *   ⓐ 재제출 400 고착 — 배치를 낸 뒤 `POST /resume` 이 완료되지 않으면(네트워크 끊김·탭 종료·리로드)
 *      화면 재진입 시 보드가 스냅샷 원본에서 다시 시작하는데, 그때 배치를 빼면 **살아남은 이전 배치**가
 *      새 `substitutions:[]` 와 어긋나 400 `ROSTER_MISMATCH` 로 고착된다(감독시간 통째 상실).
 *   ⓑ 취소한 배치가 조용히 반영 — 배치를 바꿔 낸 뒤 원상복구해도 이전 배치가 남아 후반이 그걸로 돈다.
 *
 * 📌 **`#215` 콜0 의 본질은 "필드를 안 보낸다"가 아니라 "AI 콜이 0이다"** 이고, 그 판정은 **서버**
 * (`MatchService.secondHalfShapeChanged`)가 한다 — 전반과 같은 배치를 그대로 보내도 콜0이다
 * (서버 계약 `HalftimeShapeTest.resubmittingTheSameShapeIsNotAChange`). 웹에서 조건부 전송으로
 * 아끼려 들면 위 두 blocker 가 그대로 돌아온다.
 */
import type { SnapshotSlot, TeamSnapshot } from "../api/v2";
import { findPlayerSlot, STARTER_COUNT, type DeckDraft, type DraftSlot } from "../deck/deck-logic";
import { movePlayerToSlot, snapshotToEditor } from "../deck/tactics-logic";
import type { SubPair } from "./match-logic";

export interface HalftimeShapePayload {
  substitutions: SubPair[];
  /** 보드 모드면 **항상** 실린다(둘 다 또는 둘 다 아님) — 위 ③. 폴백 모드에서만 빠진다. */
  formation?: string;
  starters?: SnapshotSlot[];
}

/**
 * 매치 스냅샷(전반에 실제로 쓴 라인업) → 덱 보드 draft. 덱과 같은 변환(`snapshotToEditor`)을 쓴다.
 *
 * ⚠️ `promptText` 는 **떼고** 옮긴다. 스냅샷의 문장은 **전반에 쓴 지시**라 그대로 실으면 화면이
 * 전반 문장을 채운 채 열리고 제출 시 그게 전부 **후반 지시로 다시** 나간다(#244: 후반 지시는 빈
 * 칸에서 시작한다).
 */
export function snapshotToDraft(snap: TeamSnapshot): DeckDraft {
  const draft = snapshotToEditor(snap).draft;
  return { ...draft, slots: draft.slots.map((s) => ({ ...s, promptText: null })) };
}

/**
 * 이 스냅샷으로 배치를 보낼 수 있는가.
 *
 * 서버는 스냅샷이 없거나 형상이 깨진 매치에 `userDeckSnapshot: null` 을 준다(openapi-v2
 * MatchDetailPhase2Fields · `MatchService.userDeckSnapshotOf`). 그런 구 매치에서 배치를 보내면
 * 서버가 대조할 전반 선발이 없어 400 이므로, 호출측은 **배치 없이** #244 의 현행 동작(덱 파생 +
 * 교체만)으로 간다. 선발이 11명이 아닌 스냅샷도 같은 이유로 배치를 열지 않는다(방어).
 *
 * ⚠️ **인원수만 세면 안 된다**(2R 독립검증 minor-5). 서버는 `starters` 의 슬롯도 검사한다 —
 * `SLOT_INDEX_DUPLICATE` · `SLOT_INDEX_RANGE`. 11명이지만 슬롯이 중복되거나 0..10 밖인 레거시
 * 스냅샷을 열면 보드가 그대로 그 값을 되돌려 보내 **[후반 시작]이 영구 400** 이 되고, 화면에는
 * 되돌릴 손잡이가 없어 감독시간이 통째로 날아간다. 그래서 슬롯 집합까지 확인하고, 어긋나면
 * 폴백(교체만)으로 보낸다 — 배치를 잃는 대신 화면은 계속 동작한다.
 */
export function boardUsable(snap: TeamSnapshot | null | undefined): snap is TeamSnapshot {
  const starters = snap?.starters;
  if (!starters || starters.length !== STARTER_COUNT) return false;
  const seen = new Set<number>();
  for (const s of starters) {
    const i = s.slotIndex;
    if (!Number.isInteger(i) || i < 0 || i >= STARTER_COUNT) return false;
    if (seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

function starterSlots(draft: DeckDraft): DraftSlot[] {
  return draft.slots.filter((s) => s.role === "starter").sort((a, b) => a.slotIndex - b.slotIndex);
}

/**
 * 선발 두 명의 자리를 맞바꾼다 — 덱과 **같은 의미**(`movePlayerToSlot` 의 swap)로.
 *
 * 둘 중 하나라도 선발이 아니면 **아무 일도 하지 않는다**(입력 draft 를 그대로 반환). 벤치 선수를
 * 이 경로로 올리면 그건 교체인데, 교체는 #244 의 `subs` 가 소유한다 — 같은 일을 하는 손잡이가
 * 두 개면 규칙이 갈라지고(≤3 · GK≥1 검증을 우회한다) 서버 집합 불변식도 깨진다.
 */
export function swapStarters(draft: DeckDraft, aId: string, bId: string): DeckDraft {
  if (aId === bId) return draft;
  const a = findPlayerSlot(draft, aId);
  const b = findPlayerSlot(draft, bId);
  if (a?.role !== "starter" || b?.role !== "starter") return draft;
  return movePlayerToSlot(draft, aId, "starter", b.slotIndex);
}

/**
 * 보드 + 확정 교체 → **교체 반영 후의 실효 선발** 11명(slotIndex 오름차순 = 결정론 직렬화).
 *
 * out 선수가 서 있는 슬롯을 in 선수가 물려받는다 → "교체로 들어온 선수를 내가 지정한 슬롯에
 * 세운다"가 성립한다(자리를 먼저 바꾼 뒤 교체해도 **지금 서 있는** 자리를 물려받는다).
 *
 * 집합 불변식(전반 선발 − outs + ins)을 만들 수 없으면 **null** — 서버가 400 을 낼 바디를 애초에
 * 조립하지 않는다. 그런 상태(선발 ≠ 11 · 선발 아닌 선수를 빼는 교체 · 중복)는 화면이 이미 이슈로
 * 잡아 [후반 시작]을 잠그므로 정상 경로에서는 도달하지 않는다.
 */
export function effectiveStarters(draft: DeckDraft, subs: SubPair[]): SnapshotSlot[] | null {
  const slots = starterSlots(draft);
  if (slots.length !== STARTER_COUNT) return null;

  const inFor = new Map(subs.map((s) => [s.out, s.in]));
  const replaced = new Set<string>();
  const out: SnapshotSlot[] = slots.map((s) => {
    const swapped = inFor.get(s.playerId);
    if (swapped != null) replaced.add(s.playerId);
    return { playerId: swapped ?? s.playerId, slotIndex: s.slotIndex };
  });

  // 빼기로 한 선수가 선발에 없었다 = 집합이 서버 기대(h1 선발 − out + in)와 어긋난다.
  if (subs.some((s) => !replaced.has(s.out))) return null;
  // 넣기로 한 선수가 이미 선발이었다 = 중복(서버 DUPLICATE_PLAYER).
  if (new Set(out.map((s) => s.playerId)).size !== out.length) return null;
  return out;
}

/**
 * `/halftime` 바디의 라인업 두 축(교체 + 배치). 전술(#254)은 호출부가 합친다.
 *
 * `boardMode` = `boardUsable(match.userDeckSnapshot)`. **true 면 배치를 조건 없이 싣는다**(위 ③) —
 * 안 건드렸으면 전반과 같은 값이 실리고 서버가 그걸 무변경으로 판정해 **AI 콜은 0**이다.
 * false(구 매치)면 배치를 빼고 #244 의 현행 동작(교체만)을 유지한다.
 */
export function halftimeShapePayload(
  draft: DeckDraft,
  subs: SubPair[],
  boardMode: boolean,
): HalftimeShapePayload {
  const payload: HalftimeShapePayload = { substitutions: subs };
  if (!boardMode) return payload;
  const starters = effectiveStarters(draft, subs);
  if (!starters) return payload; // 형상이 깨졌으면 반쪽(400 SHAPE_PARTIAL)을 만들지 않는다
  payload.formation = draft.formation;
  payload.starters = starters;
  return payload;
}
