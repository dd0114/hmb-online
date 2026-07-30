import type { EngineConfig } from "./config";
import type { Pitch } from "./pitch";
import type { SimPlayer, SimState } from "./simstate";
import { playerKey } from "./simstate";
import { attackGoal, clampToPitch } from "./pitch";
import { isqrt, toFixed } from "./fixedmath";
import { deadBallClearance, type DeadBallZone } from "./deadball";

/**
 * setpiece — 프리킥 루틴의 **팀 단위 역할 배정**(벽 / 백업). (#307 S7 · hero 제보 H4)
 *
 * hero: *"좌측 파울하고 프리킥 상황에서 프리킥 벽도 없고 주변 선수들 백업도 없어."*
 * 계량 확인(20시드, 차는 틱): 벽 1.70명 · 백업 1.12명. 원인은 단순하다 — **벽 로직이 코드에 없었다.**
 * `contest.ts:restartFreeKick` 은 taker 를 세우고 정지를 걸 뿐이고, 나머지 선수는 정지 중 규칙기반
 * 배치(`deadball.ts:deadBallShapeTarget`)만 받는다. 그 배치는 "기본 위치를 스팟 쪽으로 조금 당김"
 * 이라 벽이라는 개념이 없다.
 *
 * ## 왜 별도 파일 · 틱당 1회인가 (결정론 규율 §5-1)
 * 벽/백업은 **팀 전체를 보고 누가 갈지 고르는** 계산이다. `decideOffBall`(선수 순회 안, `player.seen`
 * 변이)에서 하면 배열 순서 의존이 생긴다. 그래서 `teamplan.ts` 와 같은 규율로 **decide 루프 앞에서
 * 틱당 1회** 계산하고, 선수별 배치는 만들어진 표를 조회만 한다.
 *
 * ## 결정론
 *  - 순수 함수. `Rng` 를 받지 않는다.
 *  - 선정 기준은 **기본 위치(baseFx)** 다 — 현재 위치로 고르면 매 틱 후보가 바뀌어 목표가 흔들리고
 *    그게 곧 #185(제자리 왕복)다. baseFx 는 정지 창 내내 불변이라 배정이 한 번 정해지면 안 바뀐다.
 *  - 동률은 전순서(점수 → `idHash` → `id`, `decision.ts:cornerHolderRank` 와 같은 관용구).
 *  - 삼각함수 금지(§5-4) — 방향은 스팟→골 벡터의 정수 정규화로만 만든다.
 */

/** 이번 틱 세트피스 역할 배정표. key = `playerKey(side, id)`. */
export interface SetPiecePlan {
  /** 배정된 배치 목표(fixed). 이 표에 있으면 규칙기반 배치 대신 이 자리로 간다. */
  slots: Map<string, { x: number; y: number }>;
  /** 벽 인원(진단·계약용). */
  wallCount: number;
  /** 백업 인원(진단·계약용). */
  backupCount: number;
}

/**
 * 스팟의 **위협거리**(fixed) — 골까지 거리에 횡오프셋을 가중해 더한 값.
 * 각도(골문을 향한 시야각)의 대용이다: 같은 거리라도 골라인 쪽으로 넓게 벌어진 위치는 직접 슛
 * 위협이 낮아 벽을 크게 세우지 않는다. `Math.atan2` 로 각을 재지 않는 이유는 §5-4(삼각함수 금지).
 */
function threatDistance(pitch: Pitch, config: EngineConfig, side: SimPlayer["side"], x: number, y: number): number {
  const g = attackGoal(pitch, side);
  const d = isqrt((x - g.x) * (x - g.x) + (y - g.y) * (y - g.y));
  const lateral = Math.abs(y - g.y);
  return d + Math.round(lateral * config.setPiece.freeKick.wallWideWeight);
}

/**
 * 위협거리(fixed) → 벽 인원. `wallNearM` 이하면 `wallCountNear`, `wallRangeM` 에서 `wallCountFar`,
 * 그 밖이면 0(벽 안 세움). 상수 하드코딩이 아니라 **거리·각도 매핑**이다.
 */
function wallCountFor(config: EngineConfig, scale: number, threatFx: number): number {
  const fk = config.setPiece.freeKick;
  const nearFx = toFixed(fk.wallNearM, scale);
  const rangeFx = toFixed(fk.wallRangeM, scale);
  if (threatFx > rangeFx) return 0;
  if (threatFx <= nearFx) return Math.max(0, Math.round(fk.wallCountNear));
  const span = rangeFx - nearFx;
  if (span <= 0) return Math.max(0, Math.round(fk.wallCountFar));
  const t = (threatFx - nearFx) / span; // 0..1
  return Math.max(0, Math.round(fk.wallCountNear + (fk.wallCountFar - fk.wallCountNear) * t));
}

/** 프리킥에서 이 스팟이 벽을 부르는가 + 몇 명인가. `restartFreeKick` 이 정지 틱 가산 판단에도 쓴다. */
export function freeKickWallCount(
  pitch: Pitch,
  config: EngineConfig,
  side: SimPlayer["side"],
  x: number,
  y: number,
): number {
  const fk = config.setPiece.freeKick;
  if (!fk.enabled) return 0;
  return wallCountFor(config, pitch.scale, threatDistance(pitch, config, side, x, y));
}

/** 전순서 비교(점수 오름차순 → idHash → id). 배열 순서에 기대지 않는다(§5-3). */
function byScore(a: { score: number; p: SimPlayer }, b: { score: number; p: SimPlayer }): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.p.idHash !== b.p.idHash) return a.p.idHash - b.p.idHash;
  return a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0;
}

