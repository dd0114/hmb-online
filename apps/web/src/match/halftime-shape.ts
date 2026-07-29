/**
 * 감독시간 라인업 — 보드 제스처를 서버의 두 필드로 분해하는 **순수 로직** (#276 W2 웹).
 *
 * hero 결정: *"덱구성이랑 비슷하게 사용할수있도록 유지해서 가져가. 중요한건 통일성이야."*
 * → 감독시간의 교체·배치는 덱과 **같은 보드·같은 제스처**(TacticsBoard · tap-place ·
 *   movePlayerToSlot)로 한다. 그런데 서버 `POST /halftime` 이 받는 것은 제스처가 아니라
 *   서로 독립인 두 필드다:
 *     · `substitutions[{out,in}]`   — 로스터 변경
 *     · `formation` + `starters[11]` — 배치(둘 다 또는 둘 다 아님, 한쪽만이면 400 SHAPE_PARTIAL)
 *   그 분해를 컴포넌트 안에 묻으면 검증할 수 없으므로 여기에 순수 함수로 둔다.
 *
 * 두 가지가 계약의 핵심이다:
 *
 * ① **교체 짝맞춤은 벤치 슬롯 기준**이다. `movePlayerToSlot` 은 swap 이라 벤치 선수를 선발 자리에
 *    놓으면 나간 선수가 **그 벤치 선수가 앉아 있던 슬롯**으로 내려간다. 그 성질을 역으로 읽으면
 *    (base 에서 그 벤치 슬롯의 주인이 in, 현재 그 슬롯의 주인이 out) 다중 교체에서도 짝이
 *    결정론적으로 난다 — 순서·집합만 보고 맞추면 2건 이상에서 교차 오배정이 난다.
 *
 * ② **보드 모드에서는 배치를 항상 싣는다. 지금 보드 상태가 진실이다.**
 *    처음엔 "배치가 실제로 바뀐 경우에만" 실었다(#215 콜0을 웹에서 지키려던 것). 그런데
 *    `substitutions` 는 **항상** 싣고 배치는 **조건부로** 싣는 이 **비대칭**이 두 방향으로 무너졌다 —
 *    서버 `COALESCE` 는 미첨부를 "손대지 않음"으로 읽으므로 `h2_shape_json` 에 **"배치를 원래대로
 *    되돌린다"를 표현할 값이 없었다**:
 *      ⓐ 재제출 400 고착 — 배치+교체를 낸 뒤 `POST /resume` 이 완료되지 않으면(네트워크 끊김·탭
 *         종료·리로드) 화면 재진입 시 보드가 스냅샷 원본에서 다시 시작하는데, 그때 배치를 빼면
 *         **살아남은 이전 배치**가 새 `substitutions:[]` 와 어긋나 400 `ROSTER_MISMATCH` 가 된다.
 *         몇 번을 눌러도 400이고 감독시간이 만료돼 전반 지시 그대로 후반이 시작된다.
 *      ⓑ 취소한 배치가 조용히 반영 — 배치를 바꿔 낸 뒤 원상복구하고 재제출해도 이전 배치가 남아
 *         후반이 그걸로 돈다(400 도 안 뜬다 — 유저는 취소했다고 믿는다).
 *    **#215 의 본질은 "안 보낸다"가 아니라 "AI 콜이 0이다"** 이고, 그 판정은 서버가 이미 한다:
 *    `MatchService.secondHalfShapeChanged` 가 전반과 같은 배치를 무변경으로 읽어 h1 인풋을
 *    재사용한다(계약 = `HalftimeShapeTest.resubmittingTheSameShapeIsNotAChange`). 그러니 웹이
 *    조건부로 뺄 이유가 없다 — 콜0은 유지되고 위 두 결함은 함께 사라진다.
 *    ⚠️ 폴백 모드(`boardUsable` false, 구 매치)만 종전대로 배치를 안 보낸다 — 보낼 보드가 없다.
 */
import type { SnapshotSlot, TeamSnapshot } from "../api/v2";
import {
  findPlayerSlot,
  getSlot,
  STARTER_COUNT,
  type DeckDraft,
  type DraftSlot,
} from "../deck/deck-logic";
import { movePlayerToSlot, snapshotToEditor } from "../deck/tactics-logic";
import { validateSubs, type SubIssue, type SubPair } from "./match-logic";

export interface HalftimeShapePayload {
  substitutions: SubPair[];
  /** 보드 모드면 **항상** 실린다(둘 다 또는 둘 다 아님) — 위 ②. 폴백 모드에서만 빠진다. */
  formation?: string;
  starters?: SnapshotSlot[];
}

