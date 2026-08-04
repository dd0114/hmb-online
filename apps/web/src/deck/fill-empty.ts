/**
 * **빈 자리만 채우는 자동 배치** — 덱셋팅·경기전 공용 (#439, hero 확정 Q1=ⓑ).
 *
 * hero: *"덱셋팅도 그렇고 auto도 그렇고 **빈자리 채우기로만** 하자. 그러면 같은 로직을 쓸 수 있지?"*
 * 답은 예다. 화면 차이는 **후보 목록 하나**뿐이다:
 *
 * ```
 * fillEmptySlots(draft, candidates)
 *   덱셋팅  → candidates = 보유 선수 전체(미배치)
 *   경기전  → candidates = 벤치 선수만        ← R2("교체선수 외 선수풀 불가")가 여기서 걸린다
 * ```
 *
 * **R2 를 이 함수 안에 `if` 로 넣지 않는다** — 후보 목록이 곧 규칙이다. 그래야 두 화면이 같은
 * 코드를 타고, 한쪽만 고쳐지는 회귀가 구조적으로 안 생긴다(계약 = `auto-shared-logic.test.ts`).
 *
 * ── 하지 **않는** 것 (이게 이 함수의 절반이다) ────────────────────────────────────────────────
 *   · **이미 놓인 선수를 옮기지 않는다** — 빈 슬롯만 목적지다. 후보에 선발이 섞여 와도 안 옮긴다.
 *   · **프롬프트를 만들거나 덮지 않는다** — 선수가 들고 있던 문장은 자리를 따라가고(`assignPlayer`),
 *     새로 들어온 선수에게 기본문구를 **주입하지 않는다**. 구 `autoBuildLineup` 이 전원의 프롬프트를
 *     덮던 것이 hero 가 [초기화] 를 없애라고 한 피해와 같은 종류였다(#439 STATE 4 ⚠️1).
 *   · **포메이션을 바꾸지 않는다** — 경기 직전에 진형이 조용히 바뀌는 것 자체가 결정거리다.
 *   · **팀 전술·팀 문장을 건드리지 않는다** — 이 함수의 입출력이 `DeckDraft` 뿐인 이유.
 *
 * 결정론: 후보를 playerId 오름차순으로 고정한 뒤 정수 산술 Hungarian(`assignSlots`)만 쓴다.
 * 같은 입력 → 같은 출력(입력 순서 무관).
 */
import { assignSlots, starterSlotList, type AutoPlayer } from "./auto-lineup";
import { assignPlayer, BENCH_MAX, findPlayerSlot, getSlot, type DeckDraft } from "./deck-logic";
import { playerOverall } from "./team-power";

/** playerId 오름차순 + 중복 제거(결정론 전제). */
function normalize(candidates: AutoPlayer[]): AutoPlayer[] {
  const seen = new Set<string>();
  const out: AutoPlayer[] = [];
  for (const p of candidates) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 빈 슬롯을 후보로 채운 새 draft. **아무것도 채울 것이 없으면 입력을 그대로 돌려준다**
 * (같은 참조 = 무동작 — `canFillEmptySlots` 가 그 성질에 기댄다).
 */
export function fillEmptySlots(draft: DeckDraft, candidates: AutoPlayer[]): DeckDraft {
  const pool = normalize(candidates);
  if (pool.length === 0) return draft;

  let next = draft;

  // ① 빈 **선발** 자리 — 후보 중 "지금 선발이 아닌" 선수(미배치 또는 벤치)만 자격이 있다.
  //    벤치 선수가 올라오는 것이 경기전 auto 의 전부다(그리고 그게 R2 가 허용하는 유일한 투입).
  const emptyStarters = starterSlotList(draft.formation).filter(
    (s) => !getSlot(next, "starter", s.slotIndex),
  );
  if (emptyStarters.length > 0) {
    const eligible = pool.filter((p) => findPlayerSlot(next, p.id)?.role !== "starter");
    const picked = assignSlots(emptyStarters, eligible);
    for (const slot of emptyStarters) {
      const playerId = picked.get(slot.slotIndex);
      if (playerId === undefined) continue;
      next = assignPlayer(next, "starter", slot.slotIndex, playerId);
    }
  }

  // ② 빈 **벤치** 자리 — **어느 자리에도 앉지 않은** 후보만. ①에서 벤치 선수가 선발로 올라가며
  //    생긴 빈 벤치 칸을 다른 벤치 선수로 다시 메우면, 그건 "빈 자리 채우기"가 아니라 재배치다
  //    (경기전에서는 그래서 여기가 구조적으로 무동작이 된다 — 후보가 전부 이미 벤치에 앉아 있다).
  const rest = pool
    .filter((p) => !findPlayerSlot(next, p.id))
    .sort((a, b) => {
      const d = playerOverall(b.attributes) - playerOverall(a.attributes);
      return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  let i = 0;
  for (let idx = 0; idx < BENCH_MAX && i < rest.length; idx++) {
    if (getSlot(next, "bench", idx)) continue;
    next = assignPlayer(next, "bench", idx, rest[i]!.id);
    i += 1;
  }

  return next;
}

/**
 * 이 후보 목록으로 채울 자리가 하나라도 있나 — [auto] 버튼의 활성 조건.
 *
 * "빈 슬롯 > 0" 으로 따로 세지 않는다: 빈 자리가 있어도 **자격 있는 후보가 없으면** 무동작이고
 * (경기전에 벤치가 비었거나 전부 이미 앉아 있는 경우), 그 판정을 두 번 적으면 버튼과 동작이 갈린다.
 */
export function canFillEmptySlots(draft: DeckDraft, candidates: AutoPlayer[]): boolean {
  return fillEmptySlots(draft, candidates) !== draft;
}
