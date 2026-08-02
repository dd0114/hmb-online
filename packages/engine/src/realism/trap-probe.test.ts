import { describe, it } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS, GUARD_SEEDS } from "./harness";
import { measureTrap, measureTrapFire, measureDeadStops, trapOn, withLine, sampleSd, type TrapMeasure } from "./trap";
import type { TacticalInput as TrapPatchT } from "@hmb/shared";

/**
 * #377 S3-C **자[尺] 검정 프로브**(진단 전용, 옵트인 `HMB_S3C=1`).
 *
 * 계약이 아니다 — "무엇으로 트랩을 잴 것인가"를 **실측으로 고르기 위한** 하네스다.
 * 신호가 없는 자는 계약에 넣지 않는다(S3-A·S3-B 선례).
 */

const ON = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_S3C === "1";
const d = ON ? describe : describe.skip;

function cfg(mut: (c: EngineConfig) => void): EngineConfig {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  mut(c);
  return c;
}
function line(label: string, m: TrapMeasure): string {
  const b = m.both;
  return [
    label.padEnd(26),
    `caught ${b.caughtMean.toFixed(3)}`,
    `caught% ${b.caughtPct.toFixed(1)}`,
    `depth ${b.caughtDepthM.toFixed(2)}`,
    `burst% ${b.burstPct.toFixed(2)}`,
    `sync% ${b.syncFwdPct.toFixed(2)}`,
    `line ${b.lineMeanM.toFixed(2)}`,
    `behind% ${b.behindLineOwnPct.toFixed(2)}`,
    `bGoalD ${b.behindLineGoalDistM.toFixed(1)}`,
    `1v1 ${(m.oneOnOneHome + m.oneOnOneAway).toFixed(2)}`,
    `ofs ${m.offsidesPerMatch.toFixed(2)}`,
    `goal ${m.goalsPerMatch.toFixed(2)}`,
    `shot ${m.shotsPerTeam.toFixed(2)}`,
  ].join("  ");
}
/* eslint-disable no-console */
function log(s: string): void {
  console.log(s);
}

const S8 = REALISM_SEEDS.slice(0, 8);
const S20 = REALISM_SEEDS;
const S60 = GUARD_SEEDS;

d("S3-C 자 검정 ① 노이즈 바닥", () => {
  it("20시드 / 60시드 · 시드별 산포", () => {
    const m20 = measureTrap(defaultEngineConfig, S20);
    const m60 = measureTrap(defaultEngineConfig, S60);
    log(line("base n20", m20));
    log(line("base n60", m60));
    const sd20 = sampleSd(m20.offsidesPerSeed);
    const sd60 = sampleSd(m60.offsidesPerSeed);
    log(`  offsides/seed: n20 mean ${m20.offsidesPerMatch.toFixed(3)} sd ${sd20.toFixed(3)} se ${(sd20 / Math.sqrt(20)).toFixed(3)}`);
    log(`  offsides/seed: n60 mean ${m60.offsidesPerMatch.toFixed(3)} sd ${sd60.toFixed(3)} se ${(sd60 / Math.sqrt(60)).toFixed(3)}`);
    log(`  n20 seeds: ${m20.offsidesPerSeed.join(",")}`);
    const halfA = measureTrap(defaultEngineConfig, S20.slice(0, 10));
    const halfB = measureTrap(defaultEngineConfig, S20.slice(10));
    log(line("  half A (n10)", halfA));
    log(line("  half B (n10)", halfB));
  }, 1_800_000);
});

d("S3-C 자 검정 ② 플라시보 — 심판 노브만 움직인다", () => {
  it("trapBiasM · trapCallMult 사다리(트랩 ON, 양 팀)", () => {
    for (const bias of [0, 2.5, 6, 10]) {
      const c = cfg((x) => { x.rules.offside.trapBiasM = bias; });
      log(line(`trapBiasM=${bias}`, measureTrap(c, S20, trapOn("both"))));
    }
    for (const mult of [1, 1.8, 4]) {
      const c = cfg((x) => { x.rules.offside.trapCallMult = mult; });
      log(line(`trapCallMult=${mult}`, measureTrap(c, S20, trapOn("both"))));
    }
    log(line("trap OFF (both)", measureTrap(defaultEngineConfig, S20)));
  }, 1_800_000);
});

