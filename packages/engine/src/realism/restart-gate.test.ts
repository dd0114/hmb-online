import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { measureDeadBallMotion } from "./deadball-motion";
import { createPitch } from "../pitch";
import { freeKickWallCount } from "../setpiece";
import type { MatchLog, TacticalInput } from "@hmb/shared";

/**
 * #378 — **유동 재시작**: 정지 길이가 "무엇을 기다리는가"의 함수다.
 *
 * hero: *"진짜 축구처럼 볼을 준비하고 심판이 휘슬을 불면 선수들이 **자리를 찾기 전에도 진행 가능**하고,
 * 선수들도 **위치 찾아가면서 판단**하면서 진행하고 싶어. 1에서 말한 상황은 심판이 프리킥 벽 세울
 * 때까지 기다려야 돼. 골킥은 자기팀 선수들이 앞으로 나갈 때까지 기다려도 돼."*
 *
 * 구 동작: 정지 하한이 스로인/골킥 **12틱** · 프리킥 **8틱**(+벽이면 6틱)이고, 그 위에 taker 도보
 * 시간이 얹혔다. 즉 재개 시점을 정하는 것이 전술이 아니라 **taker 가 우연히 얼마나 멀리 있었나**였고,
 * 그 하한이 곧 "전원이 자리 잡을 시간"이다.
 *
 * ## 계약이 재는 것 — "짧아졌다"가 아니라 **"자리 잡기 전에 진행된다"**
 * 정지 틱만 재면 노브를 줄인 것과 구분이 안 된다. hero 가 요구한 것은 **재개 순간에 아직 걸어가는
 * 중인 선수가 있다**는 성질이고, 그건 재개 틱의 **도착률**로 직접 잰다.
 */

const seeds = REALISM_SEEDS.slice(0, 8);
const select = makeSelectData();

/** #378 이전 동작(롤백 스위치) — 변이체 킬 대조군. */
const legacyCfg = (): EngineConfig => ({
  ...defaultEngineConfig,
  rules: {
    ...defaultEngineConfig.rules,
    restart: {
      ...defaultEngineConfig.rules.restart,
      gate: { ...defaultEngineConfig.rules.restart.gate, enabled: false },
    },
  },
});

/** 팀 전원의 `passDirectness` 를 세팅한 입력 — 골킥 게이트가 팀 지시로 갈리는지 보는 데 쓴다. */
function withDirectness(t: TacticalInput, v: number): TacticalInput {
  return { ...t, players: t.players.map((p) => ({ ...p, behavior: { ...p.behavior, passDirectness: v } })) };
}

interface Scan {
  /** 재시작 종류별 [정지 창 길이 합, 건수]. 창 = 재시작 이벤트 → 공이 스팟을 떠난 틱. */
  span: Record<string, { sum: number; n: number }>;
  /**
   * 재개 틱에 **아직 움직이고 있던** 선수 비율(%) — 직전 틱 대비 0.3m 초과 이동.
   * (초판 주석은 "목표에 도착하지 못한"이라고 적었는데 그건 다른 양이다 — 독립검증 m6 정정.)
   */
  movingAtResumePct: number;
  /** 재개 자체가 일어난 건수(데드락 감시). */
  resumes: number;
}

/** 재시작 이벤트 → 공이 스팟을 떠난 틱까지의 창. 스냅샷만으로 관측 가능한 신호만 쓴다. */
function scanLog(log: MatchLog): Scan {
  const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
  const out: Scan = { span: {}, movingAtResumePct: 0, resumes: 0 };
  let movingSum = 0;
  let movingN = 0;
  for (const e of log.events) {
    if (e.type !== "kickoff" && e.type !== "free_kick") continue;
    const kind = e.type === "free_kick" ? "free_kick" : (e.detail ?? "kickoff");
    if (kind === "kickoff" || kind === "corner") continue; // 게이트 밖
    const s0 = byTick.get(e.tick);
    if (!s0) continue;
    const spot = { x: s0.ball.x, y: s0.ball.y };
    let leave = -1;
    for (let t = e.tick + 1; t <= e.tick + 60; t++) {
      const s = byTick.get(t);
      if (!s) break;
      if (Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) > 1.0) {
        leave = t;
        break;
      }
    }
    if (leave < 0) continue; // 창이 안 닫혔다 = 이 표본은 버린다(데드락은 아래 resumes 로 본다)
    out.resumes += 1;
    const bucket = (out.span[kind] ??= { sum: 0, n: 0 });
    bucket.sum += leave - e.tick;
    bucket.n += 1;
    // 재개 직전 틱 대비 재개 틱에 **움직이고 있던** 선수 비율 = 아직 자리를 잡는 중이다.
    const a = byTick.get(leave - 1);
    const b = byTick.get(leave);
    if (a && b) {
      const prev = new Map(a.players.map((p) => [`${p.team}:${p.playerId}`, p.pos]));
      let moving = 0;
      let n = 0;
      for (const p of b.players) {
        const q = prev.get(`${p.team}:${p.playerId}`);
        if (!q) continue;
        n += 1;
        if (Math.hypot(p.pos.x - q.x, p.pos.y - q.y) > 0.3) moving += 1;
      }
      if (n > 0) {
        movingSum += (moving / n) * 100;
        movingN += 1;
      }
    }
  }
  out.movingAtResumePct = movingN > 0 ? movingSum / movingN : 0;
  return out;
}

