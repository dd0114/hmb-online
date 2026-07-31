import { describe, it, expect } from "vitest";
import type { MatchLog, TeamSide, TickSnapshot } from "@hmb/shared";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { makeTacticalInput, makeSelectData } from "./fixtures";
import { GUARD_SEEDS } from "./realism/harness";
import { measureDeadBallMotion } from "./realism/deadball-motion";

/**
 * #307 S7 / H3·H4 — hero 실관전 제보 2건의 계약.
 *
 *  H4 "프리킥 벽도 없고 주변 선수 백업도 없어"
 *      실측(진단 하네스 freekick-probe, seed 1000000031): **벽 0.67명 · 백업 1.17명**.
 *  H3 "프리킥 시작하고 다른 선수들 움직임도 멈춰 있어"
 *      실측: 데드볼 창의 **23.9% 틱이 거의 정지**(팀 평균 변위 <0.3m).
 *
 * ## 측정 시점을 왜 "차는 틱"으로 잡나 (진단 하네스와 다른 점)
 * 진단 하네스는 **프리킥이 선언된 틱**에서 벽을 셌다. 그 틱엔 아직 아무도 걷지 않았다 —
 * 선언 틱에 벽이 서 있으려면 순간이동뿐이고 그건 #59/#174 가 금지한 그림이다.
 * 규칙(Law 13)이 요구하는 것도 "**공이 인플레이 될 때**  9.15m 밖에 있을 것"이다.
 * 그래서 계약은 **정지 창의 마지막 틱(= taker 가 차기 직전)** 에서 잰다. 선언 틱 수치는
 * 진단 하네스가 계속 같이 찍으므로 전후 비교가 끊기지 않는다.
 *
 * ## 판정은 시드 하나에 걸지 않는다
 * 데드볼 전개는 카오스적이라 단일 시드는 표본 구성만 바뀌어도 뒤집힌다 → 다시드 전수 평균.
 * ⚠️ 시드를 REALISM_SEEDS(20) → GUARD_SEEDS(60) 로 올렸다(#365). 경기가 45분이 되며 20시드
 * 표본이 100 아래(실측 65)로 떨어졌는데, **임계를 내리는 것은 계약을 약하게 만드는 것**이라
 * 표본 쪽을 키워 원래 검정력을 되찾는다(밴드·임계는 하나도 안 바꿨다).
 *
 * ## 규칙 정합(가장 미묘한 지점)
 * 벽은 **9.15m 안**에 서면 안 된다 — 접근 금지(#176)와 충돌하면 `deadBallRetreatPoint` 가
 * 벽을 도로 밀어내 벽이 안 선다(또는 규칙이 깨진다). 벽 인원이 **밖**에 선다는 것을 직접 박제한다.
 */

/** IFAB Law 13 — 상대는 공에서 9.15m 밖. 노브가 아니라 규칙이므로 테스트가 직접 들고 있다. */
const LAW_DISTANCE_M = 9.15;
/** 스냅샷 좌표 2자리 반올림 여유. */
const EPS = 0.05;
/** 정지 창 탐색 상한(틱). */
const MAX_WINDOW = 60;

/**
 * "직접 슛 사거리 안" 프리킥의 **축구적** 정의 — 엔진 config 를 읽지 않는다.
 * (config 를 읽으면 노브를 좁히는 것만으로 계약이 통과한다 = 자기검수.)
 */
const SHOT_RANGE_M = 30;
const SHOT_LATERAL_M = 20;

/** 벽 판정 기하(진단 하네스와 동일) — 스팟에서 7~13m, 수비 골 쪽. */
const WALL_MIN_M = 7;
const WALL_MAX_M = 13;
/** 백업 판정 반경(진단 하네스와 동일). */
const BACKUP_M = 15;

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

interface FreeKickCase {
  seed: string;
  tick: number;
  kickTick: number;
  side: TeamSide;
  spot: { x: number; y: number };
  /** 스팟 → 수비팀 골(= 재시작 팀이 공격하는 골) 거리(m). */
  goalDistM: number;
  lateralM: number;
  wall: number;
  backup: number;
  /** 차는 틱에 9.15m 안에 있던 수비 아웃필더(규칙 위반). */
  encroach: string[];
}

/**
 * 프리킥 창 전수 스캔. 창 = 선언 틱 ~ **공이 인플레이 되기 직전**
 * (소유가 비거나 공이 스팟에서 0.3m 이상 움직이거나 새 재시작이 선언될 때까지).
 */
