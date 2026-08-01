/**
 * #377 M3-B 관전 증거 생성기 (수비 레인 예측 — #379).
 *
 * 실행: `npx tsx evidence/377/gen-m3b.ts`
 * 산출: evidence/377/m3b-{on,off}.json — **같은 시드, 레인 예측만 on/off**. 나란히 본다.
 *      (표·타임스탬프는 stdout — evidence/377/M3-B.md 의 수치가 이 출력이다)
 *
 * ## 왜 쌍인가
 * "수비가 레인을 미리 막았다"는 한 경기만 봐서는 판정할 수 없다 — 수비수는 레인을 안 읽어도
 * 블록·마크로 그 근처에 서 있기 때문이다(M3-A 가 "발사 전 접근률 80.8%" 라는 오측정을 그렇게
 * 만들었다). 같은 시드에서 `vision.laneRead.enabled` 만 끄면 **같은 상황의 같은 장면**이 구 동작
 * 으로 나오므로, 그 둘을 나란히 놓는 것이 관전 증거다.
 *
 * ## 계량은 계약과 **같은 함수**로 한다
 * `packages/engine/src/realism/lane.ts` 의 `measureLaneSplit`·`measureLaneOccupancy` 를 그대로
 * 쓴다. 레인 기하는 엔진의 `perception.ts:laneClosest`/`laneDangerOn` 이고, 읽기 판정은 엔진
 * 관측자(`setLaneReadObserver`)가 준 값이다 — 진단 쪽에서 다시 계산하지 않는다.
 *
 * ⚠️ **두 점(on/off)만 보고 인과를 붙이지 않는다**(트랙 D 가 세 번 걸린 자리). 세기를 4 rung
 * 흔들어 용량–반응을 같이 찍고, **플라시보 팔**(`pull: 0` — 읽기 라벨은 그대로, 선점만 없음)로
 * 라벨 선택 편향을 반증한다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config.ts";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures.ts";
import {
  measureLaneOccupancy,
  measureLaneSplit,
  type LaneArm,
} from "../../packages/engine/src/realism/lane.ts";
import { REALISM_SEEDS } from "../../packages/engine/src/realism/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
// 관전용 시드 — REALISM_SEEDS 앞쪽을 훑어 **읽힌 레인이 크게 좁혀지는 장면**이 전·후반 고루
// 나오는 시드를 골랐다(아래 "눈으로 볼 장면" 표가 그 출력이다).
const SEED = "1730123456";
const SEEDS = REALISM_SEEDS.slice(0, 8);
const select = makeSelectData();
const cfg = defaultEngineConfig;
const patch = (mut: (c: EngineConfig) => void): EngineConfig => {
  const c = JSON.parse(JSON.stringify(cfg)) as EngineConfig;
  mut(c);
  return c;
};
const off = patch((c) => { c.vision.laneRead.enabled = false; });
const placebo = patch((c) => { c.vision.laneRead.pull = 0; });

const disp = (tick: number): string => {
  const scale = (cfg.displayMinutes ?? cfg.matchMinutes) / cfg.matchMinutes;
  const sec = Math.round(((tick * cfg.msPerTick) / 1000) * scale);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

const bake = (config: EngineConfig, name: string): MatchLog => {
  const log = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), select, config);
  writeFileSync(join(here, `m3b-${name}.json`), JSON.stringify(log));
  return log;
};

const on = bake(cfg, "on");
const legacy = bake(off, "off");

console.log(`# M3-B 관전 증거 — seed ${SEED} · ${cfg.version}`);
console.log(`\n## 로그 (뷰어에 드롭해 나란히 본다)`);
console.log(`  m3b-on.json   레인 예측 on  — score ${on.finalScore.home}:${on.finalScore.away} · 이벤트 ${on.events.length}`);
console.log(`  m3b-off.json  레인 예측 off — score ${legacy.finalScore.home}:${legacy.finalScore.away} · 이벤트 ${legacy.events.length}`);

/** 눈으로 볼 장면은 **한 경기**(위 로그)에서 뽑는다 — hero 가 그 틱으로 바로 seek 한다. */
const one = measureLaneSplit(cfg, [SEED]);
console.log(`\n## 눈으로 볼 장면 (m3b-on.json — 아래 초로 seek · 전부 READ)`);
for (const s of one.read.scenes.slice(0, 6)) {
  console.log(
    `  ${disp(s.tick)} (t${s.tick}) ${s.side} ${s.playerId} — 공(${s.fromX.toFixed(1)},${s.fromY.toFixed(1)}) → ` +
      `${s.toId}(${s.toX.toFixed(1)},${s.toY.toFixed(1)}) 레인으로 ${s.d0.toFixed(1)}m → **${s.d1.toFixed(1)}m** ` +
      `(${s.closed.toFixed(1)}m 좁힘 · 선점 ${s.stepM.toFixed(1)}m)`,
  );
}

