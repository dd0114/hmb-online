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
 * ② **배치 변경 판정의 기준선은 "교체만 적용한 스냅샷"**이다. 교체로 들어온 선수가 나간 선수의
 *    슬롯을 그대로 물려받았을 뿐이면 배치는 **안 바뀐 것**이다. 원본 스냅샷과 비교하면 교체할
 *    때마다 배치도 "바뀐 것"이 되어 서버가 유저 사이드 AI 풀 생성(콜 1회)을 하게 된다 —
 *    #215 콜0 계약이 조용히 새는 자리다. 안 건드렸으면 두 필드를 **아예 안 보낸다**.
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
  /** 배치가 실제로 바뀐 경우에만 실린다(둘 다 또는 둘 다 아님). */
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

/** 배치 비교의 기준선 — base 에 교체만 적용한 상태(위 ②). */
export function applySubs(base: DeckDraft, subs: SubPair[]): DeckDraft {
  let draft = base;
  for (const pair of subs) {
    const outSlot = findPlayerSlot(draft, pair.out);
    if (!outSlot || outSlot.role !== "starter") continue;
    draft = movePlayerToSlot(draft, pair.in, "starter", outSlot.slotIndex);
  }
  return draft;
}

/** 포메이션 문자열 또는 선발 슬롯 배치가 다른가. */
export function shapeChanged(a: DeckDraft, b: DeckDraft): boolean {
  if (a.formation !== b.formation) return true;
  const ma = starterSlotMap(a);
  const mb = starterSlotMap(b);
  const keys = new Set([...Object.keys(ma), ...Object.keys(mb)]);
  for (const k of keys) if (ma[Number(k)] !== mb[Number(k)]) return true;
  return false;
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
 * 선발이 11명이 아니면(빈 벤치칸으로 선수를 끌어낸 경우) 배치를 만들지 않는다 — 서버가 400
 * (STARTER_COUNT)을 낼 바디를 애초에 조립하지 않는다. 그 상태는 `lineupIssues` 가 이슈로
 * 잡아 [후반 시작]을 잠그므로 제출까지 가지도 않는다.
 */
export function halftimeShapePayload(base: DeckDraft, current: DeckDraft): HalftimeShapePayload {
  const substitutions = diffSubstitutions(base, current);
  const payload: HalftimeShapePayload = { substitutions };
  const afterSubs = applySubs(base, substitutions);
  if (shapeChanged(afterSubs, current) && starterCount(current) === STARTER_COUNT) {
    payload.formation = current.formation;
    payload.starters = toStarters(current);
  }
  return payload;
}

/**
 * 확정된 교체 한 건을 취소 — 투입 선수가 **지금 서 있는** 선발 슬롯에 나간 선수를 되돌려 놓는다
 * (movePlayerToSlot swap 이 나머지를 맞춰준다). 투입 후 그 선수를 다른 자리로 옮겼더라도
 * 그 자리에 out 이 들어가므로 교체만 정확히 풀린다.
 */
export function revertSub(current: DeckDraft, pair: SubPair): DeckDraft {
  const inSlot = findPlayerSlot(current, pair.in);
  if (!inSlot || inSlot.role !== "starter") return current;
  return movePlayerToSlot(current, pair.out, "starter", inSlot.slotIndex);
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
