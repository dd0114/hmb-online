import { expect, it } from "vitest";
import { CUT_TICK, buildMinigameLog, writeMinigameLog } from "./gen-minigame-log";

/**
 * #493 미니게임 자산 **재생성 전용** — 기본은 돌지 않는다 (`gen-p421-fixture.test.ts` 규율).
 * `src/minigame/minigame-log.json` 은 커밋된 자산이라, 이 테스트가 게이트에서 그냥 돌면
 * `npm test` 가 매번 현재 엔진으로 덮어써 커밋 자산의 의미가 사라진다(+ 다른 세션 트리 dirty).
 *
 *   HMB_GEN_MINIGAME=1 npx vitest run apps/web/scripts/gen-minigame-log.test.ts
 *
 * 쓰기 **전에** 표본 전제를 단언한다 — 엔진이 움직여 컷 창의 골이 사라졌다면 파일을 갈아엎기
 * 전에 여기서 멈추는 편이 낫다(CUT_TICK 재선정 신호).
 */
it.skipIf(!process.env.HMB_GEN_MINIGAME)("#493 미니게임 1분 컷 자산 생성 (실엔진 쇼케이스)", () => {
  const log = buildMinigameLog();
  const goals = log.events.filter((e) => e.type === "goal");

  // eslint-disable-next-line no-console
  console.log(
    `[minigame] seed=${log.seed} ver=${log.configVersion} cut=${CUT_TICK}\n` +
      `  snaps=${log.tickSnapshots.length} events=${log.events.length}\n` +
      `  goals=${goals.map((g) => `${g.team}@${g.tick}(${g.minute}')`).join(" ")} → ${log.finalScore.home}:${log.finalScore.away}`,
  );

  expect(goals.length, "컷 창 안 골 <2 — CUT_TICK 을 다시 골라라").toBeGreaterThanOrEqual(2);
  expect(log.tickSnapshots[0].tick).toBe(0);
  expect(log.tickSnapshots.length).toBe(CUT_TICK + 1); // 무솎기 + 연속

  const out = writeMinigameLog(log);
  // eslint-disable-next-line no-console
  console.log(`[minigame] wrote ${out}`);
});
