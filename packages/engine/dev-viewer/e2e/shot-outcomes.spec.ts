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

test("#91 save→corner → 공이 골라인 밖 와이드로 나간다(키퍼에 안 멈춤, 골 오인 없음)", async ({ page }) => {
  const saves = await eventsOfType(page, "save");
  const corners = await eventsOfType(page, "kickoff", "corner");
  let checked = 0;
  for (const s of saves) {
    // 코너로 굴절된 세이브만: 굴절 코너는 **공격팀**(세이브한 키퍼 팀의 상대)에게 주어진다.
    // team 이 같은 근접 코너는 반대 골문의 무관한 플레이(오탐) — 제외해야 평범한 GK 캐치를 오판하지 않는다.
    const corner = corners.find((c) => c.tick > s.tick && c.tick <= s.tick + 8 && c.team !== s.team);
    if (!corner) continue;
    const ball = await ballAtTick(page, s.tick);
    if (!ball) continue;
    // 공이 골라인 밖으로 나감(키퍼 앞에 잡혀 멈추지 않음) = off_target 처럼 라이브로 나가는 게 보임.
    expect(outsideGoalLine(ball), `save→corner t${s.tick}: 공이 골라인 밖으로 나가야 (${ball.x.toFixed(1)},${ball.y.toFixed(1)})`).toBe(true);
    // 골문 안(포스트 사이)이 아님 = 와이드 굴절 → 골 오인 없음(V2 #15 보존).
    expect(inGoalMouth(ball), `save→corner t${s.tick}: 공이 골문 안이면 골 오인 (${ball.x.toFixed(1)},${ball.y.toFixed(1)})`).toBe(false);
    checked++;
  }
  expect(checked, "판정 가능한 save→corner 없음").toBeGreaterThan(0);
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
