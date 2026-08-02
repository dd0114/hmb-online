/**
 * #407 Phase 2-A 부속 — 권장안(`chain.goalValue` 22→13 · `contest.shootRange` 19→13)에서
 * **1대1 라벨(`detail="one_on_one"`)이 소멸하지 않는지** 확인한다.
 *
 * 왜: config.ts:2009 가 gv 9.4→8.0 에서 one_on_one 라벨이 0.117 → **0.000** 이 되어
 * `one-on-one.test.ts`(#316) 가 깨진 전례를 기록해 뒀다. gv 를 내리는 안은 전부 이 확인이 필요하다.
 *
 * 실행: node tools/run-gate.mjs --label e407-1v1 -- npx tsx research/e407-probe/e407-oneonone-check.ts
 */
import { defaultEngineConfig } from "../../packages/engine/src/config";
import { applyConfigOverrides } from "../../packages/engine/src/realism/config-override";
import { GUARD_SEEDS, REALISM_SEEDS } from "../../packages/engine/src/realism/harness";
import { runMatch } from "../../packages/engine/src/match";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures";

const N = Number(process.env.HMB_SEEDS || 60);
const SEEDS = N > 20 ? GUARD_SEEDS.slice(0, N) : REALISM_SEEDS.slice(0, N);
const select = makeSelectData();

const POINTS: { label: string; ov: Record<string, unknown> }[] = [
  { label: "base 0.40.0", ov: {} },
  { label: "안A gv13 r13", ov: { "chain.goalValue": 13, "contest.shootRange": 13 } },
  { label: "안A' gv8 r16", ov: { "chain.goalValue": 8, "contest.shootRange": 16 } },
  { label: "안B r12.8", ov: { "contest.shootRange": 12.8 } },
  { label: "안C disc.99 r15.5", ov: { "chain.discount": 0.99, "contest.shootRange": 15.5 } },
  { label: "C2 disc.99 r16", ov: { "chain.discount": 0.99, "contest.shootRange": 16 } },
  { label: "C3 disc.95 r15", ov: { "chain.discount": 0.95, "contest.shootRange": 15 } },
  { label: "C4 disc.97 r16", ov: { "chain.discount": 0.97, "contest.shootRange": 16 } },
];

console.log(`# one_on_one 라벨 생존 확인 — 시드 ${SEEDS.length}(팀-경기 ${SEEDS.length * 2})`);
console.log("지점".padEnd(22) + "1대1/팀경기".padStart(12) + "슛".padStart(9) + "1대1 슛비중%".padStart(14) + "0건 경기%".padStart(12));
for (const p of POINTS) {
  const cfg = Object.keys(p.ov).length ? applyConfigOverrides(defaultEngineConfig, p.ov) : defaultEngineConfig;
  let one = 0;
  let shots = 0;
  let zeroTeamMatches = 0;
  for (const seed of SEEDS) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
    const per: Record<string, number> = { home: 0, away: 0 };
    for (const e of log.events) {
      if (e.type !== "shot" || e.detail === "saved" || e.detail === "off_target") continue;
      shots += 1;
      if (e.detail === "one_on_one" && e.team) {
        one += 1;
        per[e.team] += 1;
      }
    }
    for (const s of ["home", "away"]) if (per[s] === 0) zeroTeamMatches += 1;
  }
  const tm = SEEDS.length * 2;
  console.log(
    p.label.padEnd(22) +
      (one / tm).toFixed(3).padStart(12) +
      (shots / tm).toFixed(2).padStart(9) +
      (shots ? ((one / shots) * 100).toFixed(2) : "0").padStart(14) +
      ((zeroTeamMatches / tm) * 100).toFixed(1).padStart(12),
  );
}