/**
 * 백업(공격팀 지원) 슬롯 오프셋 표 — (스팟→골 축 u, 그 수직 v) 기준 배율.
 * 정수 테이블로 두는 이유는 `deadball.ts:RAY_DIRS` 와 같다: 런타임 삼각함수 금지(§5-4).
 * 앞 두 개는 좌우 **숏 프리킥 옵션**(스팟 뒤/옆), 뒤는 리바운드·세컨볼 대비로 조금 앞.
 */
const BACKUP_SLOTS: readonly (readonly [number, number])[] = [
  [-450, 1000],
  [-450, -1000],
  [550, 850],
  [550, -850],
  [-1000, 0],
];
const BACKUP_SCALE = 1000;

/**
 * 이번 틱 프리킥 역할 배정. 프리킥이 아니거나 꺼져 있으면 null(= 기존 규칙기반 배치 그대로).
 *
 * `zone` 은 접근 금지 구역(#176). 벽 좌표가 그 구역 **안**으로 잡히면(피치 클램프로 끌려들어간
 * 경우 등) 그 슬롯은 버린다 — 안 버리면 `match.ts` 의 retreat 오버라이드가 매 틱 목표를 뒤집어
 * 벽도 안 서고 움직임만 흔들린다.
 */
export function computeSetPiecePlan(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  sp: NonNullable<SimState["setPiece"]>,
  zone: DeadBallZone | null,
): SetPiecePlan | null {
  const fk = config.setPiece.freeKick;
  if (!fk.enabled || sp.kind !== "free_kick") return null;

  const scale = pitch.scale;
  const slots = new Map<string, { x: number; y: number }>();
  const defSide = sp.side === "home" ? "away" : "home";
  const g = attackGoal(pitch, sp.side); // 수비팀이 지키는 골 = 벽이 가리는 골.
  const dx = g.x - sp.x;
  const dy = g.y - sp.y;
  const d = isqrt(dx * dx + dy * dy);
  if (d <= 0) return null;

  // --- 벽(수비팀) ---
  const want = wallCountFor(config, scale, threatDistance(pitch, config, sp.side, sp.x, sp.y));
  let wallPlaced = 0;
  if (want > 0) {
    const rFx = toFixed(config.rules.deadBall.opponentDistanceM + fk.wallStandoffM, scale);
    const cx = sp.x + Math.round((dx * rFx) / d);
    const cy = sp.y + Math.round((dy * rFx) / d);
    const spacingFx = toFixed(fk.wallSpacingM, scale);
    // 벽 중심에 가까운 순으로 뽑는다 — 현재 위치가 아니라 **기본 위치** 기준(정지 창 내내 불변).
    const cands: { score: number; p: SimPlayer }[] = [];
    for (const p of state.players) {
      if (p.side !== defSide || p.isGK) continue;
      cands.push({ score: isqrt((p.baseFx.x - cx) * (p.baseFx.x - cx) + (p.baseFx.y - cy) * (p.baseFx.y - cy)), p });
    }
    cands.sort(byScore);
    const picked = cands.slice(0, Math.min(want, cands.length));
    for (let i = 0; i < picked.length; i++) {
      // 중심 기준 ±: (2i − (n−1))/2 칸. 벽 좌우 폭이 원 반경보다 밖으로만 벌어지므로
      // 슬롯은 항상 9.15m 밖이다(중심이 이미 밖 + 수직 성분이 거리를 더한다).
      const offFx = Math.round(((2 * i - (picked.length - 1)) * spacingFx) / 2);
      const px = cx + Math.round((-dy * offFx) / d);
      const py = cy + Math.round((dx * offFx) / d);
      const c = clampToPitch(pitch, px, py);
      if (zone && deadBallClearance(zone, c.x, c.y) < 0) continue; // 규칙과 충돌하면 벽 슬롯을 버린다.
      slots.set(playerKey(picked[i]!.p.side, picked[i]!.p.id), c);
      wallPlaced++;
    }
  }

  // --- 백업(공격팀) ---
  let backupPlaced = 0;
  const nBackup = Math.max(0, Math.round(fk.backupCount));
  if (nBackup > 0) {
    const radFx = toFixed(fk.backupRadiusM, scale);
    const takerId = state.ball.owner;
    const takerSide = state.ball.ownerSide;
    const cands: { score: number; p: SimPlayer }[] = [];
    for (const p of state.players) {
      if (p.side !== sp.side || p.isGK) continue;
      if (p.id === takerId && p.side === takerSide) continue;
      cands.push({ score: isqrt((p.baseFx.x - sp.x) * (p.baseFx.x - sp.x) + (p.baseFx.y - sp.y) * (p.baseFx.y - sp.y)), p });
    }
    cands.sort(byScore);
    const picked = cands.slice(0, Math.min(nBackup, cands.length, BACKUP_SLOTS.length));
    for (let i = 0; i < picked.length; i++) {
      const [alongK, acrossK] = BACKUP_SLOTS[i]!;
      const along = Math.round((radFx * alongK) / BACKUP_SCALE);
      const across = Math.round((radFx * acrossK) / BACKUP_SCALE);
      const px = sp.x + Math.round((dx * along) / d) + Math.round((-dy * across) / d);
      const py = sp.y + Math.round((dy * along) / d) + Math.round((dx * across) / d);
      const c = clampToPitch(pitch, px, py);
      slots.set(playerKey(picked[i]!.p.side, picked[i]!.p.id), c);
      backupPlaced++;
    }
  }

  if (slots.size === 0) return null;
  return { slots, wallCount: wallPlaced, backupCount: backupPlaced };
}