function scan(config: EngineConfig, patch?: (t: TacticalInput) => TacticalInput): Scan {
  const acc: Scan = { span: {}, movingAtResumePct: 0, resumes: 0 };
  let sum = 0;
  let n = 0;
  for (const seed of seeds) {
    const h = patch ? patch(makeTacticalInput("H", seed)) : makeTacticalInput("H", seed);
    const a = patch ? patch(makeTacticalInput("A", seed)) : makeTacticalInput("A", seed);
    const r = scanLog(runMatch(seed, h, a, select, config));
    acc.resumes += r.resumes;
    for (const [k, v] of Object.entries(r.span)) {
      const b = (acc.span[k] ??= { sum: 0, n: 0 });
      b.sum += v.sum;
      b.n += v.n;
    }
    sum += r.movingAtResumePct;
    n += 1;
  }
  acc.movingAtResumePct = n > 0 ? sum / n : 0;
  return acc;
}

/** 벽을 부르는 프리킥만의 평균 정지 창. `wallFk`/`noWallFk` 는 스팟에서 매핑으로 가른다. */
function fkSpanBy(config: EngineConfig, wantWall: boolean): number {
  const pitch = createPitch(config);
  let sum = 0;
  let n = 0;
  for (const seed of seeds) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
    for (const e of log.events) {
      if (e.type !== "free_kick" || !e.team) continue;
      const s0 = byTick.get(e.tick);
      if (!s0) continue;
      const wall =
        freeKickWallCount(
          pitch,
          config,
          e.team,
          Math.round(s0.ball.x * config.fixedScale),
          Math.round(s0.ball.y * config.fixedScale),
        ) > 0;
      if (wall !== wantWall) continue;
      for (let t = e.tick + 1; t <= e.tick + 60; t++) {
        const s = byTick.get(t);
        if (!s) break;
        if (Math.hypot(s.ball.x - s0.ball.x, s.ball.y - s0.ball.y) > 1) {
          sum += t - e.tick;
          n += 1;
          break;
        }
      }
    }
  }
  return n > 0 ? sum / n : 0;
}
const wallFkSpan = (c: EngineConfig) => fkSpanBy(c, true);
const noWallFkSpan = (c: EngineConfig) => fkSpanBy(c, false);

const mean = (s: Scan, k: string): number => {
  const b = s.span[k];
  return b && b.n > 0 ? b.sum / b.n : 0;
};

const now = scan(defaultEngineConfig);
const legacy = scan(legacyCfg());

