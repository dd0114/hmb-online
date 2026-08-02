/**
 * #377 M3-C 관전 증거 생성기 (스루패스 — 공간 타깃 패스 후보).
 *
 * 실행: `npx tsx evidence/377/gen-m3c.ts`
 * 산출: evidence/377/m3c-{on,off}.json — **같은 시드, 스루패스만 on/off**. 나란히 본다.
 *      (표·타임스탬프는 stdout — evidence/377/M3-C.md 의 수치가 이 출력이다)
 *
 * ## 왜 쌍인가
 * "라인 뒤 공간으로 찔렀다"는 한 경기만 봐서는 판정할 수 없다 — 전진 패스는 스루패스가 없어도
 * 나오기 때문이다. 같은 시드에서 `chain.throughPass.enabled` 만 끄면 **같은 상황의 같은 장면**이
 * 구 동작(발밑 패스)으로 나오므로, 그 둘을 나란히 놓는 것이 관전 증거다.
 *
 * ## 측정은 계약과 **같은 함수**로 한다
 * `packages/engine/src/realism/through.ts` 의 `measureThrough` 를 그대로 쓴다. 증거와 계약이 다른
 * 함수를 쓰면 "증거는 좋은데 계약은 통과"가 성립한다(`loft.ts`·`pass-plan.ts` 선례).
 * 조준점은 엔진 관측자(`setPassAimObserver`)가 준 값이다 — 진단 쪽에서 다시 계산하지 않는다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config.ts";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures.ts";
import { measureThrough, type AimArm } from "../../packages/engine/src/realism/through.ts";
import { REALISM_SEEDS } from "../../packages/engine/src/realism/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
// 관전용 시드 — REALISM_SEEDS 20개를 훑어 **스루패스가 가장 여러 번, 여러 리드 거리로** 나오는
// 시드를 골랐다(4건 · 리드 25/24/15/13m, 전·후반 고루 분포). M3-A 의 1618033988 은 이 웨이브에선
// 스루패스가 1건뿐이라 관전 표본으로 얇다.
const SEED = "1730123456";
const SEEDS = REALISM_SEEDS.slice(0, 8);
const select = makeSelectData();
const cfg = defaultEngineConfig;
const off: EngineConfig = {
  ...cfg,
  chain: { ...cfg.chain, throughPass: { ...cfg.chain.throughPass, enabled: false } },
};

const disp = (tick: number): string => {
  const scale = (cfg.displayMinutes ?? cfg.matchMinutes) / cfg.matchMinutes;
  const sec = Math.round(((tick * cfg.msPerTick) / 1000) * scale);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

const bake = (config: EngineConfig, name: string): MatchLog => {
  const log = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), select, config);
  writeFileSync(join(here, `m3c-${name}.json`), JSON.stringify(log));
  return log;
};

const on = bake(cfg, "on");
const legacy = bake(off, "off");

console.log(`# M3-C 관전 증거 — seed ${SEED} · ${cfg.version}`);
console.log(`\n## 로그 (뷰어에 드롭해 나란히 본다)`);
console.log(`  m3c-on.json   스루패스 on  — score ${on.finalScore.home}:${on.finalScore.away} · 이벤트 ${on.events.length}`);
console.log(`  m3c-off.json  스루패스 off — score ${legacy.finalScore.home}:${legacy.finalScore.away} · 이벤트 ${legacy.events.length}`);

/** 눈으로 볼 장면은 **한 경기**(위 로그)에서 뽑는다 — hero 가 그 틱으로 바로 seek 한다. */
const one = measureThrough(cfg, [SEED]);
console.log(`\n## 눈으로 볼 장면 (m3c-on.json — 아래 초로 seek)`);
if (one.scenes.length === 0) console.log("  (이 시드엔 스루패스가 없다 — 8시드 표에서 고른다)");
for (const s of one.scenes) {
  console.log(
    `  ${disp(s.tick)} (t${s.tick}) ${s.side} ${s.passerId} → ${s.receiverId} — 공은 발밑이 아니라 ` +
      `(${s.x.toFixed(1)},${s.y.toFixed(1)}) 로 간다. 리드 ${s.leadM.toFixed(1)}m · 패스 길이 ${s.distM.toFixed(1)}m · ` +
      `라인 뒤 ${s.behindLine ? "O" : "X"} · 경주계수 ${s.raceFrac?.toFixed(2)}`,
  );
}

/** 계량은 8시드로. **출하 config 안에서** through 팔 vs 발밑 팔. */
const r = measureThrough(cfg, SEEDS);
const o = measureThrough(off, SEEDS);
const row = (label: string, a: AimArm) =>
  console.log(
    `  ${label.padEnd(16)} n=${String(a.n).padStart(5)} · 리드 p50 ${a.leadP50.toFixed(2)}m p90 ${a.leadP90.toFixed(2)}m ` +
      `평균 ${a.leadAvgM.toFixed(2)}m · 10~25m 밴드 ${a.band10to25Pct.toFixed(2)}% · 라인 뒤 ${a.behindLinePct.toFixed(2)}%`,
  );

console.log(`\n## 리드 거리 — 출하 config 한 경기 안에서 (8시드 · 패스 ${r.passes}건)`);
row("through(공간)", r.through);
row("footed(발밑)", r.footed);
row("전체", r.all);
console.log(`  대조군(스루패스 off, 8시드): 전체 리드 p50 ${o.all.leadP50.toFixed(2)}m · 10~25m ${o.all.band10to25Pct.toFixed(2)}%`);

console.log(`\n## 생성 게이트 — "왜 이 빈도인가" (8시드)`);
const g = r.gates;
console.log(
  `  심사 ${g.mates} → 오프사이드 −${g.offside} · 전진아님 −${g.notRunning} · 라인뒤아님 −${g.notBehind} · ` +
    `전진이득없음 −${g.noForward} · 러너늦음 −${g.runnerLate} · 경주패배 −${g.lostRace} → **생성 ${g.generated}** · 채택 ${r.pickedThrough}`,
);
console.log(`  결정 ${r.decisions}회 중 채택 ${r.pickedThrough}건 = 경기당 ${(r.pickedThrough / SEEDS.length).toFixed(2)}건`);

console.log(`\n## 상대 최종수비 뒤 공격수 (W0 기준선 지표)`);
console.log(`  on  ${r.behindLineAttackers.toFixed(3)}명   off ${o.behindLineAttackers.toFixed(3)}명`);
