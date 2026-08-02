/**
 * #377 S3-C 관전 증거 생성기 (오프사이드 트랩 — 로드맵 W5-3).
 *
 * 실행: `npx tsx evidence/377/gen-s3c.ts`
 * 산출: evidence/377/s3c-{on,off}.json — **같은 시드, 트랩만 on/off**. 나란히 본다.
 *      (표·타임스탬프는 stdout — evidence/377/S3-C.md 의 수치가 이 출력이다)
 *
 * ## ⚠️ 두 팔은 config 가 아니라 **전술 지시**로 가른다
 * 이 웨이브의 기제는 `team.offsideTrap` 이 켜져야만 발화한다(출하 픽스처는 off). 그래서
 * on/off 를 config 로 만들면 "출하 config 밖에서만 보이는 효과"가 되고, 그건 이 트랙이 금지한
 * 것이다. 여기서는 **같은 출하 config + 전술 지시만 다르게** 두 경기를 굽는다 — 유저/AI 가
 * 실제로 하는 그 조작이다.
 *
 * ## 계량은 계약과 **같은 함수**로 한다
 * `packages/engine/src/realism/trap.ts` 를 그대로 쓴다(계약 `offside-trap.test.ts` 와 공유).
 * 발화 판정은 엔진 관측자(`setDefShapeObserver` → `trapBiasFx`)가 준 라벨이다 — 좌표로
 * "이 틱에 트랩이 걸렸나"를 되추론하지 않는다(#378 의 가짜 위반 566건).
 *
 * ## ⚠️ 이 증거는 **자기 주장 하나를 반증한다**
 * 스코프의 비동어반복 앵커였던 T3(*"트랩이 무차별 라인 상향보다 위험 대비 효율이 높다"*)는
 * 60시드에서 **실패했다**. A4 가 그 표다 — 계수를 지표에 맞추지 않고 반증을 그대로 싣는다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog, TacticalInput } from "@hmb/shared";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config.ts";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures.ts";
import { setDefShapeObserver, type DefShapeSample } from "../../packages/engine/src/action.ts";
import {
  measureTrap,
  measureTrapFire,
  measureRefereeLineMismatch,
  measureDeadStops,
  trapOn,
  withLine,
} from "../../packages/engine/src/realism/trap.ts";
import { REALISM_SEEDS, GUARD_SEEDS } from "../../packages/engine/src/realism/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = REALISM_SEEDS[0]!;
const S8 = REALISM_SEEDS.slice(0, 8);
const S20 = REALISM_SEEDS;
const S60 = GUARD_SEEDS;
const select = makeSelectData();
const cfg = defaultEngineConfig;
const ON = trapOn("both");

const patch = (mut: (c: EngineConfig) => void): EngineConfig => {
  const c = JSON.parse(JSON.stringify(cfg)) as EngineConfig;
  mut(c);
  return c;
};
const PLACEBO = patch((c) => { c.movement.defLine.trap.stepUpM = 0; });

const f = (v: number, d = 2): string => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
const disp = (tick: number): string => {
  const scale = (cfg.displayMinutes ?? cfg.matchMinutes) / cfg.matchMinutes;
  const sec = Math.round(((tick * cfg.msPerTick) / 1000) * scale);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

const trapPatch = (t: TacticalInput): TacticalInput => ({ ...t, team: { ...t.team, offsideTrap: true } });

const bake = (name: string, on: boolean): MatchLog => {
  const h = makeTacticalInput("H", SEED);
  const a = makeTacticalInput("A", SEED);
  const log = runMatch(SEED, on ? trapPatch(h) : h, on ? trapPatch(a) : a, select, cfg);
  writeFileSync(join(here, `s3c-${name}.json`), JSON.stringify(log));
  return log;
};
bake("on", true);
bake("off", false);

/* ------------------------------------------------------------------ *
 * A1. 구조 사실 — 트랩이 실제로 라인을 민다
 * ------------------------------------------------------------------ */
