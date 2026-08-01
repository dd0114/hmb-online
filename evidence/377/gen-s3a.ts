/**
 * #377 S3-A 관전 증거 생성기 (압박 유닛 — #350 · #362 · #303).
 *
 * 실행: `npx tsx evidence/377/gen-s3a.ts`
 * 산출: evidence/377/s3a-{on,off}.json — **같은 시드, 압박 유닛만 on/off**. 나란히 본다.
 *      (표·타임스탬프는 stdout — evidence/377/S3-A.md 의 수치가 이 출력이다)
 *
 * ## 왜 쌍인가
 * "수비가 다 같이 반응했다"는 한 경기만 봐서는 판정할 수 없다 — 수비수는 유닛이 없어도 블록·마크로
 * 공 근처에 서 있기 때문이다. 같은 시드에서 `press.unit.enabled` 만 끄면 **같은 상황의 같은 장면**이
 * 구 동작으로 나오므로, 그 둘을 나란히 놓는 것이 관전 증거다.
 *
 * ## 계량은 계약과 **같은 함수**로 한다
 * `packages/engine/src/realism/press.ts` 의 `measurePressUnit` 을 그대로 쓴다. 역할 라벨은 엔진
 * 관측자(`setPressUnitObserver`)가 준 값이다 — 진단 쪽에서 좌표로 되추론하지 않는다(#378 이
 * 벽/백업을 좌표로 되추론했다가 가짜 위반 566건을 만든 전례).
 *
 * ⚠️ **두 점(on/off)만 보고 인과를 붙이지 않는다**(트랙 D 가 세 번 걸린 자리). 인원을 사다리로
 * 흔들어 용량–반응을 같이 찍고, **플라시보 팔**(`coverLanePull: 0` — 역할 배정·지원 슬롯은 그대로,
 * 레인 선점만 없음)로 라벨 선택 편향을 반증한다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config.ts";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures.ts";
import { measurePressUnit, runWithPressUnit, withIntensity, DANGER_BUCKETS_M } from "../../packages/engine/src/realism/press.ts";
import { measureLaneOccupancy } from "../../packages/engine/src/realism/lane.ts";
import { aggregateDeepen } from "../../packages/engine/src/realism/deepen.ts";
import { REALISM_SEEDS } from "../../packages/engine/src/realism/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = REALISM_SEEDS[0]!;
const SEEDS = REALISM_SEEDS.slice(0, 8);
const select = makeSelectData();
const cfg = defaultEngineConfig;
const patch = (mut: (c: EngineConfig) => void): EngineConfig => {
  const c = JSON.parse(JSON.stringify(cfg)) as EngineConfig;
  mut(c);
  return c;
};
const off = patch((c) => { c.press.unit.enabled = false; });
const placebo = patch((c) => { c.press.unit.coverLanePull = 0; });

const disp = (tick: number): string => {
  const scale = (cfg.displayMinutes ?? cfg.matchMinutes) / cfg.matchMinutes;
  const sec = Math.round(((tick * cfg.msPerTick) / 1000) * scale);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};
const f = (v: number, d = 2): string => (Math.round(v * 10 ** d) / 10 ** d).toString();

const bake = (config: EngineConfig, name: string): MatchLog => {
  const log = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), select, config);
  writeFileSync(join(here, `s3a-${name}.json`), JSON.stringify(log));
  return log;
};

const onLog = bake(cfg, "on");
const offLog = bake(off, "off");

console.log(`# S3-A 관전 증거 — seed ${SEED} · ${cfg.version}`);
console.log(`\n## 로그 (뷰어에 드롭해 나란히 본다)`);
console.log(`  s3a-on.json   압박 유닛 on  — score ${onLog.finalScore.home}:${onLog.finalScore.away} · 이벤트 ${onLog.events.length}`);
console.log(`  s3a-off.json  압박 유닛 off — score ${offLog.finalScore.home}:${offLog.finalScore.away} · 이벤트 ${offLog.events.length}`);

/* --- 눈으로 볼 장면: 유닛이 가장 크게 붙은 순간 --------------------------- */
console.log(`\n## 눈으로 볼 장면 (\`__viewer.seek(<틱>)\`)`);
console.log(`\n| 시:초 | 틱 | 수비팀 | 총원 | 커버 | 위험거리(m) | 무엇을 보나 |`);
console.log(`|---|---|---|---|---|---|---|`);
const scenes = runWithPressUnit(cfg, SEED).samples
  .filter((s) => s.kind === "unit" && s.count >= 3)
  .map((s) => s as Extract<typeof s, { kind: "unit" }>)
  .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.dangerFx - b.dangerFx));
// 같은 국면이 연달아 잡히지 않게 틱 간격을 벌린다(장면 다양성).
const picked: typeof scenes = [];
for (const s of scenes) {
  if (picked.some((p) => Math.abs(p.tick - s.tick) < 60)) continue;
  picked.push(s);
  if (picked.length >= 8) break;
}
for (const s of picked.sort((a, b) => a.tick - b.tick)) {
  console.log(
    `| ${disp(s.tick)} | ${s.tick} | ${s.side} | ${s.count} | ${s.coverCount} | ${f(s.dangerFx / cfg.fixedScale, 1)} | 공 주변에 ${s.count}명이 붙는다(구동작은 1명) |`,
  );
}