function scanFreeKicks(log: MatchLog, seed: string, pitchW: number, pitchH: number): FreeKickCase[] {
  const byTick = new Map<number, TickSnapshot>(log.tickSnapshots.map((s) => [s.tick, s]));
  const restartTicks = new Set(
    log.events.filter((e) => e.type === "free_kick" || e.type === "penalty" || e.type === "kickoff").map((e) => e.tick),
  );
  // 하프/종료 휘슬은 데드볼 창을 도중에 잘라낸다(재시작이 실행되지 않고 킥오프 리셋으로 넘어간다).
  // 그 창은 "물러날 시간" 자체가 없어 규칙도 배치도 성립하지 않는다 → 제외(`deadball-laws` 와 동일 규율).
  const whistles = log.events.filter((w) => w.type === "half_whistle" || w.type === "full_whistle").map((w) => w.tick);
  const out: FreeKickCase[] = [];

  for (const e of log.events) {
    if (e.type !== "free_kick" || !e.team) continue;
    if (whistles.some((w) => w >= e.tick && w <= e.tick + MAX_WINDOW)) continue;
    const s0 = byTick.get(e.tick);
    if (!s0) continue;
    const spot = { x: s0.ball.x, y: s0.ball.y };
    let kickTick = e.tick;
    for (let t = e.tick + 1; t <= e.tick + MAX_WINDOW; t++) {
      const s = byTick.get(t);
      if (!s) break;
      if (s.ballOwner == null || dist(s.ball.x, s.ball.y, spot.x, spot.y) > 0.3) break;
      if (restartTicks.has(t)) break;
      kickTick = t;
    }
    const sn = byTick.get(kickTick);
    if (!sn) continue;
    const side = e.team;
    const oppPrefix = side === "home" ? "A" : "H";
    // 재시작 팀이 공격하는 골 = 수비팀이 지키는 골.
    const goal = { x: side === "home" ? pitchW : 0, y: pitchH / 2 };
    const goalDistM = dist(spot.x, spot.y, goal.x, goal.y);
    const lateralM = Math.abs(spot.y - goal.y);

    let wall = 0;
    let backup = 0;
    const encroach: string[] = [];
    for (const p of sn.players) {
      const d = dist(p.pos.x, p.pos.y, spot.x, spot.y);
      const isOpp = p.playerId.startsWith(oppPrefix);
      if (isOpp) {
        if (p.playerId !== `${oppPrefix}0` && d < LAW_DISTANCE_M - EPS) {
          encroach.push(`${p.playerId}@${d.toFixed(2)}m`);
        }
        // 벽 = 스팟과 수비 골 사이 9.15m 부근에 선 수비수.
        const towardGoal = (goal.x - spot.x) * (p.pos.x - spot.x) > 0;
        if (towardGoal && d >= WALL_MIN_M && d <= WALL_MAX_M) wall++;
      } else if (p.playerId !== sn.ballOwner && d <= BACKUP_M) {
        backup++;
      }
    }
    out.push({ seed, tick: e.tick, kickTick, side, spot, goalDistM, lateralM, wall, backup, encroach });
  }
  return out;
}

const select = makeSelectData();
const logs = GUARD_SEEDS.map((seed) => ({
  seed,
  log: runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, defaultEngineConfig),
}));
const cases = logs.flatMap(({ seed, log }) =>
  scanFreeKicks(log, seed, defaultEngineConfig.pitch.width, defaultEngineConfig.pitch.height),
);
const inRange = cases.filter((c) => c.goalDistM <= SHOT_RANGE_M && c.lateralM <= SHOT_LATERAL_M);

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

