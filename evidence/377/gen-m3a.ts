/**
 * #377 M3-A 관전 증거 생성기 (#369 예고 패스 — 받는 쪽이 패서의 의도를 미리 읽는다).
 *
 * 실행: `npx tsx evidence/377/gen-m3a.ts`
 * 산출: evidence/377/m3a-{on,off}.json — **같은 시드, 예고만 on/off**. 나란히 본다.
 *      (표·타임스탬프는 stdout — evidence/377/M3-A.md 의 수치가 이 출력이다)
 *
 * ## 왜 쌍인가
 * "리시버가 미리 움직인다"는 한 경기만 봐서는 판정할 수 없다 — 리시버는 예고가 없어도
 * 자기 역할 자리로 움직이기 때문이다(W0 의 80.8% 오측정이 정확히 그 함정이었다).
 * 같은 시드에서 `movement.passPlan.enabled` 만 끄면 **같은 상황의 같은 장면**이 구 동작으로
 * 나오므로, 그 둘을 나란히 놓는 것이 유일한 관전 증거다.
 *
 * ## 측정은 계약과 **같은 함수**로 한다
 * `packages/engine/src/realism/pass-plan.ts` 의 `measurePlanLead` 를 그대로 쓴다. 증거와 계약이
 * 다른 함수를 쓰면 "증거는 좋은데 계약은 통과"가 성립한다(`loft.ts` 선례).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config.ts";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures.ts";
import { measurePlanLead, allReadConfig, type PlanLead } from "../../packages/engine/src/realism/pass-plan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = "1618033988";
const select = makeSelectData();
const cfg = defaultEngineConfig;
const off: EngineConfig = {
  ...cfg,
  movement: { ...cfg.movement, passPlan: { ...cfg.movement.passPlan, enabled: false } },
};

const disp = (tick: number): string => {
  const scale = (cfg.displayMinutes ?? cfg.matchMinutes) / cfg.matchMinutes;
  const sec = Math.round(((tick * cfg.msPerTick) / 1000) * scale);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

const bake = (config: EngineConfig, name: string): MatchLog => {
  const log = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), select, config);
  writeFileSync(join(here, `m3a-${name}.json`), JSON.stringify(log));
  return log;
};

const on = bake(cfg, "on");
const legacy = bake(off, "off");

/** 출하 팔(readBase 0.35) 과 전원 읽기 팔 — 왜 둘인지는 `pass-plan.ts` 헤더. */
const ship = measurePlanLead(cfg, [SEED]);
const all = measurePlanLead(allReadConfig(cfg), [SEED]);

console.log(`# M3-A 관전 증거 — seed ${SEED} · ${cfg.version}`);
console.log(`\n## 로그 (뷰어에 드롭해 나란히 본다)`);
console.log(`  m3a-on.json   예고 on  — score ${on.finalScore.home}:${on.finalScore.away} · 이벤트 ${on.events.length}`);
console.log(`  m3a-off.json  예고 off — score ${legacy.finalScore.home}:${legacy.finalScore.away} · 이벤트 ${legacy.events.length}`);

const row = (label: string, r: PlanLead) =>
  console.log(
    `  ${label.padEnd(22)} 게시 ${String(r.plans).padStart(3)}건 · 창 안 발사 ${String(r.launched).padStart(3)}건(선행 ${r.leadTicks.toFixed(2)}틱) · ` +
      `발사 전 좁힌 거리 ${r.gainAvgM.toFixed(2)}m · 좁힌 장면 ${r.gainPosPct.toFixed(1)}%`,
  );

console.log(`\n## 예고가 실제로 서고, 읽은 리시버가 먼저 움직인다`);
row("출하값(read 0.35)", ship);
row("전원 읽기(read 1.0)", all);
console.log(
  `  ⚠️ 출하 팔이 음수인 것이 정상이다 — 3분의 2는 **안 읽으므로** 자기 역할 자리로 간다.\n` +
    `     기제는 전원 읽기 팔에서 보고, 빈도는 readBase 가 정한다(= 훈련·능력).`,
);

console.log(`\n## 눈으로 볼 장면 (m3a-on.json, 위 초로 seek)`);
for (const s of ship.scenes.slice(0, 5)) {
  console.log(
    `  ${disp(s.tick)} (t${s.tick}) ${s.side} ${s.forId} — 공이 아직 ${s.leadTicks}틱 뒤에 떠난다. ` +
      `도착 예정 (${s.x.toFixed(1)},${s.y.toFixed(1)}) 까지 ${s.d0.toFixed(1)}m → ${s.d1.toFixed(1)}m (${s.gained.toFixed(1)}m 먼저 좁힘)`,
  );
}
