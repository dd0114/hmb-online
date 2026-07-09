import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType, ballAtTick, outsideGoalLine, inGoalMouth, VIEWER_REAL_URL } from "./fixture";

// 슛 결과 공 위치 의미론: 결과 타입별로 공이 서로 다른 곳에 있어 관객이 구분 가능한가.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

test("off_target → 공이 골라인 밖으로 벗어난다(옆/뒤)", async ({ page }) => {
  // 쇼케이스 시드엔 off_target 이 없을 수 있어 real config 픽스처(off_target 다수)로 검증.
  await loadViewer(page, VIEWER_REAL_URL);
  const offs = await eventsOfType(page, "shot", "off_target");
  expect(offs.length).toBeGreaterThan(0);
  for (const o of offs) {
    // 빗맞은 슛은 다음 틱에 골라인 너머로 흘러 벗어나 보인다(overrunX).
    const ball = (await ballAtTick(page, o.tick + 1)) ?? (await ballAtTick(page, o.tick));
    expect(
      outsideGoalLine(ball),
      `off_target t${o.tick} 공(${ball.x.toFixed(1)},${ball.y.toFixed(1)}) 이 골라인 안 → 벗어남 안 보임`
    ).toBe(true);
    expect(inGoalMouth(ball)).toBe(false);
  }
});

test("one_on_one → 슛 이벤트로 발행되고 팀이 명시된다", async ({ page }) => {
  const one = await eventsOfType(page, "shot", "one_on_one");
  expect(one.length).toBeGreaterThan(0);
  for (const e of one) expect(e.team === "home" || e.team === "away").toBe(true);
});

test("penalty → PK 판정 + PK 슛(shot:penalty) 발행 (real 뷰어: PK 포함 시드)", async ({ page }) => {
  // 쇼케이스 시드엔 PK 가 없을 수 있어 real config 픽스처(PK 포함)로 검증.
  await loadViewer(page, VIEWER_REAL_URL);
  const award = await eventsOfType(page, "penalty");
  const pk = await eventsOfType(page, "shot", "penalty");
  expect(award.length).toBeGreaterThan(0);
  expect(pk.length).toBeGreaterThan(0);
});
