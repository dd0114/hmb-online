/**
 * #377 M1-본 관전 증거 생성기 (#378 데드볼 유동 재시작).
 *
 * 실행: `npx tsx evidence/377/gen-m1-main.ts`
 * 산출: evidence/377/m1-main-{now,legacy}.json — **같은 시드, 게이트 on/off**. 나란히 본다.
 *      (표는 stdout — evidence/377/M1-main.md 의 타임스탬프가 이 출력이다)
 *
 * 왜 쌍인가: "정지가 짧아졌다"는 한 경기만 봐서는 알 수 없다. 같은 시드에서 게이트만 끄면
 * **같은 상황의 같은 재시작**이 구 동작으로 나오므로 그 둘을 나란히 놓는 것이 유일한 관전 증거다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config.ts";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = "1618033988";
const legacy: EngineConfig = {
  ...defaultEngineConfig,
  rules: {
    ...defaultEngineConfig.rules,
    restart: {
      ...defaultEngineConfig.rules.restart,
      gate: { ...defaultEngineConfig.rules.restart.gate, enabled: false },
    },
  },
};

const disp = (tick: number): string => {
  const c = defaultEngineConfig;
  const scale = (c.displayMinutes ?? c.matchMinutes) / c.matchMinutes;
  const sec = Math.round(((tick * c.msPerTick) / 1000) * scale);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

/** 재시작 → 공이 스팟을 떠난 틱까지(= 정지 창) + 그 틱에 아직 움직이던 선수 비율. */
function windows(log: MatchLog) {
  const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
  const out: { kind: string; tick: number; span: number; movingPct: number }[] = [];
  for (const e of log.events) {
    if (e.type !== "kickoff" && e.type !== "free_kick") continue;
    const kind = e.type === "free_kick" ? "free_kick" : (e.detail ?? "kickoff");
    if (kind === "kickoff" || kind === "corner") continue;
    const s0 = byTick.get(e.tick);
    if (!s0) continue;
    let leave = -1;
    for (let t = e.tick + 1; t <= e.tick + 60; t++) {
      const s = byTick.get(t);
      if (!s) break;
      if (Math.hypot(s.ball.x - s0.ball.x, s.ball.y - s0.ball.y) > 1) { leave = t; break; }
    }
    if (leave < 0) continue;
    const a = byTick.get(leave - 1);
    const b = byTick.get(leave);
    let moving = 0, n = 0;
    if (a && b) {
      const prev = new Map(a.players.map((p) => [`${p.team}:${p.playerId}`, p.pos]));
      for (const p of b.players) {
        const q = prev.get(`${p.team}:${p.playerId}`);
        if (!q) continue;
        n += 1;
        if (Math.hypot(p.pos.x - q.x, p.pos.y - q.y) > 0.3) moving += 1;
      }
    }
    out.push({ kind, tick: e.tick, span: leave - e.tick, movingPct: n ? (moving / n) * 100 : 0 });
  }
  return out;
}

const sel = makeSelectData();
const nowLog = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), sel, defaultEngineConfig);
const oldLog = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), sel, legacy);
writeFileSync(join(here, "m1-main-now.json"), JSON.stringify(nowLog));
writeFileSync(join(here, "m1-main-legacy.json"), JSON.stringify(oldLog));

const nw = windows(nowLog);
const ow = windows(oldLog);
const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const byKind = (w: typeof nw, k: string) => w.filter((x) => x.kind === k);

console.log(`# M1-본 관전 증거 — seed ${SEED} · ${defaultEngineConfig.version}`);
console.log(`\n## 정지 창(틱) — 같은 시드, 게이트 on/off`);
console.log(`  ${"종류".padEnd(10)} ${"구 동작".padStart(7)} ${"현재".padStart(7)}   재개 틱 이동중(구→현)`);
for (const k of ["throw_in", "goal_kick", "free_kick"]) {
  const a = byKind(ow, k), b = byKind(nw, k);
  console.log(
    `  ${k.padEnd(10)} ${avg(a.map((x) => x.span)).toFixed(1).padStart(7)} ${avg(b.map((x) => x.span)).toFixed(1).padStart(7)}   ` +
      `${avg(a.map((x) => x.movingPct)).toFixed(1)}% → ${avg(b.map((x) => x.movingPct)).toFixed(1)}%`,
  );
}
console.log(`\n## 가장 짧아진 재시작 8건 (뷰어 __viewer.seek(<틱>) 로 두 로그를 나란히)`);
console.log(`  ${"틱".padStart(5)}  ${"시각".padStart(5)}  ${"종류".padEnd(10)} ${"구".padStart(4)} → ${"현".padStart(4)}틱  재개 시 이동중`);
const paired = nw
  .map((b) => ({ b, a: ow.find((x) => x.kind === b.kind && Math.abs(x.tick - b.tick) < 40) }))
  .filter((p): p is { b: typeof nw[0]; a: typeof nw[0] } => !!p.a)
  .sort((x, y) => (y.a.span - y.b.span) - (x.a.span - x.b.span))
  .slice(0, 8);
for (const p of paired) {
  console.log(
    `  ${String(p.b.tick).padStart(5)}  ${disp(p.b.tick).padStart(5)}  ${p.b.kind.padEnd(10)} ${String(p.a.span).padStart(4)} → ${String(p.b.span).padStart(4)}틱  ${p.b.movingPct.toFixed(0)}%`,
  );
}