console.log("=== A1. 발화 (8시드, 트랩 ON 양팀) ===");
const fire = measureTrapFire(cfg, S8, ON);
console.log(
  `  발화 ${f(fire.firePct, 1)}% · 전진(걸린 틱) ${f(fire.biasWhenFiredM)}m · 전 틱 평균 ${f(fire.biasAllTicksM, 3)}m · ` +
    `최대 ${f(fire.biasMaxM)}m · 연속 ${f(fire.runLenMeanTicks)}틱 · 전환 ${f(fire.togglesPer100)}/100틱 · 관측 팀-틱 ${fire.lineTicks}`,
);
console.log(`  지시 없음(출하 픽스처): 발화 ${f(measureTrapFire(cfg, S8).firePct, 1)}%`);
console.log(
  `  롤백(trap.enabled=false): 발화 ${f(measureTrapFire(patch((c) => { c.movement.defLine.trap.enabled = false; }), S8, ON).firePct, 1)}%`,
);

/* ------------------------------------------------------------------ *
 * A2. 용량–반응 사다리
 * ------------------------------------------------------------------ */
console.log("\n=== A2. stepUpM 사다리 (20시드, 트랩 ON) — 1m 칸은 분해되지 않는다 ===");
console.log("  stepUpM   라인뒤 상대   라인높이(m)   뚫림%    오프사이드");
for (const v of [0, 1, 2.5, 4, 6]) {
  const m = measureTrap(patch((c) => { c.movement.defLine.trap.stepUpM = v; }), S20, ON);
  console.log(
    `  ${String(v).padEnd(9)} ${f(m.both.caughtMean, 3).padStart(9)}   ${f(m.both.lineMeanM).padStart(9)}   ${f(
      m.both.behindLineOwnPct,
    ).padStart(6)}   ${f(m.offsidesPerMatch).padStart(6)}`,
  );
}

/* ------------------------------------------------------------------ *
 * A3. 트리거 설계표 — 왜 거리 게이트인가
 * ------------------------------------------------------------------ */
console.log("\n=== A3. 위험거리 버킷 (20시드) — 기회는 비슷한데 대가가 20배 다르다 ===");
console.log("  팔          버킷        틱%    어깨(4m)  라인뒤   뚫림%");
for (const [label, config, p] of [
  ["OFF", cfg, undefined],
  ["ON", cfg, ON],
] as [string, EngineConfig, undefined | typeof ON][]) {
  const b = measureTrap(config, S20, p).both;
  b.byDanger.forEach((x, i) => {
    console.log(
      `  ${label.padEnd(11)} ${["<25m", "25-40m", "40-60m", ">60m"][i]!.padEnd(10)} ${f(x.tickPct, 1).padStart(5)}   ${f(
        x.shoulder4,
        3,
      ).padStart(7)}   ${f(x.caught, 3).padStart(6)}   ${f(x.behindPct).padStart(6)}`,
    );
  });
}

/* ------------------------------------------------------------------ *
 * A4. **반증** — 프론티어를 이기지 못한다 (60시드)
 * ------------------------------------------------------------------ */
console.log("\n=== A4. 프론티어 (60시드, 전부 트랩 ON 레짐) — 이 웨이브의 주장이 틀렸다는 표 ===");
console.log("  팔                   라인(m)   잡힘     뚫림%    효율(잡힘/뚫림)");
for (const [label, config, p] of [
  ["플라시보 stepUp=0", PLACEBO, ON],
  ["트랩 2.5 (출하)", cfg, ON],
  ["트랩 4", patch((c) => { c.movement.defLine.trap.stepUpM = 4; }), ON],
  ["트랩 6", patch((c) => { c.movement.defLine.trap.stepUpM = 6; }), ON],
  ["무차별 lineH 0.60", PLACEBO, ((t: TacticalInput, s: "home" | "away") => withLine(0.6)(ON(t, s)))],
  ["무차별 lineH 0.65", PLACEBO, ((t: TacticalInput, s: "home" | "away") => withLine(0.65)(ON(t, s)))],
  ["무차별 lineH 0.75", PLACEBO, ((t: TacticalInput, s: "home" | "away") => withLine(0.75)(ON(t, s)))],
] as [string, EngineConfig, typeof ON][]) {
  const b = measureTrap(config, S60, p).both;
  console.log(
    `  ${label.padEnd(20)} ${f(b.lineMeanM, 3).padStart(7)}   ${f(b.caughtMean, 4).padStart(6)}   ${f(
      b.behindLineOwnPct,
      3,
    ).padStart(6)}   ${f(b.caughtMean / b.behindLineOwnPct, 5).padStart(7)}`,
  );
}

