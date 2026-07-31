import { describe, it, expect } from "vitest";
import type { MatchLog } from "@hmb/shared";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { advanceBall, kickBall } from "../ball";
import { createPitch } from "../pitch";
import { toFixed } from "../fixedmath";
import type { Ball } from "../simstate";

/**
 * 공 연속성 계약 (#181, §2.5 E2E-TDD 회귀 가드).
 *
 * 버그(hero 실관전, 1'33"): **주변에 선수가 아무도 없는데 공이 스스로 각을 만들며 휘었다.**
 * 원인은 렌더가 아니라 엔진 데이터다 — 패스 도착 처리가 공을 리시버에게 **순간이동**시켰다:
 *   1) ball.advanceBall 이 `arrived = remaining <= f.speed` 로 판정 → passSpeed(18m/tick) 때문에
 *      공이 목표에서 **최대 18m 떨어진 상태**에서 이미 "도착"이 됐고,
 *   2) contest.giveBallTo 가 `ball.posFx = 리시버.posFx` 로 **거리 무제한 대입**을 했다.
 *   비행 목표는 *패스 시점* 리시버 위치인데 리시버는 그동안 계속 달렸으므로, 마지막 한 틱이
 *   임의 방향 점프가 된다(실측 90분 1156회 도착: p50 5.9m · p90 13.7m · max 33.7m).
 *   뷰어(viewer-core)는 스냅샷을 선형보간만 하므로 이 점프를 그대로 "휘는 궤적"으로 그렸다.
 *
 * 계약: **공의 방향은 누군가 건드릴 때만 바뀐다.** 빈 공간에서 혼자 꺾이지 않는다.
 * (수정 전엔 FAIL — 20시드에서 빈 공간 꺾임이 다수 검출된다.)
 */

const cfg = defaultEngineConfig;
const select = makeSelectData();

/** 꺾임으로 셀 최소 이동량(m). 이보다 작은 흔들림은 드리블 미세 조정이라 대상 아님. */
const MOVE_MIN_M = 3;
/** 꺾임으로 셀 최소 각도(도). */
const TURN_MIN_DEG = 20;
/**
 * "누가 건드렸다"고 인정할 최대 거리(m). **닿을 수 있는 거리** + 한 틱 이동 여유.
 * 이 거리 밖에서 공이 꺾이면 접촉 없이 스스로 휜 것이다.
 *
 * #306: 상한을 `controlRange`(3.5m, 발로 잡는 거리)에서 `max(controlRange, aerial.rangeM)`
 * 으로 넓혔다. 공중볼은 **뛰어올라 머리로** 맞히므로 닿는 거리가 발보다 넓고(`aerial.rangeM` 5m),
 * 헤딩으로 꺾인 공은 그 반경 안에서 접촉이 일어난 것이다. 이 상한은 임계를 느슨하게 하려고
 * 고른 값이 아니라 **config 에서 파생된 물리 상한**이다(반경을 줄이면 상한도 같이 줄어든다).
 */
const TOUCH_REACH_M = Math.max(cfg.contest.controlRange, cfg.contest.aerial.rangeM) + cfg.speed.maxPerTick;

interface Kink {
  seed: string;
  tick: number;
  deg: number;
  nearestM: number;
}

/**
 * 데드볼 재배치(스로인/코너/골킥/프리킥/페널티/킥오프) 틱 — 뷰어(viewer-core playback.buildBallCutTicks)가
 * 이 틱들은 **보간을 끊고** 그린다. 화면에 곡선으로 그려지지 않으므로 "휘는 공" 계약의 대상이 아니다.
 */
const REPOSITION = new Set(["corner", "goal_kick", "throw_in", "free_kick", "penalty", "kickoff"]);
function repositionTicks(log: MatchLog): Set<number> {
  const s = new Set<number>();
  for (const e of log.events) {
    const kind = e.type === "kickoff" && e.detail ? e.detail : e.type;
    if (REPOSITION.has(kind) || REPOSITION.has(e.type)) s.add(e.tick);
  }
  return s;
}

/** 로그에서 "접촉 없는 방향 전환"을 모두 찾는다. */
function lonelyKinks(seed: string, log: MatchLog, reachM: number = TOUCH_REACH_M): Kink[] {
  const S = log.tickSnapshots;
  const cut = repositionTicks(log);
  const out: Kink[] = [];
  for (let i = 1; i + 1 < S.length; i++) {
    const sa = S[i - 1], sb = S[i], sc = S[i + 1];
    if (!sa || !sb || !sc) continue;
    // 재배치 틱이 걸친 구간은 뷰어가 보간을 끊는다 → 곡선으로 보이지 않는다.
    if (cut.has(sa.tick) || cut.has(sb.tick) || cut.has(sc.tick)) continue;
    const a = sa.ball, b = sb.ball, c = sc.ball;
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
    // 양쪽 모두 실제 비행급 이동일 때만 — 정지/미세이동은 각도가 무의미하다.
    if (m1 < MOVE_MIN_M || m2 < MOVE_MIN_M) continue;
    const raw = Math.abs((Math.atan2(v2y, v2x) - Math.atan2(v1y, v1x)) * (180 / Math.PI));
    const deg = raw > 180 ? 360 - raw : raw;
    if (deg < TURN_MIN_DEG) continue;
    let nearest = Infinity;
    for (const p of sb.players) {
      const d = Math.hypot(p.pos.x - b.x, p.pos.y - b.y);
      if (d < nearest) nearest = d;
    }
    if (nearest > reachM) out.push({ seed, tick: sb.tick, deg, nearestM: nearest });
  }
  return out;
}

