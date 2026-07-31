import type { EngineConfig } from "../config";
import type { SimState, SimPlayer } from "../simstate";
import type { Pitch } from "../pitch";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { setDecisionObserver } from "../action";
import { createPitch } from "../pitch";
import { isqrt } from "../fixedmath";
import { playerKey } from "../simstate";
import { deadBallZone } from "../deadball";
import { computeSetPiecePlan, freeKickWallCount } from "../setpiece";

/**
 * realism/restart — **재시작(데드볼) 재개 계측**(#349).
 *
 * hero 제보(라이브 51' Foul #4, 그리고 2026-08-01 쇼케이스 3장면 재관전):
 *  ① *"프리킥을 안 차고 선수가 드리블해"* → Law 13 위반(재시작은 **킥**으로만 재개된다)
 *  ② *"상대 수비수가 벽을 세워야 되는데 안 세운다"* → 0.25.0 벽 로직이 실제로 **발화**하는가
 *  ③ *"우리팀이 이상하게 위치를 잡는다"* → 역할 배정의 **팀 축**이 뒤집혔는가
 *
 * ## 왜 재계산하지 않나
 * 세 축 모두 **엔진이 쓴 그 값**을 읽는다(§2-2 좌표 추론 금지 · foul.ts 와 같은 규율):
 *  - ① 는 `action.setDecisionObserver` — 결정 직후·실행 직전이라 "엔진이 실제로 무엇을 골랐나"다.
 *    스냅샷으로 되추론하면 "공이 움직였으니 찼겠지" 같은 대리 판정이 된다.
 *  - ②③ 은 `setpiece.computeSetPiecePlan` 을 **그 상태 그대로 다시 부른다**(순수 함수라 부작용 0).
 *    벽 슬롯표·인원·팀 축이 구현이 만든 바로 그 표다. 기하를 테스트가 다시 짜면 구현과 같은
 *    실수를 공유한다(one-on-one.ts 전례).
 *
 * 순수 분석 유틸(프로덕션 `index.ts` 에 export 되지 않는다).
 */

export type DecisionKind = "shoot" | "pass" | "dribble" | "clearance" | "hold";
export const DECISION_KINDS: DecisionKind[] = ["shoot", "pass", "dribble", "clearance", "hold"];

/**
 * 킥으로만 재개되는 재시작 종류(IFAB Law 8 킥오프 · 13 프리킥 · 15 스로인 · 16 골킥).
 * 코너(17)·페널티(14)는 `match.ts` 가 정지 종료 틱에 **직접 발사**하므로 소유자 결정을 거치지 않는다.
 */
export type RestartKind = "free_kick" | "throw_in" | "goal_kick" | "kickoff";
export const RESTART_KINDS: RestartKind[] = ["free_kick", "throw_in", "goal_kick", "kickoff"];

export type KindCounts = Record<DecisionKind, number>;

function zeroKinds(): KindCounts {
  return { shoot: 0, pass: 0, dribble: 0, clearance: 0, hold: 0 };
}

export interface RestartBreakdown {
  matches: number;
  /** 재시작 창(setPiece 살아 있음) 안에서 관측된 **전 결정**. hold 포함. */
  all: Record<RestartKind, KindCounts>;
  /** 그 창을 **끝낸** 결정(= 실제로 이렇게 재개했다). `match.ts` 가 non-hold 에서 setPiece 를 지운다. */
  first: Record<RestartKind, KindCounts>;

  /** 벽(프리킥 한정) — 차는 틱에 `computeSetPiecePlan` 을 그 상태로 재호출해 읽는다. */
  wall: {
    /** 관측된 프리킥 재개 수(= 표본). */
    n: number;
    /** 위협거리 매핑이 요구한 인원 합(`freeKickWallCount`). */
    wantSum: number;
    /** 실제 배정된 벽 슬롯 합(구역 충돌로 버려진 슬롯 제외). */
    placedSum: number;
    /** 배정된 벽 선수가 차는 틱에 **자기 슬롯에 실제로 서 있던** 수 합(도착 허용오차 안). */
    standingSum: number;
    /** 매핑이 벽을 요구했는데(want>0) 배정이 0 이던 건수. */
    wantedButNone: number;
    /** 매핑이 벽을 요구하지 않은(want=0, 사거리 밖) 건수. */
    wantZero: number;
    /** 벽 인원이 배정된 건수. */
    withWall: number;
  };

