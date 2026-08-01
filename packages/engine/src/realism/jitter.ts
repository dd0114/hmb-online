import type { MatchLog, TeamSide } from "@hmb/shared";
import type { EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

/**
 * realism/jitter — "볼 옆 수비수가 제자리에서 위아래로 매 틱 진동한다"(마크 당김 오버슛)를
 * 수치화하는 측정 유틸. (#178)
 *
 * ## 무엇을 재나
 * 진동은 **연속한 두 변위가 서로 반대 방향**(사이각 > 90°)인 현상이다. 관객에게 보이는 것은
 * "제자리에서 부르르 떠는" 큰 왕복이므로, 두 변위 모두 **크기 하한** 위일 때만 반전으로 친다.
 * 하한 없이 방향만 보면 완전정지 선수의 1cm 표류까지 반전으로 잡혀 표본 구성만 바뀌어도
 * 지표가 통째로 움직인다(synchrony.ts 가 두 번 걸린 함정).
 *
 * 두 표본을 낸다:
 *  - **nearOwner** — 볼 소유자 반경 `NEAR_OWNER_M` 안의 수비측 필드플레이어. #178 이 보고된
 *    바로 그 장면(압박 담당이 마크와 겹쳐 최악으로 진동)을 좁게 겨눈다.
 *  - **all** — 수비측 필드플레이어 전원. 진동이 볼 근처에만 있는지, 필드 전반인지 구분한다.
 *
 * 각 표본에 대해 `reversalPer100`(진동 빈도)과 `avgMoveM`(평균 이동 m/tick)을 낸다.
 * 진동은 이동량도 부풀리므로 두 값이 같이 떨어져야 진짜 해소다.
 *
 * 이 파일은 순수 분석 유틸(엔진 프로덕션 빌드 index.ts 에 export 되지 않음).
 */

/** 볼 소유자로부터 이 거리(m) 안이면 "볼 옆" 표본. */
const NEAR_OWNER_M = 4;
/**
 * 반전 판정 크기 하한(m/tick). 두 변위가 모두 이 이상일 때만 방향 반전으로 친다.
 * 미세 표류의 방향 뒤집힘은 화면에 보이지 않는다(105m 피치에서 0.5m ≈ 렌더 4px).
 */
const REVERSAL_FLOOR_M = 0.5;
/**
 * "관객 눈에 왕복으로 보이는" 반전의 크기 하한(m/tick). hero 가 본 것은 매 틱 ±5m 짜리
 * 제자리 왕복이었다 — 이 하한 위의 반전은 미세 조정이 아니라 그 병리 자체다.
 */
const BIG_REVERSAL_FLOOR_M = 2;
/** 세트피스 재배치·스팟 배치의 1틱 텔레포트는 이동으로 치지 않는다. */
const TELEPORT_M = 12;
/**
 * **제자리 왕복 판정 — 직진성 상한**(#377 S3-A 재정의).
 *
 * ## 왜 필요한가: 구 관찰량이 두 상태를 섞었다
 * `bigReversalPer100` 은 "사이각 > 90° + 양쪽 ≥2m" 였다. 그런데 그 조건은 **제자리 왕복**
 * (#178 이 잡으려던 병리)과 **정당한 추격**(캐리어가 방향을 틀면 정확히 쫓는 수비수도 같이 튼다)을
 * 구분하지 못한다. S3-A 가 압박 담당의 목표 오염을 없애자(목표가 이제 정확히 공이다) 추격이
 * 늘면서 이 지표가 25.47 → 28.62 로 올랐는데, **그중 절반이 오염 제거 자체**였다(아블레이션:
 * 유닛 크기 1 로 커버·지원을 다 빼도 27.02).
 *
 * `#178` 의 **의도**는 파일 상단에 문장으로 남아 있다 — hero 제보는 *"제자리에서 위아래로 빠르게"*
 * 였고 진단은 *"마크를 지나쳐 반대편을 목표로 잡는다 → 다음 틱 방향 반전"* 이다. 즉 **순 변위가
 * 0 에 가까운 반전**이 대상이지, 방향을 틀며 실제로 이동한 것이 아니다.
 *
 * ## 정의는 성질로 (임의 상수가 아니다)
 * 두 변위의 **순 변위 / 경로 길이** = `|d0 + d1| / (|d0| + |d1|)`. 되돌아왔으면 0 에 가깝고,
 * 방향만 틀고 진행했으면 크다. 등길이 스텝에서 이 비는 정확히 `cos(θ/2)` 이므로
 * **1/3 = θ ≥ 141°** — "거의 되돌아왔다"의 기하학적 정의다. 값을 실측에 맞춰 고른 것이 아니라
 * 각도에서 나온다(그래서 재보정에도 살아남는다).
 *
 * ⚠️ 구 관찰량(`bigReversalPer100`)은 **지우지 않았다** — 계속 재서 보고한다(이력 연속성).
 */
const REVERSAL_STRAIGHTNESS_MAX = 1 / 3;

export interface JitterSample {
  /** (선수, 틱) 표본 수 — 연속 3스냅샷이 확보된 것만. */
  samples: number;
  /** 방향 반전(사이각 > 90°, 양쪽 모두 크기 하한 위) 100표본당 횟수. */
  reversalPer100: number;
  /**
   * 큰 왕복(양쪽 변위 모두 ≥ 2m/tick 이면서 반전) 100표본당 횟수.
   * ⚠️ **게이트에서는 빠졌다**(S3-A) — 추격과 진동을 섞는다. 이력 연속성을 위해 계속 잰다.
   */
  bigReversalPer100: number;
  /**
   * **제자리 왕복** 100표본당 횟수 = 큰 왕복 중 **순 변위/경로 ≤ `REVERSAL_STRAIGHTNESS_MAX`**
   * 인 것만. `#178` 이 실제로 겨눈 병리이고, S3-A 부터 게이트가 이 값을 본다(임계·표본 무변경).
   */
  standstillReversalPer100: number;
  /** 표본의 평균 변위(m/tick). 진동은 이동량도 부풀린다. */
  avgMoveM: number;
  /** 표본 변위의 최대값(m/tick) — 이상치 감시용. */
  maxMoveM: number;
}

export interface JitterReport {
  seeds: number;
  /** 볼 소유자 반경 4m 안 수비측 필드플레이어(= #178 이 보고된 장면). */
  nearOwner: JitterSample;
  /** 수비측 필드플레이어 전원. */
  all: JitterSample;
}

interface Acc {
  n: number;
  rev: number;
  bigRev: number;
  standRev: number;
  sum: number;
  max: number;
}

const newAcc = (): Acc => ({ n: 0, rev: 0, bigRev: 0, standRev: 0, sum: 0, max: 0 });

interface Pt {
  x: number;
  y: number;
}

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 한 표본(연속 두 변위)을 누적기에 더한다. */
function add(acc: Acc, d0: Pt, d1: Pt): void {
  const m0 = Math.hypot(d0.x, d0.y);
  const m1 = Math.hypot(d1.x, d1.y);
  if (m0 > TELEPORT_M || m1 > TELEPORT_M) return;
  acc.n += 1;
  acc.sum += m1;
  if (m1 > acc.max) acc.max = m1;
  if (m0 < REVERSAL_FLOOR_M || m1 < REVERSAL_FLOOR_M) return;
  if (d0.x * d1.x + d0.y * d1.y >= 0) return;
  acc.rev += 1;
  if (m0 >= BIG_REVERSAL_FLOOR_M && m1 >= BIG_REVERSAL_FLOOR_M) {
    acc.bigRev += 1;
    // 제자리 왕복만: 순 변위가 경로 길이 대비 작다(= 되돌아왔다).
    const net = Math.hypot(d0.x + d1.x, d0.y + d1.y);
    if (net <= (m0 + m1) * REVERSAL_STRAIGHTNESS_MAX) acc.standRev += 1;
  }
}

const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;

const report = (acc: Acc): JitterSample => ({
  samples: acc.n,
  reversalPer100: acc.n > 0 ? round((acc.rev / acc.n) * 100) : 0,
  bigReversalPer100: acc.n > 0 ? round((acc.bigRev / acc.n) * 100) : 0,
  standstillReversalPer100: acc.n > 0 ? round((acc.standRev / acc.n) * 100) : 0,
  avgMoveM: acc.n > 0 ? round(acc.sum / acc.n) : 0,
  maxMoveM: round(acc.max),
});

function accumulate(log: MatchLog, near: Acc, all: Acc): void {
  const sn = log.tickSnapshots;
  for (let t = 2; t < sn.length; t++) {
    const a = sn[t - 2]!;
    const b = sn[t - 1]!;
    const c = sn[t]!;
    const owner = c.ballOwner;
    if (!owner) continue;
    const ownerSide: TeamSide = owner.startsWith("H") ? "home" : "away";
    const defSide: TeamSide = ownerSide === "home" ? "away" : "home";
    const gk = defSide === "home" ? "H0" : "A0";
    const pa = new Map<string, Pt>(a.players.map((p) => [p.playerId, p.pos]));
    const pb = new Map<string, Pt>(b.players.map((p) => [p.playerId, p.pos]));

    for (const p of c.players) {
      if (p.team !== defSide || p.playerId === gk) continue;
      const p0 = pa.get(p.playerId);
      const p1 = pb.get(p.playerId);
      if (!p0 || !p1) continue;
      const d0 = { x: p1.x - p0.x, y: p1.y - p0.y };
      const d1 = { x: p.pos.x - p1.x, y: p.pos.y - p1.y };
      add(all, d0, d1);
      if (dist(p.pos, c.ball) <= NEAR_OWNER_M) add(near, d0, d1);
    }
  }
}

/** 다수 시드로 마크 진동 지표를 집계한다. */
export function measureJitter(config: EngineConfig, seeds: string[]): JitterReport {
  const select = makeSelectData();
  const near = newAcc();
  const all = newAcc();
  for (const seed of seeds) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    accumulate(log, near, all);
  }
  return { seeds: seeds.length, nearOwner: report(near), all: report(all) };
}