d("S3-C 자 검정 ③ 용량–반응 — 위치 레버", () => {
  it("defensiveLineHeight 사다리", () => {
    for (const v of [0.2, 0.35, 0.55, 0.75, 0.9]) {
      log(line(`lineHeight=${v}`, measureTrap(defaultEngineConfig, S20, (t) => withLine(v)(t))));
    }
  }, 1_800_000);

  it("heightRangeX 사다리", () => {
    for (const v of [0.2, 0.35, 0.5, 0.7]) {
      const c = cfg((x) => { x.movement.defLine.heightRangeX = v; });
      log(line(`heightRangeX=${v}`, measureTrap(c, S20)));
    }
  }, 1_800_000);

  it("lineDiscipline 사다리", () => {
    for (const v of [0, 0.35, 0.65, 1.0]) {
      const c = cfg((x) => { x.movement.lineDiscipline = v; });
      log(line(`lineDiscipline=${v}`, measureTrap(c, S20)));
    }
  }, 1_800_000);
});

d("S3-C 자 검정 ④ 비대칭 대조(같은 경기 안)", () => {
  it("home 만 트랩 ON — 심판 노브 기준선", () => {
    const c = cfg((x) => { x.rules.offside.trapBiasM = 10; });
    const m = measureTrap(c, S20, trapOn("home"));
    log(`asym trapBiasM=10: ofsAgainstHome ${m.offsidesAgainstHome.toFixed(2)} ofsAgainstAway ${m.offsidesAgainstAway.toFixed(2)}`);
    log(`  home(def) caught ${m.home.caughtMean.toFixed(3)} burst% ${m.home.burstPct.toFixed(2)} behind% ${m.home.behindLineOwnPct.toFixed(2)} line ${m.home.lineMeanM.toFixed(2)}`);
    log(`  away(def) caught ${m.away.caughtMean.toFixed(3)} burst% ${m.away.burstPct.toFixed(2)} behind% ${m.away.behindLineOwnPct.toFixed(2)} line ${m.away.lineMeanM.toFixed(2)}`);
  }, 1_800_000);
});

d("S3-C 자 검정 ⑥ 트랩 기회 사이징 + 급정지 축", () => {
  it("어깨 밴드 점유 · 무소유 급정지(#399 축)", () => {
    const arms: [string, EngineConfig, ((t: TrapPatchT, s: "home" | "away") => TrapPatchT) | undefined][] = [
      ["base", defaultEngineConfig, undefined],
      ["lineHeight=0.75", defaultEngineConfig, (t) => withLine(0.75)(t)],
      ["lineHeight=0.9", defaultEngineConfig, (t) => withLine(0.9)(t)],
      ["trapON(referee only)", defaultEngineConfig, trapOn("both")],
    ];
    for (const [label, c, p] of arms) {
      const m = measureTrap(c, S20, p);
      const b = m.both;
      log(
        `${label.padEnd(22)} shoulder%[2/4/6] ${b.shoulderPct.map((x) => x.toFixed(1)).join("/")}` +
          `  shoulderN ${b.shoulderMean.map((x) => x.toFixed(3)).join("/")}` +
          `  caught ${b.caughtMean.toFixed(3)}  behind% ${b.behindLineOwnPct.toFixed(2)}`,
      );
    }
    log(`  deadStops(8seed, base) ${measureDeadStops(defaultEngineConfig, REALISM_SEEDS.slice(0, 8)).toFixed(2)}  <-- ball-physics 계약값과 일치해야 한다`);
    log(`  deadStops(8seed, lineHeight=0.75) ${measureDeadStops(defaultEngineConfig, REALISM_SEEDS.slice(0, 8), (t) => withLine(0.75)(t)).toFixed(2)}`);
    log(`  deadStops(8seed, lineHeight=0.9) ${measureDeadStops(defaultEngineConfig, REALISM_SEEDS.slice(0, 8), (t) => withLine(0.9)(t)).toFixed(2)}`);
    log(`  deadStops(20seed, base) ${measureDeadStops(defaultEngineConfig, S20).toFixed(2)}`);
    log(`  deadStops(20seed, lineHeight=0.9) ${measureDeadStops(defaultEngineConfig, S20, (t) => withLine(0.9)(t)).toFixed(2)}`);
  }, 1_800_000);
});

d("S3-C 자 검정 ⑤ 8시드 스모크", () => {
  it("타이밍 확인", () => {
    const t0 = Date.now();
    log(line("base n8", measureTrap(defaultEngineConfig, S8)));
    log(`  elapsed ${Date.now() - t0}ms`);
  }, 1_800_000);
});

d("S3-C 자 검정 ⑦ 트리거 설계 표", () => {
  it("위험거리 버킷별 어깨·잡힘·뚫림", () => {
    for (const [label, p] of [
      ["base", undefined],
      ["lineHeight=0.9", ((t: TrapPatchT) => withLine(0.9)(t))],
    ] as [string, undefined | ((t: TrapPatchT, s: "home" | "away") => TrapPatchT)][]) {
      const b = measureTrap(defaultEngineConfig, S20, p).both;
      log(`${label} — 버킷[<25m, 25-40, 40-60, >60m]`);
      b.byDanger.forEach((x, i) => {
        const name = ["<25m", "25-40m", "40-60m", ">60m"][i];
        log(`   ${name!.padEnd(7)} tick% ${x.tickPct.toFixed(1).padStart(5)}  shoulder4 ${x.shoulder4.toFixed(3)}  caught ${x.caught.toFixed(3)}  behind% ${x.behindPct.toFixed(2)}`);
      });
    }
  }, 1_800_000);
});