  /**
   * 역할 배정의 **팀 축**. 벽은 수비팀(재시작 팀의 상대), 백업은 공격팀(재시작 팀)이어야 한다.
   * `wrong*` 이 0 이 아니면 hero 관찰 ③(우리팀이 벽처럼 선다)이 배정 축의 문제라는 뜻이다.
   */
  axis: { wallDef: number; wallWrong: number; backupAtt: number; backupWrong: number };

  /** 벽 슬롯이 규칙 거리(9.15m)를 침범한 건수 — 0 이어야 한다(Law 13). */
  wallEncroach: number;
}

function zero(): RestartBreakdown {
  const all = {} as Record<RestartKind, KindCounts>;
  const first = {} as Record<RestartKind, KindCounts>;
  for (const k of RESTART_KINDS) {
    all[k] = zeroKinds();
    first[k] = zeroKinds();
  }
  return {
    matches: 0,
    all,
    first,
    wall: { n: 0, wantSum: 0, placedSum: 0, standingSum: 0, wantedButNone: 0, wantZero: 0, withWall: 0 },
    axis: { wallDef: 0, wallWrong: 0, backupAtt: 0, backupWrong: 0 },
    wallEncroach: 0,
  };
}

function isRestartKind(k: string): k is RestartKind {
  return (RESTART_KINDS as string[]).includes(k);
}

/** 배정 슬롯에 "도착했다"고 볼 허용오차(m). 걷기 한 틱(walkSpeedM)보다 넉넉히 잡는다. */
const ARRIVE_TOL_M = 2.5;

/**
 * 차는 틱의 프리킥 역할 배정을 읽는다. 구현이 쓴 함수(`computeSetPiecePlan`)를 **그 상태로**
 * 다시 부르므로, 여기서 나오는 벽/백업은 그 틱에 엔진이 실제로 지시한 자리 그 자체다.
 */
function readFreeKickRoles(
  acc: RestartBreakdown,
  state: SimState,
  config: EngineConfig,
  pitch: Pitch,
): void {
  const sp = state.setPiece;
  if (!sp || sp.kind !== "free_kick") return;
  const zone = deadBallZone(state, config, pitch);
  const plan = computeSetPiecePlan(state, pitch, config, sp, zone);
  const want = freeKickWallCount(pitch, config, sp.side, sp.x, sp.y);
  const defSide = sp.side === "home" ? "away" : "home";

  acc.wall.n += 1;
  acc.wall.wantSum += want;
  if (want === 0) acc.wall.wantZero += 1;

  const placed = plan ? plan.wallCount : 0;
  acc.wall.placedSum += placed;
  if (placed > 0) acc.wall.withWall += 1;
  if (want > 0 && placed === 0) acc.wall.wantedButNone += 1;
  if (!plan) return;

  // 슬롯 주인의 팀 축 + 실제 도착 여부. 벽 슬롯은 "스팟에서 골 쪽" 슬롯이고 백업은 그 나머지 —
  // 플랜이 인원만 돌려주므로, 스팟 거리로 두 역할을 가르지 않고 **팀**으로 가른다
  // (벽 = 수비팀 배정, 백업 = 공격팀 배정 — 이것이 곧 검증 대상인 팀 축이다).
  const tolFx = Math.round(ARRIVE_TOL_M * config.fixedScale);
  const ruleFx = Math.round(config.rules.deadBall.opponentDistanceM * config.fixedScale);
  // 역할은 **배정한 쪽이 단 라벨**을 읽는다. 좌표로 되추론하면 안 된다 — 백업 반경 8m 의 앞
  // 두 슬롯이 8.77m 에 놓여 벽 거리(9.5m)와 겹치므로, 기하 분류는 백업 2/3 을 벽으로 오분류한다
  // (실측: 그 오분류가 "9.15m 침범 566건"이라는 **가짜 위반**을 만들었다).
  for (const p of state.players) {
    const slot = plan.slots.get(playerKey(p.side, p.id));
    if (!slot) continue;
    if (slot.role === "wall") {
      const dSpot = isqrt((slot.x - sp.x) * (slot.x - sp.x) + (slot.y - sp.y) * (slot.y - sp.y));
      if (dSpot < ruleFx) acc.wallEncroach += 1;
      if (p.side === defSide) acc.axis.wallDef += 1;
      else acc.axis.wallWrong += 1;
      const d = isqrt((p.posFx.x - slot.x) * (p.posFx.x - slot.x) + (p.posFx.y - slot.y) * (p.posFx.y - slot.y));
      if (d <= tolFx) acc.wall.standingSum += 1;
    } else {
      if (p.side === sp.side) acc.axis.backupAtt += 1;
      else acc.axis.backupWrong += 1;
    }
  }
}

