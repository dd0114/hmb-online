import { describe, it, expect } from "vitest";
import type { MatchLog } from "@hmb/shared";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { advanceBall } from "../ball";
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
 * "누가 건드렸다"고 인정할 최대 거리(m). controlRange(공을 컨트롤할 수 있는 거리) + 한 틱 이동 여유.
 * 이 거리 밖에서 공이 꺾이면 접촉 없이 스스로 휜 것이다.
 */
const TOUCH_REACH_M = cfg.contest.controlRange + cfg.speed.maxPerTick;

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
  it("리얼 config 20시드: 빈 공간에서의 공 방향 전환이 0건", () => {
    const all: Kink[] = [];
    for (const seed of REALISM_SEEDS) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
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
    let worst = 0;
    for (const seed of REALISM_SEEDS) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
      for (const k of lonelyKinks(seed, log, 0)) worst = Math.max(worst, k.nearestM);
    }
    expect(worst, `꺾임 지점 최근접 선수 최악 거리 ${worst.toFixed(1)}m`).toBeLessThan(TOUCH_REACH_M - 1);
  });

  it("멈춰 있던 공은 사람이 와야 움직인다 — 정지→워프 금지", () => {
    // 독립 QA 지적(#181 1차 FAIL): 위 "꺾임" 계약은 **양쪽 구간 모두 3m 이상 이동**을 요구하므로
    // `정지(0m) → 워프(17m)` 패턴을 구조적으로 못 잡는다. 실제로 도착 대기 타임아웃 폴백이
    // 공을 claimant 위치로 거리 무제한 대입해, 아무도 없는 곳에 멈춰 있던 공이 다음 틱에 16~20m
    // 순간이동했다(90분 128~169회). 그 사각지대를 별도 계약으로 막는다.
    const violations: string[] = [];
    for (const seed of REALISM_SEEDS) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
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

  it("advanceBall: 목표에 실제로 닿기 전에는 도착이 아니다 (조기 도착 금지)", () => {
    const pitch = createPitch(cfg);
    const scale = cfg.fixedScale;
    const speed = toFixed(cfg.ball.passSpeed, scale);
    // 목표까지 25m(= passSpeed 18m/tick 보다 크고 2틱보다 작다).
    const ball: Ball = {
      posFx: { x: toFixed(30, scale), y: toFixed(34, scale) },
      owner: null,
      ownerSide: null,
      flight: { toX: toFixed(55, scale), toY: toFixed(34, scale), speed, kind: "pass", fromSide: "home" },
    };
    const r1 = advanceBall(ball, cfg, pitch);
    // 1틱 후: 18m 전진, 7m 남음 → 아직 도착 아님(기존 코드는 remaining<=speed 라 여기서 도착).
    expect(r1.arrived, "7m 남았는데 도착 판정하면 안 된다").toBe(false);
    expect(ball.posFx.x).toBe(toFixed(48, scale));

    const r2 = advanceBall(ball, cfg, pitch);
    // 2틱 후: 목표에 정확히 안착하고서야 도착.
    expect(r2.arrived).toBe(true);
    expect(ball.posFx.x).toBe(toFixed(55, scale));
    expect(ball.posFx.y).toBe(toFixed(34, scale));
  });
});