/** 매치 스냅샷(전반에 실제로 쓴 라인업) → 덱 보드 draft. 덱과 같은 변환을 쓴다. */
export function snapshotToDraft(snap: TeamSnapshot): DeckDraft {
  return snapshotToEditor(snap).draft;
}

/**
 * 이 스냅샷으로 보드를 열 수 있는가.
 *
 * 서버는 스냅샷이 없거나 형상이 깨진 매치에 `userDeckSnapshot: null` 을 준다(openapi-v2
 * MatchDetailPhase2Fields). 그런 구 매치에서 보드를 열면 빈 피치가 뜨고 교체 수단이 통째로
 * 사라지므로 — 기능 소실 — 호출측은 기존 OUT/IN 셀렉트 폴백으로 간다.
 * 선발이 11명이 아닌 스냅샷도 같은 이유로 보드를 열지 않는다(방어).
 */
export function boardUsable(snap: TeamSnapshot | null | undefined): snap is TeamSnapshot {
  return Boolean(snap) && (snap!.starters?.length ?? 0) === STARTER_COUNT;
}

/** slotIndex → playerId (선발만). 배치 비교·직렬화의 기준 표현. */
export function starterSlotMap(draft: DeckDraft): Record<number, string> {
  const map: Record<number, string> = {};
  for (const s of draft.slots) if (s.role === "starter") map[s.slotIndex] = s.playerId;
  return map;
}

function starterCount(draft: DeckDraft): number {
  return draft.slots.filter((s) => s.role === "starter").length;
}

function idsOf(draft: DeckDraft, role: DraftSlot["role"]): string[] {
  return draft.slots
    .filter((s) => s.role === role)
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((s) => s.playerId);
}

/**
 * 스냅샷(base) 대비 현재 보드(current)의 교체 목록.
 *
 * out = base 선발이었는데 지금 선발이 아님 / in = base 벤치였는데 지금 선발.
 * 짝은 **벤치 슬롯**으로 맞춘다(위 ①). 벤치 슬롯으로 안 맞는 잔여(예: 들어온 선수를 다시
 * 다른 자리로 옮긴 뒤 또 다른 교체를 한 경우)는 등장 순서로 맞춰 결정론을 유지한다.
 */
export function diffSubstitutions(base: DeckDraft, current: DeckDraft): SubPair[] {
  const roleNow = new Map<string, DraftSlot>();
  for (const s of current.slots) roleNow.set(s.playerId, s);

  const outs: string[] = [];
  const ins: string[] = [];
  for (const s of [...base.slots].sort((a, b) => a.slotIndex - b.slotIndex)) {
    const now = roleNow.get(s.playerId);
    if (s.role === "starter" && now?.role !== "starter") outs.push(s.playerId);
    if (s.role === "bench" && now?.role === "starter") ins.push(s.playerId);
  }

  const pairs: SubPair[] = [];
  const usedOut = new Set<string>();
  const usedIn = new Set<string>();
  for (const inId of ins) {
    const benchSlot = findPlayerSlot(base, inId)!.slotIndex;
    const occupant = getSlot(current, "bench", benchSlot);
    if (occupant && outs.includes(occupant.playerId) && !usedOut.has(occupant.playerId)) {
      pairs.push({ out: occupant.playerId, in: inId });
      usedOut.add(occupant.playerId);
      usedIn.add(inId);
    }
  }
  const restOuts = outs.filter((id) => !usedOut.has(id));
  const restIns = ins.filter((id) => !usedIn.has(id));
  for (let i = 0; i < Math.min(restOuts.length, restIns.length); i++) {
    pairs.push({ out: restOuts[i]!, in: restIns[i]! });
  }
  return pairs;
}

/** 현재 보드의 선발 배치를 서버 형태로 직렬화(slotIndex 오름차순 = 결정론). */
function toStarters(draft: DeckDraft): SnapshotSlot[] {
  return draft.slots
    .filter((s) => s.role === "starter")
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((s) => ({ playerId: s.playerId, slotIndex: s.slotIndex }));
}

