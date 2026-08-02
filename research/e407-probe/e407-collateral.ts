/**
 * #407 ⑦ — 부수 계약 4건의 **callProb 반응 곡선**(분석 전용, 프로덕션 무수정).
 *
 * 오프사이드 콜을 밴드에 넣자 `npm test` 에서 계약 4건이 새로 빨개졌다. 그 4건이 (a) 노브의
 * 단조 함수인가(= 내가 만든 회귀) 아니면 (b) 임계 근처에서 표본에 흔들리는 계약인가를 가른다.
 * 지표 정의는 **각 계약이 쓰는 함수를 그대로 재사용**한다(새로 정의하지 않는다).
 *
 * 실행:
 *   node tools/run-gate.mjs --label e407-ofs -- npx tsx research/e407-probe/e407-collateral.ts
 * 환경변수: HMB_RUNGS(기본 0.013,0.03,0.045,0.06,0.07,0.1)
 */
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config";
import { REALISM_SEEDS } from "../../packages/engine/src/realism/harness";
import { measureBehaviour, aggregateBehaviour } from "../../packages/engine/src/realism/behaviour";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures";
import { runMatch } from "../../packages/engine/src/match";

const RUNGS = (process.env.HMB_RUNGS || "0.013,0.03,0.045,0.06,0.07,0.1")
  .split(",")
  .map((s) => Number(s.trim()));
const SEEDS = REALISM_SEEDS.slice(0, 16); // behaviour.test.ts 와 **같은 표본**
const select = makeSelectData();

function cfgWith(v: number): EngineConfig {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  c.rules.offside.callProb = v;
  return c;
}

console.log(`# e407 ⑦ 부수 계약 반응 — behaviour(n16), engine@${defaultEngineConfig.version}`);
console.log("callProb".padEnd(10) + "걷어내기".padStart(12) + "  (밴드 ≥5.0)");
for (const v of RUNGS) {
  const c = cfgWith(v);
  const m = aggregateBehaviour(
    SEEDS.map((seed) =>
      measureBehaviour(runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, c), c.pitch.width),
    ),
  );
  console.log(v.toFixed(4).padEnd(10) + m.clearances.toFixed(2).padStart(12) + (m.clearances >= 5 ? "  OK" : "  LOW"));
}