describe("프리킥 벽 + 백업 (#307 H4)", () => {
  it("표본이 충분하다(계약이 빈 집합을 통과하지 않게)", () => {
    expect(cases.length).toBeGreaterThan(100);
    expect(inRange.length).toBeGreaterThan(20);
  });

  /** 수치 리포트(env 가드) — 전후 비교용. `HMB_FK307=1 npx vitest run ...freekick-setpiece.test.ts` */
  const REPORT = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_FK307;
  it.skipIf(!REPORT)("리포트: 벽·백업 수치", () => {
    const m = (a: number[]): string => mean(a).toFixed(2);
    // eslint-disable-next-line no-console
    console.log(
      `\n[#307 H4 / 20시드 · 차는 틱]\n` +
        `  프리킥 ${cases.length}건 (사거리 안 ${inRange.length}건)\n` +
        `  벽(사거리 안) 평균 ${m(inRange.map((c) => c.wall))}명 · 벽 0명 ${inRange.filter((c) => c.wall === 0).length}건\n` +
        `  벽(전체)      평균 ${m(cases.map((c) => c.wall))}명\n` +
        `  백업(전체)    평균 ${m(cases.map((c) => c.backup))}명\n` +
        `  9.15m 침범    ${cases.filter((c) => c.encroach.length > 0).length}건\n`,
    );
    expect(cases.length).toBeGreaterThan(0);
  });

  it("슛 사거리 안 프리킥에 벽이 선다 — 차는 틱 평균 ≥2명 (실측 기준선 0.67)", () => {
    const m = mean(inRange.map((c) => c.wall));
    const zero = inRange.filter((c) => c.wall === 0).length;
    expect(
      m,
      `벽 평균 ${m.toFixed(2)}명 / ${inRange.length}건 · 벽 0명 ${zero}건`,
    ).toBeGreaterThanOrEqual(2);
  });

  it("프리킥 스팟 주변에 백업이 선다 — 차는 틱 15m 안 평균 ≥2.5명 (실측 기준선 1.17)", () => {
    const m = mean(cases.map((c) => c.backup));
    expect(m, `백업 평균 ${m.toFixed(2)}명 / ${cases.length}건`).toBeGreaterThanOrEqual(2.5);
  });

  /**
   * 벽 ↔ 접근 금지(#176) 정합. 벽은 9.15m **바깥**에 서는 것이므로 규칙과 충돌하지 않아야 한다.
   * 충돌하면 둘 중 하나가 진다: 벽이 안 서거나(retreatPoint 가 밀어냄) 규칙이 깨진다.
   */
  it("벽이 접근 금지를 침범하지 않는다 — 차는 틱 9.15m 안 수비 아웃필더 0", () => {
    const bad = cases.filter((c) => c.encroach.length > 0);
    const shown = bad.slice(0, 10).map((c) => `${c.seed} t${c.kickTick} ${c.encroach.join(",")}`);
    expect(shown, `${bad.length}건`).toEqual([]);
  });
});

/**
 * H3 — 데드볼 중 "전원 정지". 진단 하네스와 **같은 정의**로 잰다:
 * 데드볼 창의 틱마다 전 선수 평균 변위를 구하고, 그 평균이 0.3m 미만인 틱의 비율.
 */
const STILL_THR_M = 0.3;
const DEAD_LEAD = 2;
const DEAD_TAIL = 16;

function deadTickMeans(log: MatchLog): number[] {
  const snaps = log.tickSnapshots;
  const dead = new Set<number>();
  for (const e of log.events) {
    if (["kickoff", "free_kick", "penalty", "goal", "foul", "offside", "half_whistle"].includes(e.type)) {
      for (let t = e.tick - DEAD_LEAD; t <= e.tick + DEAD_TAIL; t++) dead.add(t);
    }
  }
  const out: number[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const cur = snaps[i]!;
    if (!dead.has(cur.tick)) continue;
    const prevById = new Map(snaps[i - 1]!.players.map((p) => [`${p.team}:${p.playerId}`, p]));
    let moved = 0;
    let n = 0;
    for (const p of cur.players) {
      const q = prevById.get(`${p.team}:${p.playerId}`);
      if (!q) continue;
      const d = dist(p.pos.x, p.pos.y, q.pos.x, q.pos.y);
      if (d > 12) continue; // 포메이션 리셋 등 순간이동 제외
      moved += d;
      n++;
    }
    if (n > 0) out.push(moved / n);
  }
  return out;
}

