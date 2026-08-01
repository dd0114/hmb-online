import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig, type EngineConfig } from "./config";
import { makeTacticalInput, makeSelectData } from "./fixtures";
import { REALISM_SEEDS } from "./realism/harness";
import type { MatchLog, TickSnapshot } from "@hmb/shared";

/**
 * #347 — **킥오프 순간 전원이 자기 진영에 있다** (IFAB Law 8).
 *
 * hero 실관전: *"처음 경기 시작 때나 골 먹혔을 때 서로 상대 진영에 배치된 게 아니라
 * **중앙부터 배치 시작**해야 돼."*
 *
 * 원인: `resetKickoff` 이 전원을 `baseFx`(오픈플레이 홈 포지션)로 되돌린다. 4-3-3 슬롯을
 * 미터로 환산하면 LW/RW 73.5m · ST **81.9m** = 상대 진영 **29.4m** 침범.
 *
 * ## 왜 기존 `kickoff.test.ts` 가 못 잡았나
 * 그 계약은 **"t0 슬롯과 골 후 킥오프 슬롯이 일치하는가"** 를 본다(0.8.0 #59 의 관심사).
 * 두 시점이 **똑같이 틀렸으면 통과한다.** 그래서 "무엇과 같은가"가 아니라 **"규칙을 지키는가"**
 * 를 보는 계약을 따로 세운다. 임계는 밸런스가 아니라 Law 라서 0 이다.
 */

const cfg = defaultEngineConfig;
/** 스냅샷은 cm 반올림이라 경계 판정에 여유 1cm. */
const EPS_M = 0.01;
const HALF = cfg.pitch.width / 2;
const CENTER = { x: HALF, y: cfg.pitch.height / 2 };

/** #347 이전 동작 — 변이체 킬 대조군. */
const legacyCfg = (): EngineConfig => ({
  ...cfg,
  setPiece: { ...cfg.setPiece, kickoff: { ...cfg.setPiece.kickoff, compress: false } },
});

function run(seed: string, config: EngineConfig): MatchLog {
  return runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), makeSelectData(), config);
}

/** 킥오프 이벤트 틱(경기 시작·후반 시작·골 후 재시작). 스로인 등은 detail 이 붙어 있어 제외. */
function kickoffTicks(log: MatchLog): number[] {
  return log.events
    .filter((e) => e.type === "kickoff" && (e.detail === undefined || e.detail === null))
    .map((e) => e.tick);
}

function snapAt(log: MatchLog, tick: number): TickSnapshot | undefined {
  return log.tickSnapshots.find((s) => s.tick === tick);
}

/** 상대 진영 침투 깊이(m). ≤0 이면 자기 진영. 홈은 +x 공격, 어웨이는 −x. */
function intrusionM(team: string, x: number): number {
  return team === "home" ? x - HALF : HALF - x;
}

interface Scan {
  kickoffs: number;
  intruders: number;
  maxIntrusionM: number;
  /** 재개팀 상대가 센터 서클(9.15m) 안에 있던 건수. */
  circleIntruders: number;
}

function scan(config: EngineConfig, seeds: string[]): Scan {
  const out: Scan = { kickoffs: 0, intruders: 0, maxIntrusionM: 0, circleIntruders: 0 };
  for (const seed of seeds) {
    const log = run(seed, config);
    for (const t of kickoffTicks(log)) {
      const s = snapAt(log, t);
      if (!s) continue;
      out.kickoffs += 1;
      const restartSide = log.events.find((e) => e.tick === t && e.type === "kickoff")?.team;
      for (const p of s.players) {
        // 재개팀 taker 는 센터 스팟에 선다(Law 8 예외) — 침범 판정에서 뺀다.
        // ⚠️ #231: `playerId` 단독 비교는 금지다. 실덱은 같은 id 가 양 팀에 동시 출전하므로
        // (라이브 51하프 중 20하프) 상대 팀 동명 선수가 **조용히 검사에서 빠진다**.
        if (p.playerId === s.ballOwner && p.team === restartSide) continue;
        const d = intrusionM(p.team, p.pos.x);
        if (d > EPS_M) {
          out.intruders += 1;
          if (d > out.maxIntrusionM) out.maxIntrusionM = d;
        }
        if (restartSide && p.team !== restartSide) {
          const dc = Math.hypot(p.pos.x - CENTER.x, p.pos.y - CENTER.y);
          if (dc < cfg.setPiece.kickoff.circleClearM - EPS_M) out.circleIntruders += 1;
        }
      }
    }
  }
  return out;
}

describe("#347 킥오프 배치 = 전원 자기 진영 (Law 8)", () => {
  const seeds = REALISM_SEEDS.slice(0, 8);
  const now = scan(cfg, seeds);

  it("킥오프 틱에 상대 진영에 선 선수가 0 명이다", () => {
    expect(now.kickoffs).toBeGreaterThan(8); // 경기 시작·후반 시작 + 골 후 재시작
    expect(now.intruders).toBe(0);
    expect(now.maxIntrusionM).toBe(0);
  });

  it("재개팀 상대가 센터 서클(9.15m) 밖에 있다", () => {
    expect(now.circleIntruders).toBe(0);
  });

  it("변이체 킬 — compress 를 끄면 상대 진영 침범이 되살아난다(ST ~29m)", () => {
    const legacy = scan(legacyCfg(), seeds);
    expect(legacy.intruders).toBeGreaterThan(0);
    expect(legacy.maxIntrusionM).toBeGreaterThan(20);
  }, 600_000);
});

