/**
 * #377 S3-B 관전 증거 생성기 (공유 수비 라인 + 오픈플레이 레스트디펜스 — #303 · 로드맵 W5-2/W5-8).
 *
 * 실행: `npx tsx evidence/377/gen-s3b.ts`
 * 산출: evidence/377/s3b-{on,off}.json — **같은 시드, 두 기제만 on/off**. 나란히 본다.
 *      (표·타임스탬프는 stdout — evidence/377/S3-B.md 의 수치가 이 출력이다)
 *
 * ## 왜 쌍인가
 * "백4가 한 줄로 섰다"는 한 경기만 봐서는 판정할 수 없다 — 수비수는 라인 규율이 없어도 블록
 * 항 때문에 대충 비슷한 x 에 서 있기 때문이다. 같은 시드에서 두 스위치만 끄면 **같은 상황의
 * 같은 장면**이 구 동작으로 나오므로, 그 둘을 나란히 놓는 것이 관전 증거다.
 *
 * ## 계량은 계약과 **같은 함수**로 한다
 * `packages/engine/src/realism/defshape.ts` 를 그대로 쓴다. 역할 라벨은 엔진 관측자
 * (`setDefShapeObserver`)가 준 값이다 — 진단 쪽에서 좌표로 되추론하지 않는다(#378 이 벽/백업을
 * 좌표로 되추론했다가 가짜 위반 566건을 만든 전례).
 *
 * ⚠️ **두 점(on/off)만 보고 인과를 붙이지 않는다**(트랙 D 가 네 번 걸린 자리 — 그중 하나는 이
 * 웨이브의 출발점이 된 S3-A 의 "defendCompactX 는 단조 레버" 문장이다). 세기를 사다리로 흔들어
 * 용량–반응을 같이 찍고, **무의미 섭동**(0.300 → 0.301 같은, 축구적으로 아무것도 아닌 변화)으로
 * **잡음 바닥**을 재서 "이 차이가 잡음보다 큰가"를 매번 같이 보고한다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config.ts";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures.ts";
import { setDefShapeObserver, type DefShapeSample } from "../../packages/engine/src/action.ts";
import {
  measureDefLine,
  measureRestDefence,
  measureShapeOutcome,
  withLineHeight,
} from "../../packages/engine/src/realism/defshape.ts";
import { REALISM_SEEDS, GUARD_SEEDS } from "../../packages/engine/src/realism/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = REALISM_SEEDS[0]!;
const S8 = REALISM_SEEDS.slice(0, 8);
const S16 = REALISM_SEEDS.slice(0, 16);
const S20 = REALISM_SEEDS;
const select = makeSelectData();
const cfg = defaultEngineConfig;

const patch = (mut: (c: EngineConfig) => void): EngineConfig => {
  const c = JSON.parse(JSON.stringify(cfg)) as EngineConfig;
  mut(c);
  return c;
};
const OFF = patch((c) => {
  c.movement.defLine.enabled = false;
  c.movement.restDefence.enabled = false;
});
const LINE_ONLY = patch((c) => {
  c.movement.restDefence.enabled = false;
});
const REST_ONLY = patch((c) => {
  c.movement.defLine.enabled = false;
});

const f = (v: number, d = 2): string => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
const disp = (tick: number): string => {
  const scale = (cfg.displayMinutes ?? cfg.matchMinutes) / cfg.matchMinutes;
  const sec = Math.round(((tick * cfg.msPerTick) / 1000) * scale);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};
const goalsOf = (config: EngineConfig, seeds: readonly string[]): number =>
  seeds
    .map((s) => {
      const l = runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, config);
      return l.finalScore.home + l.finalScore.away;
    })
    .reduce((a, b) => a + b, 0) / seeds.length;

const bake = (config: EngineConfig, name: string): MatchLog => {
  const log = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), select, config);
  writeFileSync(join(here, `s3b-${name}.json`), JSON.stringify(log));
  return log;
};

bake(cfg, "on");
bake(OFF, "off");

/* ------------------------------------------------------------------ *
 * A1. 구조 사실 — 라인 배정 · 잔류 배정이 발화한다
 * ------------------------------------------------------------------ */
console.log("=== A1. 발화 (8시드) ===");
const lineOn = measureDefLine(LINE_ONLY, S8);
const restOn = measureRestDefence(REST_ONLY, S8);
console.log(
  `  라인:  발화 ${f(lineOn.appliedPct, 1)}% · 멤버 ${f(lineOn.membersMean)}명 · 압박유닛이 데려간 ${f(
    lineOn.excludedByUnitMean,
  )}명 · 관측 팀-틱 ${lineOn.lineTicks}`,
);
console.log(
  `  잔류:  요청 ${f(restOn.wantMean, 1)} · 배정 ${f(restOn.assignedMean, 1)} · 상한에 걸림 ${f(
    restOn.cappedMean,
    1,
  )} · 걸린 틱 ${f(restOn.cappedTickPct, 1)}% · 되돌린 거리 ${f(restOn.capOvershootMeanM)}m`,
);