d("S3-C 구현 후 ⑧ 발화 · 효과 · 대가", () => {
  it("트랩 ON(양팀) vs OFF · 사다리", () => {
    const f = measureTrapFire(defaultEngineConfig, S20, trapOn("both"));
    log(`fire: ${f.firePct.toFixed(2)}%  bias(fired) ${f.biasWhenFiredM.toFixed(2)}m  bias(all) ${f.biasAllTicksM.toFixed(3)}m  max ${f.biasMaxM.toFixed(2)}m  runLen ${f.runLenMeanTicks.toFixed(2)}tick  toggles/100 ${f.togglesPer100.toFixed(2)}`);
    log(line("trap OFF", measureTrap(defaultEngineConfig, S20)));
    log(line("trap ON", measureTrap(defaultEngineConfig, S20, trapOn("both"))));
    for (const v of [0, 1, 2.5, 4, 6]) {
      const c = cfg((x) => { x.movement.defLine.trap.stepUpM = v; });
      log(line(`stepUpM=${v}`, measureTrap(c, S20, trapOn("both"))));
    }
  }, 1_800_000);

  it("거리 게이트 사다리 + 급정지 축", () => {
    for (const v of [0, 20, 35, 50]) {
      const c = cfg((x) => { x.movement.defLine.trap.minBallDistM = v; });
      log(line(`minBallDistM=${v}`, measureTrap(c, S20, trapOn("both"))));
    }
    log(`  deadStops(8, OFF) ${measureDeadStops(defaultEngineConfig, REALISM_SEEDS.slice(0, 8)).toFixed(2)}`);
    log(`  deadStops(8, ON)  ${measureDeadStops(defaultEngineConfig, REALISM_SEEDS.slice(0, 8), trapOn("both")).toFixed(2)}`);
    log(`  deadStops(20, OFF) ${measureDeadStops(defaultEngineConfig, S20).toFixed(2)}`);
    log(`  deadStops(20, ON)  ${measureDeadStops(defaultEngineConfig, S20, trapOn("both")).toFixed(2)}`);
  }, 1_800_000);

  it("버킷별 — 위험지역에서 안 걸리는가", () => {
    for (const [label, p] of [["OFF", undefined], ["ON", trapOn("both")]] as [string, undefined | ((t: TrapPatchT, s: "home" | "away") => TrapPatchT)][]) {
      const b = measureTrap(defaultEngineConfig, S20, p).both;
      log(`${label}: ` + b.byDanger.map((x, i) => `${["<25", "25-40", "40-60", ">60"][i]} caught ${x.caught.toFixed(3)}/behind ${x.behindPct.toFixed(2)}`).join("  |  "));
    }
  }, 1_800_000);
});

d("S3-C 결정적 측정 ⑨ — 프론티어(트랩 ON 안에서) · n60", () => {
  it("플라시보 vs 트랩 vs blanket, 같은 레짐(trapOn) 60시드", () => {
    const arms: [string, EngineConfig][] = [
      ["placebo(stepUp=0)", cfg((x) => { x.movement.defLine.trap.stepUpM = 0; })],
      ["trap stepUp=2.5", defaultEngineConfig],
      ["trap stepUp=6", cfg((x) => { x.movement.defLine.trap.stepUpM = 6; })],
      ["blanket hRX=0.40", cfg((x) => { x.movement.defLine.trap.stepUpM = 0; x.movement.defLine.heightRangeX = 0.40; })],
      ["blanket hRX=0.45", cfg((x) => { x.movement.defLine.trap.stepUpM = 0; x.movement.defLine.heightRangeX = 0.45; })],
      ["blanket hRX=0.55", cfg((x) => { x.movement.defLine.trap.stepUpM = 0; x.movement.defLine.heightRangeX = 0.55; })],
    ];
    for (const [label, c] of arms) {
      const m = measureTrap(c, S60, trapOn("both"));
      const b = m.both;
      log(
        `${label.padEnd(20)} line ${b.lineMeanM.toFixed(3)}  caught ${b.caughtMean.toFixed(4)}  behind% ${b.behindLineOwnPct.toFixed(3)}` +
          `  eff ${(b.caughtMean / b.behindLineOwnPct).toFixed(5)}  flick/100 ${b.lineFlickerPer100.toFixed(2)}  step ${b.lineStepAbsM.toFixed(3)}` +
          `  ofs ${m.offsidesPerMatch.toFixed(2)}  goal ${m.goalsPerMatch.toFixed(2)}  1v1 ${(m.oneOnOneHome + m.oneOnOneAway).toFixed(2)}`,
      );
    }
  }, 3_600_000);
});