/**
 * 스냅샷 대비 현재 보드 → `/halftime` 바디의 세 필드 중 라인업 두 축.
 *
 * `starters` 는 **교체 반영 후의 실효 선발**이다 — 보드가 이미 그 상태이므로 그대로 실으면 된다
 * (나간 선수는 벤치로 내려가 있어 배열에 없다). 서버는 이 slotIndex 를 그 자리의 실효 선수
 * 기준으로 되쓴다 → "교체로 들어온 선수를 내가 지정한 슬롯에 세운다"가 성립한다.
 *
 * **배치는 조건 없이 싣는다**(위 ②) — 안 건드렸으면 전반과 같은 값이 실리고, 서버가 그걸
 * 무변경으로 판정해 AI 콜은 0이다. `base` 는 이제 교체 diff 의 기준일 뿐 "실을지 말지"를 정하지
 * 않는다.
 *
 * 선발이 11명이 아니면(빈 벤치칸으로 선수를 끌어낸 경우) 배치를 만들지 않는다 — 서버가 400
 * (STARTER_COUNT)을 낼 바디를 애초에 조립하지 않는다. 그 상태는 `lineupIssues` 가 이슈로
 * 잡아 [후반 시작]을 잠그므로 제출까지 가지도 않는다.
 */
export function halftimeShapePayload(base: DeckDraft, current: DeckDraft): HalftimeShapePayload {
  const payload: HalftimeShapePayload = { substitutions: diffSubstitutions(base, current) };
  if (starterCount(current) === STARTER_COUNT) {
    payload.formation = current.formation;
    payload.starters = toStarters(current);
  }
  return payload;
}

/**
 * 확정된 교체 한 건을 취소 — **base(스냅샷)로의 복귀**다: `in` 은 base 벤치 슬롯으로, `out` 은
 * base 선발 슬롯으로 되돌린다.
 *
 * ⚠️ 예전 구현은 "`in` 이 **지금 서 있는** 선발 슬롯에 `out` 을 놓는다"였고, 주석엔 "투입 후 옮겼어도
 * 교체만 정확히 풀린다"고 적혀 있었지만 **사실이 아니었다**. 투입 선수를 다른 자리로 옮긴 뒤
 * 취소하면 선발 두 명의 자리가 유저 의도 없이 맞바뀐 채 남는다:
 * ```
 * base {9:"F1", 10:"F2"} → B1 을 10번에(교체) → B1 을 9번으로 이동 → [취소]
 *   옛 결과 {9:"F2", 10:"F1"}   ← 뒤바뀜 → shapeChanged 가 true 가 되어
 *   "유저가 취소했는데 배치가 바뀐 것"으로 잡힌다
 * ```
 * base 좌표로 되돌리면 그 자리가 사라진다. 나머지 선수는 `movePlayerToSlot` 의 swap 이 맞춰주므로
 * 다른 교체·유저가 의도한 자리 이동은 그대로 남는다.
 */
export function revertSub(base: DeckDraft, current: DeckDraft, pair: SubPair): DeckDraft {
  const inNow = findPlayerSlot(current, pair.in);
  const outBase = findPlayerSlot(base, pair.out);
  if (!inNow || inNow.role !== "starter" || !outBase || outBase.role !== "starter") return current;
  // ① 나간 선수를 base 선발 슬롯으로
  let draft = movePlayerToSlot(current, pair.out, "starter", outBase.slotIndex);
  // ② 투입 선수를 base 벤치 슬롯으로 (①의 swap 이 이미 거기에 앉혔으면 no-op)
  const inBase = findPlayerSlot(base, pair.in);
  if (inBase && inBase.role === "bench") {
    draft = movePlayerToSlot(draft, pair.in, "bench", inBase.slotIndex);
  }
  return draft;
}

/**
 * 라인업 검증 — 교체 규칙(≤3 · out∈선발 · in∈벤치 · 교체 후 GK≥1)은 **기존 validateSubs 를
 * 그대로** 쓴다(중복 구현 금지: 두 화면이 같은 조작을 다른 규칙으로 걸면 통일성이 아니다).
 * 여기서 더하는 것은 보드에서만 가능한 상태 하나뿐 — 빈 벤치칸으로 선수를 끌어내 선발이
 * 11명이 아니게 된 경우.
 */
export function lineupIssues(
  base: DeckDraft,
  current: DeckDraft,
  positionOf: (playerId: string) => string | undefined,
): SubIssue[] {
  const issues: SubIssue[] = [];
  const count = starterCount(current);
  if (count !== STARTER_COUNT) {
    issues.push({
      rule: "STARTER_COUNT",
      message: `선발이 ${STARTER_COUNT}명이 아닙니다 (현재 ${count}명)`,
    });
  }
  issues.push(
    ...validateSubs(diffSubstitutions(base, current), idsOf(base, "starter"), idsOf(base, "bench"), positionOf),
  );
  return issues;
}
