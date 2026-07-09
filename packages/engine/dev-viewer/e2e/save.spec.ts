import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType, ballAtTick, inGoalMouth } from "./fixture";

// [버그 박제 — V2 가 해제] 선방이 골처럼 보이는 근본 원인 = 엔진이 세이브된 공을
// 골라인 정중앙(골문 안)에 파킹한다(contest.ts resolveShot: keeperSpot=defendGoal=골문 중점).
// 계약: 선방 순간 공은 "골문 안(골라인±1m & 포스트 사이)"에 있으면 안 된다(골과 구분되게).
// 현재 코드에서는 (105,34)/(0,34) 로 파킹 → inGoalMouth=true → FAIL.
// V2(#15) 적용: resolveShot 이 세이브 공을 saveCatchDepthM(2.5m) 앞 캐치 지점에 둔다 → 이제 통과.
test("save 순간 공은 골문 안(골 위치)에 있으면 안 된다", async ({ page }) => {
  await loadViewer(page);
  const saves = await eventsOfType(page, "save");
  expect(saves.length).toBeGreaterThan(0);
  for (const sv of saves) {
    const ball = await ballAtTick(page, sv.tick);
    expect(
      inGoalMouth(ball),
      `save t${sv.tick} 공(${ball.x.toFixed(1)},${ball.y.toFixed(1)}) 이 골문 안 → 골 오인`
    ).toBe(false);
  }
});