/* ------------------------------------------------------------------ *
 * A2. L2 용량–반응 — 목표가 아니라 **위치**로 잰다
 * ------------------------------------------------------------------ */
console.log("\n=== A2. lineDiscipline 사다리 (레스트 off 로 격리, 20시드) ===");
console.log("  k      멤버 위치산포 p90 / 평균   목표↔위치 간격");
for (const k of [0, 0.25, 0.5, 0.75, 1.0]) {
  const r = measureDefLine(
    patch((c) => {
      c.movement.restDefence.enabled = false;
      c.movement.lineDiscipline = k;
    }),
    S20,
  );
  console.log(
    `  ${String(k).padEnd(6)} ${f(r.memberPosSpreadP90M).padStart(6)} / ${f(r.memberPosSpreadMeanM).padStart(5)}   ${f(
      r.targetPosGapMeanM,
    ).padStart(6)}`,
  );
}

/* ------------------------------------------------------------------ *
 * A3. L6 변이체 — 기준점이 위치여야 한다
 * ------------------------------------------------------------------ */
console.log("\n=== A3. refMode 아블레이션 (8시드) — 절대 기준점은 도달 불가능한 목표를 준다 ===");
console.log("  k      members: 산포p90 / 간격     planLine: 산포p90 / 간격");
for (const k of [0, 0.5, 1.0]) {
  const mk = (mode: "members" | "planLine") =>
    measureDefLine(
      patch((c) => {
        c.movement.restDefence.enabled = false;
        c.movement.defLine.refMode = mode;
        c.movement.lineDiscipline = k;
      }),
      S8,
    );
  const m = mk("members");
  const p = mk("planLine");
  console.log(
    `  ${String(k).padEnd(6)} ${f(m.memberPosSpreadP90M).padStart(9)} / ${f(m.targetPosGapMeanM).padStart(5)}      ${f(
      p.memberPosSpreadP90M,
    ).padStart(9)} / ${f(p.targetPosGapMeanM).padStart(5)}`,
  );
}

/* ------------------------------------------------------------------ *
 * A4. L4 슬라이더 소생
 * ------------------------------------------------------------------ */
console.log("\n=== A4. team.defensiveLineHeight 권한 (수비 라인 높이 m, 20시드) ===");
for (const [label, config] of [
  ["OFF(0.38.0)", OFF],
  ["ON (S3-B)", LINE_ONLY],
] as [string, EngineConfig][]) {
  const v = [0.2, 0.55, 0.9].map((x) => measureShapeOutcome(config, S20, withLineHeight(x)).offsideLineMeanM);
  console.log(
    `  ${label.padEnd(12)} 0.2 → ${f(v[0]!)}  0.55 → ${f(v[1]!)}  0.9 → ${f(v[2]!)}   **권한폭 ${f(
      v[2]! - v[0]!,
    )} m**`,
  );
}

/* ------------------------------------------------------------------ *
 * A5. R 레스트디펜스 — 센터백이 산책하지 않는다
 * ------------------------------------------------------------------ */
console.log("\n=== A5. lineCapProgress 사다리 (라인 on, 20시드) ===");
console.log("  cap    CB 하프라인 초과%   CB 경기당 최고 진행도(m)   상대 진영 인원");
for (const cap of [1.0, 0.7, 0.6, 0.5, 0.4]) {
  const o = measureShapeOutcome(
    patch((c) => {
      c.movement.restDefence.lineCapProgress = cap;
    }),
    S20,
  );
  console.log(
    `  ${String(cap).padEnd(6)} ${f(o.cbOverHalfPct).padStart(14)}   ${f(o.cbProgMaxM).padStart(20)}   ${f(
      o.attackersUpfieldMean,
    ).padStart(12)}`,
  );
}

/* ------------------------------------------------------------------ *
 * A6. 2×2 아블레이션 — 귀속 분해
 * ------------------------------------------------------------------ */
console.log("\n=== A6. 2×2 아블레이션 (20시드) ===");
console.log("  팔                  전백4산포  CB하프%  CB최고m  전방인원  라인높이");
for (const [label, config] of [
  ["① 둘 다 off", OFF],
  ["② 라인만", LINE_ONLY],
  ["③ 레스트만", REST_ONLY],
  ["④ 둘 다 on(출하)", cfg],
] as [string, EngineConfig][]) {
  const o = measureShapeOutcome(config, S20);
  console.log(
    `  ${label.padEnd(18)} ${f(o.backSpreadMeanM).padStart(8)}  ${f(o.cbOverHalfPct).padStart(6)}  ${f(
      o.cbProgMaxM,
    ).padStart(7)}  ${f(o.attackersUpfieldMean).padStart(7)}  ${f(o.offsideLineMeanM).padStart(7)}`,
  );
}

