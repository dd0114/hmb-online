import type { MatchLog } from "@hmb/shared";

/**
 * realism/loft — **무소유 공의 연속 이동 구간(run)** 재구성. 진단(`loft-probe`)과
 * 계약(`ball-physics.test.ts` 의 비행거리 상한)이 **같은 함수**를 쓴다.
 *
 * #327: 띄운 공에 착지 전이가 없으면 `friction.lofted`(공기저항)만으로 감속한다 — 그 상태의
 * 감속 거리는 v0=16 m/tick 에서 **188m** 이고, 105×68 피치의 대각선은 **125m** 다. 즉 "한 번의
 * 접촉으로 간 경로장 ≤ 대각선"은 마찰값·볼륨 노브가 어떻게 움직여도 참이어야 하는
 * **구조 불변식**이고, 착지 모델이 없으면 원리적으로 못 지킨다.
 *
 * ⚠️ 다만 이 상한 하나로는 부족하다 — 실제 결함 상태의 실측 max 는 84.8m 로 **상한 안**이었다.
 * 결함을 드러낸 것은 `steps`(틱별 이동량)의 **감쇠비**다(0.92 = 공중 / 0.62 = 지면).
 * 그래서 이 함수는 총량과 함께 스텝열을 그대로 돌려준다.
 *
 * 순수 분석 유틸(프로덕션 `index.ts` 미export).
 */

/** 데드볼 재배치 이벤트 — 공이 규칙상 순간이동하므로 경로장 측정에서 잘라낸다. */
const RESTART_KINDS = new Set([
  "corner",
  "goal_kick",
  "throw_in",
  "free_kick",
  "penalty",
  "kickoff",
  "goal",
  "shot",
  "save",
]);

export interface UnownedRun {
  seed: string;
  startTick: number;
  ticks: number;
  /** 구간 총 경로장(m) — 틱별 이동량의 합. */
  pathM: number;
  /** 시작점→끝점 직선거리(m). */
  netM: number;
  /** 이 구간이 걷어내기(clearance) 이벤트에서 시작했나. */
  fromClearance: boolean;
  /** 틱별 이동량(m) — 마찰이 바뀌는 지점(착지)이 꺾임으로 보인다. */
  steps: number[];
}

/** 재배치로 공이 순간이동하는 틱 집합(±1틱 여유). */
function cutTicks(log: MatchLog): Set<number> {
  const cut = new Set<number>();
  for (const e of log.events) {
    const kind = e.type === "kickoff" && e.detail ? e.detail : e.type;
    if (RESTART_KINDS.has(kind) || RESTART_KINDS.has(e.type)) {
      for (let t = e.tick - 1; t <= e.tick + 1; t++) cut.add(t);
    }
  }
  return cut;
}

/** "찼다"고 볼 최소 첫 스텝(m/tick) — 이보다 느리면 구간을 시작하지 않는다. */
const MIN_LAUNCH = 3;
/** 이 아래 이동은 정지로 보고 구간을 닫는다(m/tick). */
const STOP = 0.2;

/**
 * 무소유 상태로 공이 연속 이동한 구간들. 소유 발생 / 재배치 틱 / 정지에서 닫힌다.
 * 즉 **한 번의 접촉으로 공이 이동한 거리**의 근사다.
 */
export function unownedRuns(log: MatchLog, seed = ""): UnownedRun[] {
  const S = log.tickSnapshots;
  const cut = cutTicks(log);
  const clearanceTicks = new Set(log.events.filter((e) => e.type === "clearance").map((e) => e.tick));
  const out: UnownedRun[] = [];
  let steps: number[] = [];
  let startTick = 0;
  let sx = 0;
  let sy = 0;
  const close = (ex: number, ey: number): void => {
    if (steps.length >= 2) {
      out.push({
        seed,
        startTick,
        ticks: steps.length,
        pathM: steps.reduce((t, v) => t + v, 0),
        netM: Math.hypot(ex - sx, ey - sy),
        fromClearance: clearanceTicks.has(startTick) || clearanceTicks.has(startTick + 1),
        steps,
      });
    }
    steps = [];
  };
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1]!;
    const b = S[i]!;
    const owned = a.ballOwner != null || b.ballOwner != null;
    const isCut = cut.has(a.tick) || cut.has(b.tick);
    const d = Math.hypot(a.ball.x - b.ball.x, a.ball.y - b.ball.y);
    if (owned || isCut) {
      close(a.ball.x, a.ball.y);
      continue;
    }
    if (steps.length === 0) {
      if (d >= MIN_LAUNCH) {
        startTick = a.tick;
        sx = a.ball.x;
        sy = a.ball.y;
        steps = [d];
      }
      continue;
    }
    if (d < STOP) {
      close(a.ball.x, a.ball.y);
      continue;
    }
    steps.push(d);
  }
  const last = S[S.length - 1];
  if (last) close(last.ball.x, last.ball.y);
  return out;
}