d("S3-C 결정적 측정 ⑩ — 사다리 · 프론티어 · 버킷 · 플리커 (n60, 전부 trapOn 레짐)", () => {
  it("전 팔", () => {
    const arms: [string, EngineConfig, ((t: TrapPatchT, s: "home" | "away") => TrapPatchT)][] = [
      ["placebo stepUp=0", cfg((x) => { x.movement.defLine.trap.stepUpM = 0; }), trapOn("both")],
      ["trap stepUp=1", cfg((x) => { x.movement.defLine.trap.stepUpM = 1; }), trapOn("both")],
      ["trap stepUp=2.5", defaultEngineConfig, trapOn("both")],
      ["trap stepUp=4", cfg((x) => { x.movement.defLine.trap.stepUpM = 4; }), trapOn("both")],
      ["trap stepUp=6", cfg((x) => { x.movement.defLine.trap.stepUpM = 6; }), trapOn("both")],
      ["blanket lineH=0.60", cfg((x) => { x.movement.defLine.trap.stepUpM = 0; }), (t, s) => withLine(0.6)(trapOn("both")(t, s))],
      ["blanket lineH=0.65", cfg((x) => { x.movement.defLine.trap.stepUpM = 0; }), (t, s) => withLine(0.65)(trapOn("both")(t, s))],
      ["blanket lineH=0.75", cfg((x) => { x.movement.defLine.trap.stepUpM = 0; }), (t, s) => withLine(0.75)(trapOn("both")(t, s))],
    ];
    for (const [label, c, p] of arms) {
      const m = measureTrap(c, S60, p);
      const b = m.both;
      log(
        `${label.padEnd(20)} line ${b.lineMeanM.toFixed(3)}  caught ${b.caughtMean.toFixed(4)}  behind% ${b.behindLineOwnPct.toFixed(3)}` +
          `  flick/100 ${b.lineFlickerPer100.toFixed(3)}  step ${b.lineStepAbsM.toFixed(4)}  ofs ${m.offsidesPerMatch.toFixed(2)}  goal ${m.goalsPerMatch.toFixed(2)}  1v1 ${(m.oneOnOneHome + m.oneOnOneAway).toFixed(2)}  shot ${m.shotsPerTeam.toFixed(2)}`,
      );
      log(`     버킷: ` + b.byDanger.map((x, i) => `${["<25", "25-40", "40-60", ">60"][i]} c${x.caught.toFixed(3)}/b${x.behindPct.toFixed(2)}`).join("  "));
    }
  }, 3_600_000);
});

d("S3-C 진단 ⑪ — 왜 프론티어를 못 이기나 (아블레이션, n60)", () => {
  it("어깨 게이트 · 거리 게이트 아블레이션", () => {
    const arms: [string, EngineConfig][] = [
      ["placebo stepUp=0", cfg((x) => { x.movement.defLine.trap.stepUpM = 0; })],
      ["출하 (band4, min1, d35)", defaultEngineConfig],
      ["어깨게이트 off (min0)", cfg((x) => { x.movement.defLine.trap.minShoulder = 0; })],
      ["어깨 넓게 (band8)", cfg((x) => { x.movement.defLine.trap.shoulderBandM = 8; })],
      ["거리 45 + min0", cfg((x) => { x.movement.defLine.trap.minShoulder = 0; x.movement.defLine.trap.minBallDistM = 45; })],
      ["거리 55 + min0", cfg((x) => { x.movement.defLine.trap.minShoulder = 0; x.movement.defLine.trap.minBallDistM = 55; })],
    ];
    for (const [label, c] of arms) {
      const f = measureTrapFire(c, S20, trapOn("both"));
      const m = measureTrap(c, S60, trapOn("both"));
      const b = m.both;
      log(
        `${label.padEnd(24)} fire ${f.firePct.toFixed(1)}%  runLen ${f.runLenMeanTicks.toFixed(2)}  line ${b.lineMeanM.toFixed(3)}  caught ${b.caughtMean.toFixed(4)}  behind% ${b.behindLineOwnPct.toFixed(3)}  <25b ${b.byDanger[0]!.behindPct.toFixed(2)}  flick/100 ${b.lineFlickerPer100.toFixed(3)}  ofs ${m.offsidesPerMatch.toFixed(2)}  goal ${m.goalsPerMatch.toFixed(2)}`,
      );
    }
  }, 3_600_000);
});