/* ------------------------------------------------------------------ *
 * A7. 볼륨 + **잡음 바닥** (참고 — 재보정은 트랙 T)
 * ------------------------------------------------------------------ */
console.log("\n=== A7. 볼륨과 그 잡음 바닥 ===");
console.log(`  롤백  골 16시드 ${f(goalsOf(OFF, S16))} · 60시드 ${f(goalsOf(OFF, GUARD_SEEDS))}`);
console.log(`  출하  골 16시드 ${f(goalsOf(cfg, S16))} · 60시드 ${f(goalsOf(cfg, GUARD_SEEDS))}`);
console.log("  ⚠️ 잡음 바닥 — **축구적으로 아무 의미 없는 섭동**만으로 얼마나 흔들리나:");
for (const [label, mut] of [
  ["memberProgressMax 0.300→0.301", (c: EngineConfig) => { c.movement.defLine.memberProgressMax = 0.301; }],
  ["blockLineRangeM 5.00→5.02", (c: EngineConfig) => { c.movement.defLine.blockLineRangeM = 5.02; }],
  ["roleOffsetKeep 0.350→0.351", (c: EngineConfig) => { c.movement.defLine.roleOffsetKeep = 0.351; }],
  ["lineCapProgress 0.500→0.501", (c: EngineConfig) => { c.movement.restDefence.lineCapProgress = 0.501; }],
] as [string, (c: EngineConfig) => void][]) {
  const p = patch(mut);
  console.log(`    ${label.padEnd(32)} 16시드 ${f(goalsOf(p, S16))} · 60시드 ${f(goalsOf(p, GUARD_SEEDS))}`);
}

/* ------------------------------------------------------------------ *
 * A8. 눈으로 볼 장면 — 초 단위 타임스탬프
 * ------------------------------------------------------------------ */
console.log("\n=== A8. 눈으로 볼 장면 (`__viewer.seek(<틱>)` · s3b-on.json vs s3b-off.json) ===");
const samples: DefShapeSample[] = [];
setDefShapeObserver((s) => samples.push(s));
try {
  runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), select, cfg);
} finally {
  setDefShapeObserver(null);
}
const scale = cfg.fixedScale;
// 라인: 멤버가 많고 **위치 산포가 작은** 순간(= 한 줄이 눈에 보이는 순간).
const byTick = new Map<string, { tick: number; side: string; members: number; posSpread: number }>();
const pending = new Map<string, number[]>();
for (const s of samples) {
  if (s.kind === "lineMember") {
    const key = `${s.tick}:${s.side}`;
    const arr = pending.get(key) ?? [];
    arr.push(s.posProgFx);
    pending.set(key, arr);
  } else if (s.kind === "line" && s.applied) {
    const key = `${s.tick}:${s.side}`;
    const arr = pending.get(key) ?? [];
    if (arr.length >= 3) {
      byTick.set(key, {
        tick: s.tick,
        side: s.side,
        members: arr.length,
        posSpread: (Math.max(...arr) - Math.min(...arr)) / scale,
      });
    }
    pending.delete(key);
  }
}
const tight = [...byTick.values()].sort((a, b) => a.posSpread - b.posSpread || a.tick - b.tick).slice(0, 8);
console.log("  [라인이 가장 또렷한 순간]");
console.log("  | 시:초 | 틱 | 수비팀 | 라인 인원 | 위치 산포(m) |");
console.log("  |---|---|---|---|---|");
for (const t of tight.sort((a, b) => a.tick - b.tick)) {
  console.log(`  | ${disp(t.tick)} | ${t.tick} | ${t.side} | ${t.members} | ${f(t.posSpread)} |`);
}
// 잔류: 상한이 가장 크게 문 순간(= CB 가 올라가려다 되돌아오는 순간).
const capped = samples
  .filter((s): s is Extract<DefShapeSample, { kind: "restMember" }> => s.kind === "restMember" && s.capped)
  .map((s) => ({ tick: s.tick, side: s.side, id: s.playerId, back: (s.beforeProgFx - s.afterProgFx) / scale }))
  .sort((a, b) => b.back - a.back)
  .slice(0, 8);
console.log("\n  [레스트디펜스 상한이 가장 크게 문 순간]");
console.log("  | 시:초 | 틱 | 공격팀 | 선수 | 되돌린 거리(m) |");
console.log("  |---|---|---|---|---|");
for (const c of capped.sort((a, b) => a.tick - b.tick)) {
  console.log(`  | ${disp(c.tick)} | ${c.tick} | ${c.side} | ${c.id} | ${f(c.back)} |`);
}