/** 계량은 8시드로. **출하 config 안에서** 읽은 팔 vs 안 읽은 팔. */
const row = (label: string, a: LaneArm): void =>
  console.log(
    `  ${label.padEnd(22)} n=${String(a.n).padStart(5)} · 관측시 레인거리 ${a.d0AvgM.toFixed(2)}m · ` +
      `좁힘 ${a.closedAvgM.toFixed(3)}m (>0.25m ${a.closedPosPct.toFixed(1)}%) · ` +
      `레인 점유 ${a.guardedPct.toFixed(1)}% (팀최근접 ${a.guardedAvgM.toFixed(3)}m 좁힘) · 능력 ${a.attrAvg.toFixed(1)}`,
  );

const ship = measureLaneSplit(cfg, SEEDS);
const plc = measureLaneSplit(placebo, SEEDS);
console.log(`\n## READ vs UNREAD — 출하 config 한 경기 안에서 (8시드 · 후보 ${ship.candidates}건)`);
row("READ(읽었다)", ship.read);
row("UNREAD(안 읽었다)", ship.unread);
console.log(`\n## 플라시보 (pull=0 — 라벨은 그대로, 선점만 없음): 선택 편향 반증`);
row("READ(플라시보)", plc.read);
row("UNREAD(플라시보)", plc.unread);

/** 용량–반응: `pull` 만 올리면 `maxStepM` 상한에서 포화하므로 둘을 같이 흔든다. */
console.log(`\n## 용량–반응 사다리 (8시드) — 세기 · 레인 점유 집계`);
const rungs: [string, EngineConfig][] = [
  ["off", off],
  ["0.5x", patch((c) => { c.vision.laneRead.pull = 0.15; c.vision.laneRead.maxStepM = 1.25; })],
  ["1x(출하)", cfg],
  ["2x", patch((c) => { c.vision.laneRead.pull = 0.6; c.vision.laneRead.maxStepM = 5; })],
  ["4x", patch((c) => { c.vision.laneRead.pull = 1; c.vision.laneRead.maxStepM = 12; })],
  ["4x+전원읽기+사거리25", patch((c) => {
    c.vision.laneRead.pull = 1;
    c.vision.laneRead.maxStepM = 12;
    c.vision.laneRead.reachM = 25;
    c.vision.laneRead.readBase = 1;
  })],
];
for (const [name, c] of rungs) {
  const occ = measureLaneOccupancy(c, SEEDS);
  const sp = name === "off" ? null : measureLaneSplit(c, SEEDS);
  console.log(
    `  ${name.padEnd(20)} 전체 레인 점유 ${occ.occupiedPct.toFixed(2)}% (위협 레인 ${occ.forwardOccupiedPct.toFixed(2)}%)` +
      (sp
        ? ` | READ 좁힘 ${sp.read.closedAvgM.toFixed(3)} vs UNREAD ${sp.unread.closedAvgM.toFixed(3)}` +
          ` · 점유 ${sp.read.guardedPct.toFixed(1)}% vs ${sp.unread.guardedPct.toFixed(1)}%`
        : ""),
  );
}