/**
 * **라이브 회귀 픽스처** — 실경기 `01KYWC09NMRP6G12CF6DQ0DQ5W`(practice · qwerqew vs 블루 월)의
 * 입력 조합. main 진단(2026-08-01)이 tick0 에서 유저 3명의 침범을 실측했다:
 * **P106 +21.0m · P107 +21.0m · P108 +29.4m**(상대팀도 대칭 2명).
 *
 * ## 왜 픽스처 입력으로 끝내지 않나 (#343 픽스처 id 함정)
 * 위 계약은 `makeTacticalInput` 의 `H0..H10` 을 쓴다. 실경기 id 는 `P106` 처럼 생겼고, 접두사에
 * 기대는 코드가 있으면 픽스처 id 가 **우연히** 통과시킨다(#343 의 실적). 그래서 이 계약은
 * **실경기와 같은 모양의 id + 라이브가 실제로 보낸 basePosition** 으로 다시 세운다.
 *
 * ## 원인 확정(main 진단)
 * `basePosition` 이 AI 창작이 아니라 **엔진 4-3-3 포메이션 표 기본값 그대로**(LW/RW 0.700 ·
 * ST 0.780)였다. 즉 침범은 특정 덱의 사고가 아니라 **모든 경기의 구조적 성질**이고, 고칠 곳은
 * 입력이 아니라 **킥오프 배치의 자기 진영 클램프**다.
 */
describe("#347 라이브 회귀 — 실경기 입력 조합(01KYWC09NMRP6G12CF6DQ0DQ5W)", () => {
  /** 라이브가 실제로 보낸 4-3-3 슬롯(= `FORMATION_BASE_POSITIONS["4-3-3"]`). LW/RW 0.70 · ST 0.78. */
  const LIVE_SLOTS: { x: number; y: number }[] = [
    { x: 0.05, y: 0.5 },
    { x: 0.22, y: 0.2 }, { x: 0.16, y: 0.4 }, { x: 0.16, y: 0.6 }, { x: 0.22, y: 0.8 },
    { x: 0.44, y: 0.32 }, { x: 0.4, y: 0.5 }, { x: 0.44, y: 0.68 },
    { x: 0.7, y: 0.2 }, { x: 0.78, y: 0.5 }, { x: 0.7, y: 0.8 },
  ];

  /** 실경기 모양의 id(P###) — 픽스처 접두사 H/A 에 기대는 코드를 통과시키지 않는다(#343). */
  function liveInput(base: number, seed: string) {
    const t = makeTacticalInput(base === 100 ? "H" : "A", seed);
    return {
      ...t,
      players: t.players.map((p, i) => ({
        ...p,
        playerId: `P${base + i}`,
        basePosition: { ...LIVE_SLOTS[i]! },
      })),
    };
  }

  /** SelectData 도 같은 id 로 — roster 조회가 id 로 붙으므로 안 맞추면 능력치가 기본값으로 떨어진다. */
  function liveSelect() {
    const s = makeSelectData();
    const relabel = (roster: typeof s.home, base: number) => ({
      ...roster,
      players: roster.players.map((p, i) => ({ ...p, playerId: `P${base + i}` })),
    });
    return { home: relabel(s.home, 100), away: relabel(s.away, 200) };
  }

  it("킥오프 틱에 상대 진영에 선 선수가 0 명이다 (P106/P107/P108 이 하프라인을 안 넘는다)", () => {
    const seed = "20260801";
    const log = runMatch(seed, liveInput(100, seed), liveInput(200, seed), liveSelect(), cfg);
    const ticks = kickoffTicks(log);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      const s = snapAt(log, t)!;
      const restartSide = log.events.find((e) => e.tick === t && e.type === "kickoff")?.team;
      const bad = s.players
        // #231: taker 면제는 (team, id) 쌍으로. 실덱은 같은 id 가 양 팀에 동시 출전한다.
        .filter((p) => !(p.playerId === s.ballOwner && p.team === restartSide))
        .filter((p) => intrusionM(p.team, p.pos.x) > EPS_M)
        .map((p) => `${p.team}:${p.playerId}@${p.pos.x.toFixed(1)}`);
      expect(bad, `t${t}: ${bad.join(", ")}`).toEqual([]);
    }
  });

  it("변이체 킬 — compress 를 끄면 그 라이브 조합이 실측 침범(+21.0/+21.0/+29.4m)을 재현한다", () => {
    const seed = "20260801";
    const log = runMatch(seed, liveInput(100, seed), liveInput(200, seed), liveSelect(), legacyCfg());
    const s = snapAt(log, kickoffTicks(log)[0]!)!;
    const byId = new Map(s.players.filter((p) => p.team === "home").map((p) => [p.playerId, p]));
    // 슬롯 8/9/10 = LW/ST/RW → P108/P109/P110. main 진단의 P106/P107/P108 과 번호 기준만 다르고
    // (그쪽 로스터의 슬롯 오프셋), **침범 미터는 슬롯이 정하므로 동일**하다: 0.70→+21.0 · 0.78→+29.4.
    const lw = intrusionM("home", byId.get("P108")!.pos.x);
    const st = intrusionM("home", byId.get("P109")!.pos.x);
    const rw = intrusionM("home", byId.get("P110")!.pos.x);
    expect(lw).toBeCloseTo(21.0, 1);
    expect(st).toBeCloseTo(29.4, 1);
    expect(rw).toBeCloseTo(21.0, 1);
  });
});