describe("데드볼 중 정지 (#307 H3)", () => {
  const all = logs.flatMap(({ log }) => deadTickMeans(log));
  const stillPct = (all.filter((v) => v < STILL_THR_M).length / all.length) * 100;
  const meanStep = mean(all);

  it("표본이 충분하다", () => {
    expect(all.length).toBeGreaterThan(10000);
  });

  const REPORT = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_FK307;
  it.skipIf(!REPORT)("리포트: 데드볼 정지 수치", () => {
    const s = [...all].sort((a, b) => a - b);
    const q = (f: number): string => s[Math.floor(f * s.length)]!.toFixed(3);
    // eslint-disable-next-line no-console
    console.log(
      `\n[#307 H3 / 20시드]\n` +
        `  데드볼 틱 ${all.length}\n` +
        `  "거의 정지"(<0.3m) ${((all.filter((v) => v < STILL_THR_M).length / all.length) * 100).toFixed(1)}%\n` +
        `  평균 ${mean(all).toFixed(3)} · p10 ${q(0.1)} · p25 ${q(0.25)} · 중앙 ${q(0.5)} · p90 ${q(0.9)} m/tick\n`,
    );
    expect(all.length).toBeGreaterThan(0);
  });

  it('데드볼 "거의 정지" 틱 비율 ≤12% (실측 기준선 23.9%)', () => {
    expect(stillPct, `거의 정지 ${stillPct.toFixed(1)}% · 평균 변위 ${meanStep.toFixed(3)} m/tick`).toBeLessThanOrEqual(12);
  });

  /**
   * ⚠️ 지표를 **평균이 아니라 하위 10퍼센타일(p10)** 로 잡는다 — 계획서 문구("평균 변위 상승")와의
   * 의도적 편차이고, 그 이유가 이 픽스의 성격 자체다.
   *
   * 이 픽스는 "정지 중 총 이동량을 늘리는" 것이 아니라 **같은 이동량을 창 전체에 펴는** 것이다
   * (재시작 시각에 맞춘 도착 페이싱). 그래서 분포의 **아래 꼬리(굳은 프레임)** 는 사라지지만
   * **위 꼬리(빨리 가서 서 있는 사람)** 도 같이 깎여 평균·중앙값은 오히려 내려간다.
   * 6시드 아블레이션 실측(전부 off → 현행):
   *    still 20.5% → 8.4% · **p10 0.166 → 0.390** · med 1.436 → 1.002 · mean 1.548 → 1.421
   * 평균을 게이트로 두면 "총 이동량을 늘리면 통과" 가 되어 되레 #174(단독 질주)를 부추긴다.
   * hero 가 본 증상은 "멈춰 있다" 이므로 **아래 꼬리**가 옳은 지표다.
   */
  const sorted = [...all].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)]!;
  const medianStep = sorted[Math.floor(sorted.length / 2)]!;
  const P10_BASELINE = 0.166; // 픽스 전 6시드 아블레이션 실측

  it(`데드볼 변위 하위 10%(p10)가 기준선(${P10_BASELINE} m/tick)의 1.5배를 넘는다`, () => {
    expect(
      p10,
      `p10 ${p10.toFixed(3)} · 중앙값 ${medianStep.toFixed(3)} · 평균 ${meanStep.toFixed(3)} m/tick`,
    ).toBeGreaterThan(P10_BASELINE * 1.5);
  });

  /**
   * #185(제자리 왕복)·#174(단독 질주) 회귀 금지 — 정지를 되살리려다 그 두 버그를 부활시키면 안 된다.
   * 지표는 `realism/deadball-motion`(그 두 이슈가 남긴 계량형)을 그대로 쓴다.
   */
  it("#174 회귀 금지 — 정지 중 최대 변위가 걷기 상한을 넘지 않는다", () => {
    const cap = Math.max(
      defaultEngineConfig.rules.deadBall.walkSpeedM,
      defaultEngineConfig.rules.deadBall.cornerWalkSpeedM,
    );
    const worst = logs.map(({ seed, log }) => ({ seed, m: measureDeadBallMotion(log) }));
    const over = worst.filter((w) => w.m.maxStepM > cap + 0.15);
    expect(
      over.map((w) => `${w.seed}: max ${w.m.maxStepM}m/tick > cap ${cap}`),
      "정지 중 질주",
    ).toEqual([]);
  });

  /**
   * ⚠️ 기준선은 **0 이 아니다**. 이 트리(engine@0.24.0)에서 20시드를 재면 왕복률이
   * 0.12~0.19/100 로 이미 남아 있다(코너 창은 규칙기반 정적 배치 대상이 아니라 평소 로직이
   * 도는 구간이라 그렇다). "0" 으로 박으면 계약이 처음부터 빨간불이라 회귀 감시를 못 한다 →
   * **기준선 상한(0.19)을 넘지 않을 것**으로 박는다. 정지를 되살리려다 왕복이 늘면 여기서 걸린다.
   */
  const JITTER_BASELINE_PER100 = 0.19;

  it(`#185 회귀 금지 — 정지 중 제자리 왕복이 기준선(${JITTER_BASELINE_PER100}/100)을 넘지 않는다`, () => {
    const worst = logs.map(({ seed, log }) => ({ seed, m: measureDeadBallMotion(log) }));
    const jitter = worst.filter((w) => w.m.jitterPer100 > JITTER_BASELINE_PER100);
    expect(jitter.map((w) => `${w.seed}: ${w.m.jitterPer100}/100`), "제자리 왕복 악화").toEqual([]);
  });
});
