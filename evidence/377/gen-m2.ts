/**
 * #377 M2 관전 증거 생성기 (#346 피로 회복 · #361 슬라이더 3종 · #366 duty · #338 죽은 노브).
 *
 * 실행: `npx tsx evidence/377/gen-m2.ts`
 * 산출:
 *   evidence/377/m2-base.json        기준 경기(기본 입력)
 *   evidence/377/m2-wide.json        `team.width` 0.95            ← m2-narrow 와 나란히 본다
 *   evidence/377/m2-narrow.json      `team.width` 0.05
 *   evidence/377/m2-highpress.json   `triggerLine` 1.0            ← m2-lowblock 과 나란히 본다
 *   evidence/377/m2-lowblock.json    `triggerLine` 0.0
 *   (표는 stdout — evidence/377/M2.md 의 수치가 이 출력이다)
 *
 * ## 왜 A/B 로그를 굽나
 * M2 가 고친 것은 "장면 하나"가 아니라 **입력이 경기를 바꾸는가**다. 그건 한 경기를 보는 걸로는
 * 판정할 수 없고 **같은 시드에서 입력만 바꾼 두 경기**를 나란히 봐야 보인다. 그래서 증거도 쌍이다.
 * (피로는 화면에 안 보이는 값이라 아래 표로 낸다 — 관전으로 보이는 것은 그 **결과**(후반 속도)다.)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TacticalInput } from "@hmb/shared";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig } from "../../packages/engine/src/config.ts";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures.ts";
import { collectFatigue, formatFatigue } from "../../packages/engine/src/realism/fatigue.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = "27182818";
const cfg = defaultEngineConfig;
const select = makeSelectData();

const team = (t: TacticalInput, patch: Partial<TacticalInput["team"]>): TacticalInput => ({
  ...t,
  team: { ...t.team, ...patch },
});

function bake(name: string, patch: (t: TacticalInput) => TacticalInput) {
  const log = runMatch(SEED, patch(makeTacticalInput("H", SEED)), makeTacticalInput("A", SEED), select, cfg);
  writeFileSync(join(here, `m2-${name}.json`), JSON.stringify(log));
  // 홈 팀 폭(아웃필더 y 산포) · 홈이 수비할 때 공↔최근접 홈 선수 거리 — 화면에서 보이는 두 가지.
  let wSum = 0;
  let wN = 0;
  let nSum = 0;
  let nN = 0;
  for (const s of log.tickSnapshots) {
    const out = s.players.filter((p) => p.team === "home" && p.playerId !== "H0");
    if (out.length > 1) {
      const ys = out.map((p) => p.pos.y);
      wSum += Math.max(...ys) - Math.min(...ys);
      wN += 1;
    }
    if (s.ballOwner && s.ballOwner.startsWith("A") && s.ball.x > 52.5) {
      let best = Infinity;
      for (const p of out) best = Math.min(best, Math.hypot(p.pos.x - s.ball.x, p.pos.y - s.ball.y));
      if (Number.isFinite(best)) {
        nSum += best;
        nN += 1;
      }
    }
  }
  return {
    name,
    score: `${log.finalScore.home}:${log.finalScore.away}`,
    widthM: wN ? wSum / wN : 0,
    nearestM: nN ? nSum / nN : 0,
    events: log.events.length,
  };
}

const rows = [
  bake("base", (t) => t),
  bake("wide", (t) => team(t, { width: 0.95 })),
  bake("narrow", (t) => team(t, { width: 0.05 })),
  bake("highpress", (t) => team(t, { pressingScheme: { ...t.team.pressingScheme, triggerLine: 1 } })),
  bake("lowblock", (t) => team(t, { pressingScheme: { ...t.team.pressingScheme, triggerLine: 0 } })),
];

console.log(`# M2 관전 증거 — seed ${SEED} · ${cfg.version}`);
console.log(`\n## 입력이 경기를 바꾼다 (같은 시드, 홈 팀 입력만 변경)`);
console.log(`  ${"로그".padEnd(11)} ${"스코어".padEnd(6)} ${"홈 팀 폭".padStart(8)}  ${"수비 시 공↔최근접(상대진영)".padStart(10)}`);
for (const r of rows) {
  console.log(`  ${r.name.padEnd(11)} ${r.score.padEnd(6)} ${r.widthM.toFixed(2).padStart(8)}m  ${r.nearestM.toFixed(2).padStart(10)}m`);
}

const seeds = ["4815162342", "9999999999", "1234567890", "2718281828"];
console.log("\n## 피로 곡선 (#346) — 화면엔 안 보이는 값이라 표로 낸다");
console.log(formatFatigue("현재 (회복 있음)", collectFatigue(cfg, seeds)));
console.log(
  formatFatigue(
    "대조군 (recoveryEnabled=false = 구 모델)",
    collectFatigue({ ...cfg, fatigue: { ...cfg.fatigue, recoveryEnabled: false } }, seeds),
  ),
);