/* ------------------------------------------------------------------ *
 * A5. 플리커(#178 예측) · #399 급정지 축
 * ------------------------------------------------------------------ */
console.log("\n=== A5. 플리커 · 급정지 (트랩이 목표를 앞뒤로 흔드는가) ===");
const flickOff = measureTrap(PLACEBO, S60, ON).both;
const flickOn = measureTrap(cfg, S60, ON).both;
console.log(`  백4 방향반전/100 선수-틱: 플라시보 ${f(flickOff.lineFlickerPer100, 3)} → 트랩 ${f(flickOn.lineFlickerPer100, 3)}`);
console.log(`  백4 진행도 절대이동(m/tick): 플라시보 ${f(flickOff.lineStepAbsM, 4)} → 트랩 ${f(flickOn.lineStepAbsM, 4)}`);
console.log(
  `  무소유 급정지(#399): 8시드 OFF ${f(measureDeadStops(cfg, S8))} → ON ${f(measureDeadStops(cfg, S8, ON))} · ` +
    `20시드 OFF ${f(measureDeadStops(cfg, S20))} → ON ${f(measureDeadStops(cfg, S20, ON))}`,
);

/* ------------------------------------------------------------------ *
 * A6. `trapBiasM` 잠복 결함
 * ------------------------------------------------------------------ */
console.log("\n=== A6. 심판 ↔ 패스 생성기 라인 불일치 (8시드, 트랩 ON) ===");
for (const v of [0, 2.5, 6]) {
  const r = measureRefereeLineMismatch(patch((c) => { c.rules.offside.trapBiasM = v; }), S8, ON);
  console.log(`  trapBiasM=${String(v).padEnd(4)} 오프사이드 ${f(r.offsides)}/경기 · 그중 생성기가 "온사이드"로 본 것 ${f(r.mismatched)}`);
}

/* ------------------------------------------------------------------ *
 * A7. 눈으로 볼 장면 — 초 단위 타임스탬프
 * ------------------------------------------------------------------ */
console.log("\n=== A7. 눈으로 볼 장면 (`__viewer.seek(<틱>)` · s3c-on.json vs s3c-off.json) ===");
const samples: DefShapeSample[] = [];
setDefShapeObserver((s) => samples.push(s));
try {
  const h = trapPatch(makeTacticalInput("H", SEED));
  const a = trapPatch(makeTacticalInput("A", SEED));
  runMatch(SEED, h, a, select, cfg);
} finally {
  setDefShapeObserver(null);
}
const scale = cfg.fixedScale;
type Fire = { tick: number; side: string; bias: number; members: number; run: number };
const fires: Fire[] = [];
const prev: Record<string, number> = {};
for (const s of samples) {
  if (s.kind !== "line") continue;
  const bias = s.trapBiasFx / scale;
  if (bias > 0) {
    const run = (prev[s.side] ?? 0) + 1;
    prev[s.side] = run;
    fires.push({ tick: s.tick, side: s.side, bias, members: s.members, run });
  } else {
    prev[s.side] = 0;
  }
}
// 가장 오래 · 가장 세게 걸린 순간 = 관객이 "라인이 통째로 올라간다"를 볼 수 있는 장면.
const best = [...fires].sort((a, b) => b.run - a.run || b.bias - a.bias || a.tick - b.tick).slice(0, 10);
console.log("  [트랩이 가장 오래 걸린 순간 — 라인이 유닛으로 전진한다]");
console.log("  | 시:초 | 틱 | 수비팀 | 전진량(m) | 연속(틱) | 라인 인원 |");
console.log("  |---|---|---|---|---|---|");
for (const t of best.sort((a, b) => a.tick - b.tick)) {
  console.log(`  | ${disp(t.tick)} | ${t.tick} | ${t.side} | ${f(t.bias)} | ${t.run} | ${t.members} |`);
}
console.log(`\n  (총 발화 팀-틱 ${fires.length} · 최장 연속 ${Math.max(...fires.map((x) => x.run))}틱)`);
