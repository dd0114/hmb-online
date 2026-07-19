/**
 * Deterministic "Auto 구성" lineup builder (이슈 #98 요구 3).
 *
 * Given the OWNED players only, this pure function builds an optimal squad WITHOUT any RNG or
 * AI call (§2-5 결정론 불변: no Math.random / Date.now). Same input → same output.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 배치 기준 명세 (요구 3 "기준 문서화" — 그대로 이슈에 인용 가능)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 1) 포지션 적합 점수 (fit):
 *      fit(player, slotPosition) = playerOverall(attributes) × positionWeight(playerPos, slotPos)
 *    - playerOverall = 9개 공유 능력치(PlayerAttributes)의 평균 (team-power.playerOverall, 0..100).
 *    - positionWeight — 정포지션 일치 시 가산, 불일치 시 감점 (아래 상수, EngineConfig 스타일):
 *        · 정확히 일치           → EXACT_WEIGHT (1.00)
 *        · GK ↔ 필드 교차        → GK_CROSS_WEIGHT (0.20)  ← GK 역할은 비교환적이라 큰 감점.
 *          (그 결과 실 GK 의 overall 이 0.20 × 최고 필드선수 overall 보다 크면 GK 슬롯에 우선
 *           배정된다 — 시드 데이터의 overall 하한/필드 상한에선 사실상 항상 성립. 초약체 GK 가
 *           슬롯을 잃는 경계에서도 출력은 여전히 fit-최적이다.)
 *        · 필드 포지션 간 불일치 → max(MIN_OUTFIELD_WEIGHT, EXACT_WEIGHT − STEP_PENALTY × 거리)
 *          거리 = |rank 차| (GK0·DF1·MF2·FW3). 예: DF→MF 0.85, DF→FW 0.70.
 *
 * 2) 선발 11 배치 = "적합 합산 최대화" (그리디 아님 — 전역 최적).
 *    각 슬롯(포메이션 FormationRow.label = GK/DF/MF/FW)에 보유 선수를 1:1 배정해 fit 총합을
 *    최대화한다. 최소비용 이분 매칭(Hungarian, 아래 minCostAssignment)으로 전역 최적을 보장하므로
 *    "다른 배치가 더 높은" 경우가 존재하지 않는다.
 *
 * 3) 동점 tie-break = playerId 사전순 (결정론).
 *    후보 선수를 playerId 오름차순으로 정렬해 열 인덱스를 고정하고, 비용에 열 인덱스만큼의 미세
 *    가중(TIEBREAK)을 더해 fit 동점 시 lex 앞선 playerId 를 택한다. TIEBREAK 총량은 실 fit 최소
 *    간격보다 훨씬 작아(COST_SCALE 로 보장) 최적성을 해치지 않는다.
 *
 * 4) 포메이션 선택: FORMATION_LAYOUTS 후보(현재 4-4-2·4-3-3) 각각에 대해 (2)의 최적 배치를 구하고
 *    "적합 총합이 최대" 인 포메이션을 택한다. 총합 동점이면 formations 인자 순서상 앞선 것.
 *
 * 5) 벤치 채움: 선발에 들지 못한 보유 선수를 overall 내림차순(동점 playerId 오름차순)으로 BENCH_MAX
 *    까지 채운다.
 *
 * 6) 포지션 기본 프롬프트 주입: 배치된 각 선수에 POSITION_DEFAULT_PROMPTS 를 넣는다. 선발은 "맡은
 *    슬롯 포지션" 기준(정포지션이 아니어도 그 역할의 지시), 벤치는 "선수 자기 포지션" 기준.
 *    (재사용: directives.ts/one-tap-directives.ts 는 역할/성향/원탭 대상 지시 카탈로그라 "포지션별
 *     기본 프롬프트" 개념이 없어 신규 정의.)
 *
 * Auto 는 편집기를 전체 재구성하므로 팀 전술은 중립 기본값, 팀 프롬프트는 비움. 호출부(DeckPage)가
 * mutateEditor 로 반영하면 dirty 로 표시돼 사용자가 저장 전 검토/되돌릴 수 있다.
 */