describe("공 연속성 — 접촉 없이 휘지 않는다 (#181)", () => {
  /**
   * #371: 아래 세 it 이 **같은 20시드를 같은 기본 config 로** 각자 다시 돌려 60경기(≈29초)를 썼다.
   * `runMatch` 는 §2-5 결정론 계약상 같은 입력에 같은 로그를 주므로 한 번 돌려 나눠 쓴다 —
   * 시드·임계·판정 어느 것도 안 바꾼 순수 중복 제거다. 상주 로그 수는 20 으로, 기존 it 하나가
   * 루프 안에서 가졌던 최고점(1)보다는 높지만 다른 파일(`ball-physics` 8·60)과 같은 자릿수다.
   */
  const LOGS: { seed: string; log: MatchLog }[] = REALISM_SEEDS.map((seed) => ({
    seed,
    log: runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg),
  }));

  it("리얼 config 20시드: 빈 공간에서의 공 방향 전환이 0건", () => {
    const all: Kink[] = [];
    for (const { seed, log } of LOGS) {
      all.push(...lonelyKinks(seed, log));
    }
    const worst = [...all].sort((x, y) => y.deg - x.deg).slice(0, 8);
    const detail = worst
      .map((k) => `seed ${k.seed} t=${k.tick} ${k.deg.toFixed(0)}° 최근접 ${k.nearestM.toFixed(1)}m`)
      .join("\n  ");
    expect(all.length, `접촉 없는 공 방향 전환(허용 접촉거리 ${TOUCH_REACH_M}m):\n  ${detail}`).toBe(0);
  });

  it("공이 꺾이는 지점엔 늘 사람이 붙어 있다 — 최악값도 손 닿는 거리", () => {
    // 위 계약(TOUCH_REACH_M)은 원리에서 유도한 상한이라 여유가 있다. 실제 최악값도 함께 박제해
    // "조금씩 나빠지는" 회귀를 잡는다. 수정 전엔 도착 순간 공 점프만으로도 p90 13.7m·max 33.7m 였다.
    // 상한은 config 에서 파생시킨다(controlRange 를 조정해도 가드가 무의미해지지 않게).
    //
    // ⚠️ 이 값은 **물리 상한이 아니라 래칫**(실측 최악값 박제)이다 — 정당한 변경으로 움직이면
    // 근거와 함께 재기준한다. #176(데드볼 규칙)으로 타이밍이 밀려 최악값 9.4 → **9.74m**.
    // 원인 확인: 그 장면(seed 9999999999 t3165)은 **비행 중간 틱**이라 공 근처에 사람이 없는 게
    // 정상이고, 꺾임을 만든 접촉은 **다음 틱 도착**(컨트롤러 거리 0m)이다. 도착 시 공 이동은
    // #181 이 `giveBallTo` 를 controlRange(2.5m) 안으로 제한해 **이미 구조적으로 묶여 있다**
    // (무제한 워프 → 최대 2.5m). 즉 엔진에 남은 결함이 아니라 지표가 비행 중간 틱을 보는 것이다.
    // 물리 가드(위 "0건" 계약)는 그대로 통과하므로, 래칫만 0.5m 완화한다.
    let worst = 0;
    for (const { seed, log } of LOGS) {
      for (const k of lonelyKinks(seed, log, 0)) worst = Math.max(worst, k.nearestM);
    }
    expect(worst, `꺾임 지점 최근접 선수 최악 거리 ${worst.toFixed(1)}m`).toBeLessThan(TOUCH_REACH_M - 0.5);
  });

  it("멈춰 있던 공은 사람이 와야 움직인다 — 정지→워프 금지", () => {
    // 독립 QA 지적(#181 1차 FAIL): 위 "꺾임" 계약은 **양쪽 구간 모두 3m 이상 이동**을 요구하므로
    // `정지(0m) → 워프(17m)` 패턴을 구조적으로 못 잡는다. 실제로 도착 대기 타임아웃 폴백이
    // 공을 claimant 위치로 거리 무제한 대입해, 아무도 없는 곳에 멈춰 있던 공이 다음 틱에 16~20m
    // 순간이동했다(90분 128~169회). 그 사각지대를 별도 계약으로 막는다.
    const violations: string[] = [];
    for (const { seed, log } of LOGS) {
      const S = log.tickSnapshots;
      const cut = repositionTicks(log);
      for (let i = 1; i + 1 < S.length; i++) {
        const sa = S[i - 1], sb = S[i], sc = S[i + 1];
        if (!sa || !sb || !sc) continue;
        if (cut.has(sa.tick) || cut.has(sb.tick) || cut.has(sc.tick)) continue;
        // 정지: 직전 틱과 같은 자리.
        if (Math.hypot(sb.ball.x - sa.ball.x, sb.ball.y - sa.ball.y) > 0.2) continue;
        const moved = Math.hypot(sc.ball.x - sb.ball.x, sc.ball.y - sb.ball.y);
        if (moved < MOVE_MIN_M) continue;
        // 멈춰 있던 그 자리에 찰 사람이 있었나?
        let nearest = Infinity;
        for (const p of sb.players) {
          const d = Math.hypot(p.pos.x - sb.ball.x, p.pos.y - sb.ball.y);
          if (d < nearest) nearest = d;
        }
        if (nearest > TOUCH_REACH_M) {
          violations.push(`seed ${seed} t=${sb.tick} 정지→${moved.toFixed(1)}m 이동, 최근접 ${nearest.toFixed(1)}m`);
        }
      }
    }
    expect(violations.length, `정지한 공이 접촉 없이 튐:\n  ${violations.slice(0, 8).join("\n  ")}`).toBe(0);
  });

  it("advanceBall: 계획 낙하점 전에는 계획 창이 열리지 않는다 (조기 판정 금지)", () => {
    // #181 원 계약("목표에 닿기 전엔 도착 아님")의 #320 판. 속도 벡터에는 "도착"이 없으므로
    // 같은 요구를 **계획 창 개시**(`passedPlan`)로 잰다 — 공이 계획 거리만큼 실제로 가기 전에는
    // 소유 판정이 열리면 안 된다(열리면 남은 거리를 소유 이전이 순간이동으로 메운다 = #181 버그).
    const pitch = createPitch(cfg);
    const scale = cfg.fixedScale;
    const speed = toFixed(cfg.ball.passSpeed, scale);
    // 낙하점까지 25m(= 18m/tick 보다 크고 2틱보다 작다).
    const ball: Ball = {
      posFx: { x: toFixed(30, scale), y: toFixed(34, scale) },
      owner: null,
      ownerSide: null,
      flight: kickBall(toFixed(30, scale), toFixed(34, scale), toFixed(55, scale), toFixed(34, scale), speed, {
        kind: "pass",
        delivery: "ground",
        fromSide: "home",
      }),
    };
    const r1 = advanceBall(ball, cfg, pitch);
    expect(r1.passedPlan, "7m 남았는데 계획 창을 열면 안 된다").toBe(false);
    expect(ball.posFx.x).toBe(toFixed(48, scale));

    const r2 = advanceBall(ball, cfg, pitch);
    // 2틱째: 계획 거리를 넘어선다 → 창이 열린다. 그리고 **낙하점에 스냅되지 않는다**(#320) —
    // 공은 속도만큼 계속 가고, 감속은 마찰이 한다(구버전은 여기서 정확히 55m 에 딱 섰다).
    expect(r2.passedPlan).toBe(true);
    expect(ball.posFx.x, "낙하점에 스냅되면 안 된다(목표점 보간 회귀)").toBeGreaterThan(toFixed(55, scale));
    expect(ball.posFx.y).toBe(toFixed(34, scale));
  });

  it("advanceBall: 스텝은 단조 감소하고 방향은 안 바뀐다 — 되올림(요동) 금지", () => {
    // hero #320 이 본 것: `12.6 → 0.9 → 3.1 → 1.9`. 마지막 스텝이 목표 스냅으로 잘리고
    // `settle()` 이 속도를 되올려 **비단조**가 됐다. 속도 벡터는 마찰 곱만 있으므로 구조적으로 불가.
    const pitch = createPitch(cfg);
    const scale = cfg.fixedScale;
    const ball: Ball = {
      posFx: { x: toFixed(20, scale), y: toFixed(34, scale) },
      owner: null,
      ownerSide: null,
      flight: kickBall(toFixed(20, scale), toFixed(34, scale), toFixed(40, scale), toFixed(34, scale), toFixed(12, scale), {
        kind: "pass",
        delivery: "ground",
        fromSide: "home",
      }),
    };
    const steps: number[] = [];
    for (let i = 0; i < 12; i++) {
      const before = { x: ball.posFx.x, y: ball.posFx.y };
      const r = advanceBall(ball, cfg, pitch);
      if (r.out) break;
      steps.push(Math.hypot(ball.posFx.x - before.x, ball.posFx.y - before.y) / scale);
      // 방향 불변: y 가 한 번도 흔들리지 않는다(마찰은 크기만 줄인다).
      expect(ball.posFx.y).toBe(toFixed(34, scale));
      if (r.stopped) break;
    }
    expect(steps.length, "여러 틱에 걸쳐 굴러야 한다").toBeGreaterThan(2);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!, `스텝이 되올랐다: ${steps.map((v) => v.toFixed(1)).join(" → ")}`)
        .toBeLessThanOrEqual(steps[i - 1]!);
    }
    // 첫 스텝은 **찬 세기 그대로**다(목표까지의 거리에 눌리지 않는다).
    expect(steps[0]).toBeCloseTo(12, 1);
  });
});