/* --- 표 1. 위험도 → 인원 (A1) --------------------------------------------- */
const pOn = measurePressUnit(cfg, SEEDS);
const pOff = measurePressUnit(off, SEEDS);
console.log(`\n## 표 1. 위험도 → 인원 (${SEEDS.length}시드)`);
console.log(`\n| 위험거리(자기 골에서) | 표본(팀-틱) | 배정 총원 ON | 배정 총원 OFF |`);
console.log(`|---|---|---|---|`);
const labels = [
  `< ${DANGER_BUCKETS_M[0]}m (박스 앞)`,
  `${DANGER_BUCKETS_M[0]}–${DANGER_BUCKETS_M[1]}m`,
  `${DANGER_BUCKETS_M[1]}–${DANGER_BUCKETS_M[2]}m`,
  `> ${DANGER_BUCKETS_M[2]}m (상대 진영)`,
];
labels.forEach((l, i) => {
  console.log(`| ${l} | ${pOn.ticksByDanger[i]} | **${f(pOn.countByDanger[i]!)}** | ${f(pOff.countByDanger[i]!)} |`);
});
console.log(`\n총원 평균 ON **${f(pOn.countMean, 3)}** / OFF ${f(pOff.countMean, 3)} · 커버 ${f(pOn.coverMean, 3)} · 지원 ${f(pOn.supportMean, 3)}`);

/* --- 표 2. 강도 사다리 (A3) ----------------------------------------------- */
console.log(`\n## 표 2. \`pressingScheme.intensity\` 용량–반응 (${SEEDS.length}시드)`);
console.log(`\n| intensity | 배정 총원 | 커버 | 지원 |`);
console.log(`|---|---|---|---|`);
for (const v of [0.2, 0.35, 0.55, 0.75, 1.0]) {
  const m = measurePressUnit(cfg, SEEDS, withIntensity(v));
  console.log(`| ${v} | ${f(m.countMean, 3)} | ${f(m.coverMean, 3)} | ${f(m.supportMean, 3)} |`);
}

/* --- 표 3. 오염 제거 (A5) ------------------------------------------------- */
console.log(`\n## 표 3. 압박 담당의 목표 오염 (${SEEDS.length}시드)`);
console.log(`\n| 팔 | 목표↔공 p50(m) | p90(m) | 평균(m) | 표본 |`);
console.log(`|---|---|---|---|---|`);
console.log(`| OFF(구동작) | ${f(pOff.presserBallDistP50M, 3)} | ${f(pOff.presserBallDistP90M, 3)} | ${f(pOff.presserBallDistMeanM, 3)} | ${pOff.presserSamples} |`);
console.log(`| ON | ${f(pOn.presserBallDistP50M, 3)} | ${f(pOn.presserBallDistP90M, 3)} | ${f(pOn.presserBallDistMeanM, 3)} | ${pOn.presserSamples} |`);

/* --- 표 4. 레인 점유 3팔 (A4) --------------------------------------------- */
console.log(`\n## 표 4. 레인 점유 — off / 플라시보 / on (${SEEDS.length}시드)`);
console.log(`\n| 팔 | 위협 레인 점유% | 전 레인 점유% | 레인 최근접 평균(m) |`);
console.log(`|---|---|---|---|`);
for (const [label, c] of [["OFF", off], ["PLACEBO(lanePull=0)", placebo], ["ON", cfg]] as const) {
  const o = measureLaneOccupancy(c, SEEDS);
  console.log(`| ${label} | ${f(o.forwardOccupiedPct)} | ${f(o.occupiedPct)} | ${f(o.laneDangerAvgM)} |`);
}

/* --- 표 5. 수비 지표 (A2) + 볼륨 ------------------------------------------ */
console.log(`\n## 표 5. 수비 지표 · 볼륨 (${SEEDS.length}시드)`);
const dOn = aggregateDeepen(cfg, SEEDS);
const dOff = aggregateDeepen(off, SEEDS);
console.log(`\n| 지표 | OFF | ON |`);
console.log(`|---|---|---|`);
const rows: [string, number, number][] = [
  ["볼 10m 안 수비수", dOff.mean.def.pressWithin10, dOn.mean.def.pressWithin10],
  ["볼 5m 안 수비수", dOff.mean.def.pressWithin5, dOn.mean.def.pressWithin5],
  ["무압박 틱 %", dOff.mean.def.noPressurePct, dOn.mean.def.noPressurePct],
  ["PPDA (게이트 아님·보고만)", dOff.mean.def.ppda, dOn.mean.def.ppda],
  ["수비 액션", dOff.mean.def.defActions, dOn.mean.def.defActions],
  ["슈터 최근접 수비 거리(m)", dOff.mean.def.shooterNearestDefM, dOn.mean.def.shooterNearestDefM],
];
for (const [l, a, b] of rows) console.log(`| ${l} | ${f(a, 3)} | **${f(b, 3)}** |`);