import type { Position } from "./deck-logic";
import { BENCH_MAX, DEFAULT_FORMATION, FORMATION_LAYOUTS, STARTER_COUNT, type DeckDraft, type DraftSlot } from "./deck-logic";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "./tactics-logic";
import { playerOverall } from "./team-power";
import type { components } from "../api/schema";

type PlayerAttributes = components["schemas"]["PlayerAttributes"];

/** Minimal structural shape needed to auto-build (CatalogPlayer satisfies it). */
export interface AutoPlayer {
  id: string;
  position: Position;
  attributes: PlayerAttributes;
}

// ─────────────────────────── fit config (EngineConfig 스타일 상수) ───────────────────────────
export const EXACT_WEIGHT = 1.0;
/** GK↔필드 교차 시 가중 — GK 역할 비교환성 반영(큰 감점). */
export const GK_CROSS_WEIGHT = 0.2;
/** 필드 포지션 rank 1칸 차이당 감점. */
export const STEP_PENALTY = 0.15;
/** 필드 포지션 불일치 가중 하한. */
export const MIN_OUTFIELD_WEIGHT = 0.2;

const POSITION_RANK: Record<Position, number> = { GK: 0, DF: 1, MF: 2, FW: 3 };

/** 포지션 기본 프롬프트 — 배치 선수에 주입(요구 3-6). directives 카탈로그엔 없어 신규 정의. */
export const POSITION_DEFAULT_PROMPTS: Record<Position, string> = {
  GK: "골문을 안정적으로 지키고 최종 수비 라인을 지휘한다.",
  DF: "뒷공간을 경계하며 안정적으로 수비하고 빌드업의 시작점이 된다.",
  MF: "공수를 연결하고 볼 배급과 압박의 중심 역할을 한다.",
  FW: "전방에서 적극적으로 침투하고 마무리 기회를 노린다.",
};

/**
 * Cost scale for the integer assignment matrix. playerOverall is a multiple of 1/9 (mean of 9
 * integer attrs) and positionWeight a fixed constant, so any nonzero real fit gap is ≥ ~1/180
 * (≈ 0.0056) in fit units → ≥ ~5.5e5 scaled at 1e8. The per-column lexicographic tiebreak
 * (≤ STARTER_COUNT × ownedCount, a few thousand) is far smaller and can never overcome it, so the
 * tiebreak only orders true ties. Totals stay well within Number.MAX_SAFE_INTEGER.
 */
const COST_SCALE = 1e8;

/** positionWeight — see module doc (1). */
export function positionWeight(playerPos: Position, slotPos: Position): number {
  if (playerPos === slotPos) return EXACT_WEIGHT;
  if ((playerPos === "GK") !== (slotPos === "GK")) return GK_CROSS_WEIGHT;
  const dist = Math.abs(POSITION_RANK[playerPos] - POSITION_RANK[slotPos]);
  return Math.max(MIN_OUTFIELD_WEIGHT, EXACT_WEIGHT - STEP_PENALTY * dist);
}

/** fit(player, slotPosition) — see module doc (1). */
export function fitScore(player: AutoPlayer, slotPos: Position): number {
  return playerOverall(player.attributes) * positionWeight(player.position, slotPos);
}

/** Flattened starter slot list for a formation, in ascending slotIndex order. */
function starterSlots(formation: string): Array<{ slotIndex: number; position: Position }> {
  const layout = FORMATION_LAYOUTS[formation] ?? FORMATION_LAYOUTS[DEFAULT_FORMATION]!;
  const slots: Array<{ slotIndex: number; position: Position }> = [];
  for (const row of layout) {
    for (const idx of row.slotIndexes) slots.push({ slotIndex: idx, position: row.label });
  }
  return slots.sort((a, b) => a.slotIndex - b.slotIndex);
}

/**
 * Min-cost bipartite assignment (Hungarian / Kuhn-Munkres, e-maxx variant). Rows ≤ cols.
 * Returns rowToCol[i] = column assigned to row i (every row matched to a distinct column).
 * Deterministic: pure integer arithmetic, fixed iteration order.
 */
export function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length; // rows
  const m = n > 0 ? cost[0]!.length : 0; // cols, m >= n
  const INF = Number.MAX_SAFE_INTEGER;
  // 1-indexed working arrays.
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // p[j] = row matched to column j
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    if (p[j]! > 0) rowToCol[p[j]! - 1] = j - 1;
  }
  return rowToCol;
}

