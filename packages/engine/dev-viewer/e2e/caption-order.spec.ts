import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType, PITCH_H } from "./fixture";

// #49: 세트피스 자막 순서 — "스로인!/코너킥!" 판정 자막은 공이 라인 밖으로 나간(합성 아웃비행 완료,
// 공이 스팟 도달) **뒤에** 떠야 한다. #47 synth 는 freeze 도입부(SYNTH_MS) 동안 그려지는데 자막이
// freeze 시작과 동시 발화하면, 자막이 뜬 순간 공이 아직 필드 안에 있어 "판정이 먼저"로 꼬인다.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

/** seekTick-4 부터 재생 → substr 자막이 뜨는 순간의 render 공 위치. */
async function ballWhenCaption(page: any, seekTick: number, substr: string) {
  await page.evaluate((t: number) => { const v = (window as any).__viewer; v.autoPace(false); v.seek(t - 4); v.play(); }, seekTick);
  await page.waitForFunction(
    (s: string) => { const c = (window as any).__viewer.captions(); return c.situation && c.situation.includes(s); },
    substr,
    { timeout: 12000 },
  );
  const ball = await page.evaluate(() => (window as any).__viewer.render());
  await page.evaluate(() => (window as any).__viewer.pause());
  return ball as { x: number; y: number };
}

test("#49 throw_in → '스로인!' 자막이 뜨는 순간 공이 사이드라인(스팟)에 있다(공 나간 뒤 판정)", async ({ page }) => {
  const throwins = await eventsOfType(page, "kickoff", "throw_in");
  expect(throwins.length).toBeGreaterThan(0);
  for (const t of throwins.slice(0, 3)) {
    const ball = await ballWhenCaption(page, t.tick, "THROW");
    // 사이드라인(y=0 또는 68) ±3m 이내여야 한다 = 공이 나간 뒤 자막.
    const onSideline = Math.abs(ball.y - 0) <= 3 || Math.abs(ball.y - PITCH_H) <= 3;
    expect(
      onSideline,
      `throw_in t${t.tick}: '스로인!' 자막 순간 공 y=${ball.y.toFixed(1)} — 사이드라인 아님(공 나가기 전 자막)`,
    ).toBe(true);
  }
});

// #51 데드볼 재설계: 연속 스로인은 freeze 중 합성이 아니라 **라이브 보간**으로 공이 사이드라인까지
// 이동해야 한다(그 구간을 컷하지 않음). causeTick-1→causeTick 을 분수 tickPos 로 렌더해 공이 중간값
// 으로 보간되면 라이브(컷이면 중간 프레임이 직전 위치에 고정). 결정론적(wall-clock 무관).
test("#51 throw_in(연속) → 공이 라인 밖 나가는 구간을 라이브 보간(컷 아님)", async ({ page }) => {
  const throwins = await eventsOfType(page, "kickoff", "throw_in");
  expect(throwins.length).toBeGreaterThan(0);
  let liveCount = 0;
  for (const t of throwins) {
    const r = await page.evaluate((tick: number) => {
      const v = (window as any).__viewer;
      const ci = v.idxOfTick(tick);
      return { prev: v.renderAt(ci - 1), mid: v.renderAt(ci - 0.5), spot: v.renderAt(ci) };
    }, t.tick);
    // 사이드라인(y=0/68)으로 가는 스로인만 대상.
    const spotOnSide = r.spot.y <= 4 || r.spot.y >= 64;
    // 라이브 보간: 중간 프레임이 직전·스팟 양쪽과 뚜렷이 다름(컷이면 mid≈prev).
    const interpolated = Math.abs(r.mid.y - r.prev.y) > 1 && Math.abs(r.mid.y - r.spot.y) > 1;
    if (spotOnSide && interpolated) liveCount++;
  }
  expect(liveCount, "라이브 보간되는 연속 스로인이 없음 — R1(공 라이브 아웃) 미적용").toBeGreaterThan(0);
});

test("#49 corner → '코너킥!' 자막이 뜨는 순간 공이 골라인(스팟)에 도달해 있다", async ({ page }) => {
  const corners = await eventsOfType(page, "kickoff", "corner");
  expect(corners.length).toBeGreaterThan(0);
  for (const c of corners.slice(0, 3)) {
    const ball = await ballWhenCaption(page, c.tick, "CORNER");
    // 골라인(x=0 또는 105) ±3m 이내여야 한다.
    const onGoalLine = Math.abs(ball.x - 0) <= 3 || Math.abs(ball.x - 105) <= 3;
    expect(
      onGoalLine,
      `corner t${c.tick}: '코너킥!' 자막 순간 공 x=${ball.x.toFixed(1)} — 골라인 아님(공 나가기 전 자막)`,
    ).toBe(true);
  }
});
