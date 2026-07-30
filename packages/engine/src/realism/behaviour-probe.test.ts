import { describe, it, expect } from "vitest";
import { runMatch } from "../match";
import { defaultEngineConfig } from "../config";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { aggregateBehaviour, measureBehaviour, type BehaviourMetrics } from "./behaviour";

/**
 * #314 행동·의도 계층 진단(env 가드). `npm test` 에서는 skip.
 * 실행: `HMB_BEHAV=1 npx vitest run packages/engine/src/realism/behaviour-probe.test.ts`
 *
 * hero 실관전 제보 ⓐ 걷어내기 · ⓑ 침투/반응 · ⓒ 비소유 정지 를 **전후 비교 가능한 수치**로 찍는다.
 * 판정(계약)은 `behaviour.test.ts` 가 하고, 이 파일은 리포트 전용이다.
 */
const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_BEHAV;
const SEEDS = REALISM_SEEDS;

function f(v: number, d = 2): string {
  return (Math.round(v * 10 ** d) / 10 ** d).toString();
}

describe("#314 행동·의도 계층 진단", () => {
  it.skipIf(!GEN)("A/B/C 지표를 20시드로 집계", () => {
    const cfg = defaultEngineConfig;
    const select = makeSelectData();
    const rows: BehaviourMetrics[] = SEEDS.map((seed) =>
      measureBehaviour(
        runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg),
        cfg.pitch.width,
      ),
    );
    const m = aggregateBehaviour(rows);
    const L = [
      `=== #314 BEHAVIOUR PROBE (${cfg.version}, ${SEEDS.length} seeds) ===`,
      `A 걷어내기   clearance ${f(m.clearances)}/팀 · throwIn ${f(m.throwIns)}/팀 · foul ${f(m.fouls)}/팀`,
      `B 침투/반응  패스발사시 전방러너 ${f(m.fwdRunnersAtPass)}명 · 러너최근접수비 ${f(m.runnerMarkDistM)}m · 패서전진 ${f(m.passerForwardPct)}% (n=${f(m.passLaunches, 0)})`,
      `C 비소유정지 비소유 ${f(m.nonPossStillPct)}% (${f(m.nonPossStepM, 3)} m/tick) · 소유 ${f(m.possStillPct)}% (${f(m.possStepM, 3)} m/tick)`,
      `C2 데드볼    taker ${f(m.deadTakerStepM, 3)} · other ${f(m.deadOtherStepM, 3)} · 비대칭 ${f(m.deadAsymmetry, 3)}`,
    ];
    // eslint-disable-next-line no-console
    console.log("\n" + L.join("\n") + "\n");
    expect(rows.length).toBe(SEEDS.length);
  }, 900_000);
});