/**
 * 다시드 재시작 분해 수집. config 를 바꿔 호출하면 그대로 대조군이 된다(변이체 킬용).
 */
export function collectRestart(config: EngineConfig, seeds: string[]): RestartBreakdown {
  const acc = zero();
  const select = makeSelectData();
  const pitch = createPitch(config);

  for (const seed of seeds) {
    setDecisionObserver((raw, _owner: SimPlayer, kind) => {
      const st = raw as SimState;
      const sp = st.setPiece;
      if (!sp || !isRestartKind(sp.kind)) return;
      const k = kind as DecisionKind;
      acc.all[sp.kind][k] += 1;
      if (k !== "hold") {
        // 이 결정으로 setPiece 가 지워진다 = 이렇게 재개했다.
        acc.first[sp.kind][k] += 1;
        if (sp.kind === "free_kick") readFreeKickRoles(acc, st, config, pitch);
      }
    });

    runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    setDecisionObserver(null);
    acc.matches += 1;
  }
  return acc;
}

/** 재시작 창 전체에서 "킥이 아닌" 결정 수(드리블 + 홀드). Law 위반의 직접 지표. */
export function nonKickDecisions(r: RestartBreakdown): { dribble: number; hold: number } {
  let dribble = 0;
  let hold = 0;
  for (const k of RESTART_KINDS) {
    dribble += r.all[k].dribble;
    hold += r.all[k].hold;
  }
  return { dribble, hold };
}

/** 재시작 창을 끝낸 결정 총수(= 관측된 재개 횟수). */
export function restartCount(r: RestartBreakdown): number {
  let n = 0;
  for (const k of RESTART_KINDS) for (const d of DECISION_KINDS) n += r.first[k][d];
  return n;
}

/** 사람이 읽는 리포트(진단 출력·증거용). */
export function formatRestart(label: string, r: RestartBreakdown): string {
  const lines: string[] = [];
  lines.push(`=== ${label} (${r.matches} 경기) ===`);
  for (const k of RESTART_KINDS) {
    const a = r.all[k];
    const f = r.first[k];
    lines.push(
      `  ${k.padEnd(9)} 재개 ${String(DECISION_KINDS.reduce((s, d) => s + f[d], 0)).padStart(4)} | ` +
        `첫행동 ${DECISION_KINDS.map((d) => `${d} ${f[d]}`).join(" · ")} | 창 전체 hold ${a.hold} · dribble ${a.dribble}`,
    );
  }
  const w = r.wall;
  lines.push(
    `  벽: 표본 ${w.n} · 매핑요구 ${(w.wantSum / Math.max(1, w.n)).toFixed(2)}명 · 배정 ${(w.placedSum / Math.max(1, w.n)).toFixed(2)}명 · ` +
      `도착 ${(w.standingSum / Math.max(1, w.n)).toFixed(2)}명 | want>0인데 배정0: ${w.wantedButNone} · 사거리밖(want=0): ${w.wantZero}`,
  );
  lines.push(
    `  축: 벽=수비팀 ${r.axis.wallDef} (오배정 ${r.axis.wallWrong}) · 백업=공격팀 ${r.axis.backupAtt} (오배정 ${r.axis.backupWrong}) · 9.15m 침범 ${r.wallEncroach}`,
  );
  return lines.join("\n");
}
