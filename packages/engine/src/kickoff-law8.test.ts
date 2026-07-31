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
        if (p.playerId === s.ballOwner) continue;
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
