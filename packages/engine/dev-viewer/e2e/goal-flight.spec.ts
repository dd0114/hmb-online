import { test, expect } from "@playwright/test";
import {
  loadViewer, eventsOfType, events, ballAtTick, inGoalMouth,
  sampleRenderedFlight, maxStep, launchTickOf, SHOT_BALL_SPEED,
} from "./fixture";

// 골 장면 계약 두 가지:
//  (1) [통과해야 함] 골 순간 공은 네트(골문 안)에 있다 — 이건 현재도 맞음.
//  (2) [버그 박제 — V3 가 해제] 슛 발사→네트 비행이 순간이동하면 안 된다.

test("goal 순간 공은 네트(골문 안)에 있다", async ({ page }) => {
  await loadViewer(page);
  const goals = await eventsOfType(page, "goal");
  expect(goals.length).toBeGreaterThan(0);
  for (const g of goals) {
    const ball = await ballAtTick(page, g.tick);
    expect(inGoalMouth(ball), `goal t${g.tick} 공(${ball.x.toFixed(1)},${ball.y.toFixed(1)})`).toBe(true);
  }
});

// 렌더된(보간 후) 공을 발사틱→골틱 구간에서 촘촘히 샘플. 부드러운 비행이면 프레임당 이동량이
// 대략 shotBallSpeed*step 이내여야 한다. 현재는 goal 이 REPOSITION 보간컷에 포함돼(playback.mjs)
// 마지막 레그가 하드컷 → 한 프레임에 십수 m 점프(순간이동) → FAIL.
// V3(뷰어 수정: goal 을 컷에서 분리)가 보간을 살리면 통과 → test.fail 해제.
const STEP = 0.1;
const MAX_FLIGHT_STEP = SHOT_BALL_SPEED * STEP * 2; // 여유 2배 = 2.8m. 순간이동(십수 m)은 명백히 초과.

test.describe("골 비행 순간이동 금지", () => {
  // V3(#16) 적용: playback.mjs 에서 goal 을 REPOSITION 보간컷에서 제외 → 이제 통과.
  test("발사→네트 비행에서 인접 프레임 공 이동량이 상한 이내", async ({ page }) => {
    await loadViewer(page);
    const all = await events(page);
    const goals = await eventsOfType(page, "goal");
    expect(goals.length).toBeGreaterThan(0);
    for (const g of goals) {
      const launch = launchTickOf(g.tick, all);
      expect(launch, `goal t${g.tick} 의 발사 슛틱`).not.toBeNull();
      const path = await sampleRenderedFlight(page, launch as number, g.tick, STEP);
      const m = maxStep(path);
      expect(
        m,
        `goal t${g.tick}: 발사 t${launch}→네트 t${g.tick} 최대 프레임 이동 ${m.toFixed(1)}m > ${MAX_FLIGHT_STEP}m = 순간이동`
      ).toBeLessThanOrEqual(MAX_FLIGHT_STEP);
    }
  });
});