describe("#378 재개 게이트 — 정지 길이가 '무엇을 기다리는가'의 함수다", () => {
  it("스로인이 빨라진다 (quick — Law 15)", () => {
    // eslint-disable-next-line no-console
    console.log(
      `\n[#378] 정지 창(틱)  스로인 ${mean(legacy, "throw_in").toFixed(1)} → ${mean(now, "throw_in").toFixed(1)}` +
        ` · 골킥 ${mean(legacy, "goal_kick").toFixed(1)} → ${mean(now, "goal_kick").toFixed(1)}` +
        ` · 프리킥 ${mean(legacy, "free_kick").toFixed(1)} → ${mean(now, "free_kick").toFixed(1)}` +
        ` | 재개 틱 이동중 ${legacy.movingAtResumePct.toFixed(1)}% → ${now.movingAtResumePct.toFixed(1)}%\n`,
    );
    expect(mean(now, "throw_in")).toBeLessThan(mean(legacy, "throw_in"));
  });

  it("**자리를 찾기 전에 진행된다** — 재개 틱에 아직 움직이는 중인 선수가 늘어난다", () => {
    // hero 요구의 직접 지표. "정지가 짧아졌다"만으로는 노브를 줄인 것과 구분이 안 된다.
    expect(now.movingAtResumePct).toBeGreaterThan(legacy.movingAtResumePct);
  });

  it("벽 프리킥은 여전히 기다린다 (ceremonial — hero 명시 요구)", () => {
    // ⚠️ 초판 단언은 `> 0` 뿐이라 **벽 프리킥을 전부 quick 으로 바꿔도 통과**했다(독립검증 m1).
    // 헤드라인 AC 에 실질 가드가 없었던 것이라, 구 동작과의 **동등성**으로 바꾼다.
    const wallNow = wallFkSpan(defaultEngineConfig);
    const wallLegacy = wallFkSpan(legacyCfg());
    // 절대 동일을 요구하지 않는다 — 게이트가 다른 재시작을 바꾸면 **전개가 달라져** 표본에 담기는
    // 벽 프리킥 자체가 달라지기 때문이다. 요구는 "벽 프리킥의 정지가 짧아지지 않았다"이므로
    // 상대 오차로 건다(실측 15.05 vs 14.99 = 0.4%).
    const rel = Math.abs(wallNow - wallLegacy) / Math.max(1, wallLegacy);
    expect(rel, `벽FK 현재 ${wallNow.toFixed(2)} vs 구동작 ${wallLegacy.toFixed(2)}`).toBeLessThan(0.05);
    // 그리고 **빠른 재개보다 확실히 길다** — 이게 "벽만 심판 대기"의 실질 내용이다.
    expect(wallNow, `벽FK ${wallNow.toFixed(2)} vs 사거리밖FK ${noWallFkSpan(defaultEngineConfig).toFixed(2)}`)
      .toBeGreaterThan(noWallFkSpan(defaultEngineConfig) * 1.5);
  });

  it("롤백 등가 — gate.enabled=false 는 게이트 도입 **이전과 같은 정지 길이**다", () => {
    // ⚠️ 독립검증 B2: 초판은 `legacyBase(..., true)` 를 상수로 넘겨 **사거리 밖 프리킥이 8 → 14틱**
    // 이 됐다 = 롤백 스위치가 0.32.0 이 아니었고, 이 파일의 모든 관계식이 부풀려진 baseline 위에
    // 걸려 있었다. 그 부류를 다시 놓치지 않게 **구 공식을 여기서 직접 재현해** 비교한다.
    const legacy = legacyCfg();
    const expected =
      legacy.rules.freeKickStoppageTicks + legacy.setPiece.freeKick.wallSetupTicks; // 벽 프리킥
    const expectedNoWall = legacy.rules.freeKickStoppageTicks; // 사거리 밖 = 벽 가산 없음
    expect(wallFkSpan(legacy)).toBeGreaterThanOrEqual(expected);
    // 사거리 밖 프리킥이 벽 가산을 받으면 안 된다 — 그게 B2 의 지문이다.
    expect(noWallFkSpan(legacy), `사거리밖FK(롤백) ${noWallFkSpan(legacy).toFixed(2)}`).toBeLessThan(
      expected,
    );
    expect(noWallFkSpan(legacy)).toBeGreaterThanOrEqual(expectedNoWall - 1);
  }, 600_000);

  it("데드락 없음 — 재개가 실제로 일어난다(경기당 ≥ 5건)", () => {
    expect(now.resumes / seeds.length).toBeGreaterThanOrEqual(5);
  });

  it("변이체 킬 — gate.enabled=false 면 구 동작(전부 기다린다)으로 돌아간다", () => {
    expect(mean(now, "throw_in")).not.toBe(mean(legacy, "throw_in"));
  });
});

describe("#378 골킥 게이트를 **팀 지시**가 정한다 (죽어 있던 입력이 또 하나 산다)", () => {
  it("다이렉트 성향이 높으면 골킥이 길어진다(teamShape = 전원 전진 후 롱볼)", () => {
    const direct = scan(defaultEngineConfig, (t) => withDirectness(t, 1));
    const short = scan(defaultEngineConfig, (t) => withDirectness(t, 0));
    const d = mean(direct, "goal_kick");
    const s = mean(short, "goal_kick");
    expect(d, `direct ${d.toFixed(1)} vs short ${s.toFixed(1)}`).toBeGreaterThan(s);
  }, 600_000);
});

describe("#378 정지 중 움직임 품질이 회귀하지 않는다 (#185/#174)", () => {
  it("데드볼 왕복·단독질주가 구 동작보다 나빠지지 않는다", () => {
    // 정지 창이 짧아지면 "굳는 프레임"은 줄지만 왕복이 늘 수도 있다(0.25.0 목표 램프 전례).
    // 절대 임계가 아니라 **구 동작 대조군 관계식**으로 건다.
    const m = (config: EngineConfig) => {
      let jit = 0;
      let lone = 0;
      let n = 0;
      for (const seed of seeds.slice(0, 4)) {
        const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
        const r = measureDeadBallMotion(log);
        jit += r.jitterPer100;
        lone += r.loneSprintPer100;
        n += 1;
      }
      return { jit: jit / n, lone: lone / n };
    };
    const a = m(defaultEngineConfig);
    const b = m(legacyCfg());
    // eslint-disable-next-line no-console
    console.log(`\n[#378] 데드볼 움직임  왕복 ${b.jit.toFixed(2)} → ${a.jit.toFixed(2)} · 단독질주 ${b.lone.toFixed(2)} → ${a.lone.toFixed(2)}\n`);
    expect(a.jit, `왕복 ${a.jit.toFixed(2)} vs 구동작 ${b.jit.toFixed(2)}`).toBeLessThanOrEqual(b.jit + 0.5);
    expect(a.lone, `단독질주 ${a.lone.toFixed(2)} vs 구동작 ${b.lone.toFixed(2)}`).toBeLessThanOrEqual(b.lone + 0.5);
  }, 600_000);
});