interface StarterPlan {
  /** starter DraftSlots (playerId placed). */
  slots: DraftSlot[];
  usedIds: Set<string>;
  totalFit: number;
}

/**
 * Optimal starter assignment for one formation. Players are pre-sorted by playerId (lex) so column
 * indexes are stable; the smaller set becomes matrix rows so Hungarian's rows ≤ cols holds.
 * When owned < 11, only the available players are placed (some slots left empty).
 */
function planStarters(sorted: AutoPlayer[], formation: string): StarterPlan {
  const slots = starterSlots(formation);
  const S = slots.length;
  const N = sorted.length;
  const slotsAsRows = S <= N;
  const rows = slotsAsRows ? S : N;
  const cols = slotsAsRows ? N : S;

  const cost: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const slot = slots[slotsAsRows ? r : c]!;
      const player = sorted[slotsAsRows ? c : r]!;
      // maximize fit → minimize (−scaledFit); +column tiebreak prefers lex-smaller playerId.
      const scaled = Math.round(fitScore(player, slot.position) * COST_SCALE);
      const tiebreakCol = slotsAsRows ? c : r; // player-index dimension carries the tiebreak
      row.push(-scaled + tiebreakCol);
    }
    cost.push(row);
  }

  const outSlots: DraftSlot[] = [];
  const usedIds = new Set<string>();
  let totalFit = 0;
  if (rows > 0) {
    const rowToCol = minCostAssignment(cost);
    for (let r = 0; r < rows; r++) {
      const c = rowToCol[r]!;
      if (c < 0) continue;
      const slot = slots[slotsAsRows ? r : c]!;
      const player = sorted[slotsAsRows ? c : r]!;
      outSlots.push({
        playerId: player.id,
        role: "starter",
        slotIndex: slot.slotIndex,
        promptText: POSITION_DEFAULT_PROMPTS[slot.position],
      });
      usedIds.add(player.id);
      totalFit += fitScore(player, slot.position);
    }
  }
  outSlots.sort((a, b) => a.slotIndex - b.slotIndex);
  return { slots: outSlots, usedIds, totalFit };
}

/** owned ≥ STARTER_COUNT — the Auto button is enabled only then (요구 3). */
export function canAutoBuild(owned: AutoPlayer[]): boolean {
  return owned.length >= STARTER_COUNT;
}

/**
 * Build the optimal squad from owned players (deterministic). Picks the best formation by total fit,
 * fills 11 starters (max fit sum), then the bench, injecting per-position default prompts. Returns a
 * full EditorState with neutral team tactics and empty team prompt (Auto = full rebuild).
 */
export function autoBuildLineup(
  owned: AutoPlayer[],
  formations: string[] = Object.keys(FORMATION_LAYOUTS),
): EditorState {
  const sorted = [...owned].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const candidateFormations = formations.length > 0 ? formations : [DEFAULT_FORMATION];
  let best: { formation: string; plan: StarterPlan } | null = null;
  for (const formation of candidateFormations) {
    const plan = planStarters(sorted, formation);
    if (!best || plan.totalFit > best.plan.totalFit) {
      best = { formation, plan };
    }
  }
  const chosen = best ?? { formation: candidateFormations[0]!, plan: planStarters(sorted, candidateFormations[0]!) };

  // Bench: remaining owned by overall desc, tie playerId asc, up to BENCH_MAX.
  const benchPool = sorted
    .filter((p) => !chosen.plan.usedIds.has(p.id))
    .sort((a, b) => {
      const d = playerOverall(b.attributes) - playerOverall(a.attributes);
      if (d !== 0) return d;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, BENCH_MAX);

  const benchSlots: DraftSlot[] = benchPool.map((p, i) => ({
    playerId: p.id,
    role: "bench",
    slotIndex: i,
    promptText: POSITION_DEFAULT_PROMPTS[p.position],
  }));

  const draft: DeckDraft = {
    formation: chosen.formation,
    slots: [...chosen.plan.slots, ...benchSlots],
  };
  return {
    draft,
    tactics: { ...DEFAULT_TEAM_TACTICS },
    teamPrompt: "",
  };
}
