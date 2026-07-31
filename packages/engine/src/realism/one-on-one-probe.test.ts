import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { GUARD_SEEDS } from "./harness";
import { collectOneOnOne, renderOneOnOne } from "./one-on-one";

/**
 * 1대1(one_on_one) 찬스 **진단 프로브**(env 가드). `npm test` 에서는 skip.
 * 실행: `HMB_1V1=1 npx vitest run packages/engine/src/realism/one-on-one-probe.test.ts`
 *
 * 판정(계약)은 `one-on-one.test.ts` 가 하고, 이 파일은 **리포트 전용**이다(동작 변경 0).
 *
 * 답해야 할 질문: `shot:one_on_one` 이 0.067/경기인 이유가
 *  ① 기하 조건 자체가 안 생겨서인가, ② 생기는데 엔진이 슛을 안 골라서인가.
 */
const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_1V1;
const SEEDS = GUARD_SEEDS;

function withMode(mode: "chain" | "weighted"): EngineConfig {
  return { ...defaultEngineConfig, chain: { ...defaultEngineConfig.chain, mode } };
}
function withClear(clearM: number): EngineConfig {
  return {
    ...defaultEngineConfig,
    contest: { ...defaultEngineConfig.contest, oneOnOneClearM: clearM },
  };
}

describe("1v1 찬스 진단", () => {
  it.skipIf(!GEN)("① 조건 빈도 · ② 행동 분포 · ③ 거리 민감도 · ④ 박스 분리 (chain, 60시드)", () => {
    const r = collectOneOnOne(defaultEngineConfig, SEEDS);
    // eslint-disable-next-line no-console
    console.log("\n" + renderOneOnOne(r) + "\n");
    expect(r.matches).toBe(SEEDS.length);
  }, 3_600_000);

  it.skipIf(!GEN)("⑤ 대조군: weighted 코어 (60시드)", () => {
    const r = collectOneOnOne(withMode("weighted"), SEEDS);
    // eslint-disable-next-line no-console
    console.log("\n" + renderOneOnOne(r) + "\n");
    expect(r.matches).toBe(SEEDS.length);
  }, 3_600_000);

  /**
   * ③-b **실 재실행** 민감도. 위 표의 임계 스윕은 "같은 경기 위에서 임계만 바꿔 세기"라
   * 전개가 고정된 깨끗한 비교지만, `oneOnOneClearM` 은 실제로는 xG 부스트를 통해 **골 롤을
   * 바꾸므로 경기 전개 자체가 갈린다**. 그래서 config 를 실제로 바꿔 다시 돌린 값도 같이 낸다.
   */
  it.skipIf(!GEN)("③-b oneOnOneClearM 실 재실행(10/8/7/5m, 60시드)", () => {
    for (const m of [10, 8, 7, 5]) {
      const r = collectOneOnOne(withClear(m), SEEDS, [m]);
      const b = r.buckets[0]!;
      // eslint-disable-next-line no-console
      console.log(
        `[1v1 rerun] clearM=${m}m → 조건충족 ${b.ticks} (${(b.ticks / r.matches).toFixed(2)}/경기) · ` +
          `그중 shoot ${b.byKind.shoot} · one_on_one 라벨 ${r.oneOnOneEvents} (${(r.oneOnOneEvents / r.matches).toFixed(3)}/경기) · ` +
          `shot 이벤트 ${(r.shotEvents / r.matches).toFixed(2)}/경기`,
      );
    }
    expect(true).toBe(true);
  }, 7_200_000);
});
