import { test, expect } from "@playwright/test";
import {
  loadViewer, eventsOfType, ballAtTick, PITCH_W, PITCH_H,
  screenGeomAt, circleInside, takerSlideBeforeRestart,
} from "./fixture";

// 세트피스 재배치 계약: 재시작 이벤트 순간 공이 그 세트피스에 맞는 위치로 옮겨져 있는가.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

const nearLine = (v: number, line: number, tol = 1.5) => Math.abs(v - line) <= tol;

test("corner → 공이 코너 깃발(골라인×사이드라인 모서리)에 있다", async ({ page }) => {
  const corners = await eventsOfType(page, "kickoff", "corner");
  expect(corners.length).toBeGreaterThan(0);
  const b = await ballAtTick(page, corners[0].tick);
  const onGoalLine = nearLine(b.x, 0) || nearLine(b.x, PITCH_W);
  const onSide = nearLine(b.y, 0) || nearLine(b.y, PITCH_H);
  expect(onGoalLine && onSide, `corner 공(${b.x.toFixed(1)},${b.y.toFixed(1)})`).toBe(true);
});

test("throw_in → 공이 사이드라인 위에 있다", async ({ page }) => {
  const t = await eventsOfType(page, "kickoff", "throw_in");
  expect(t.length).toBeGreaterThan(0);
  const b = await ballAtTick(page, t[0].tick);
  expect(nearLine(b.y, 0) || nearLine(b.y, PITCH_H), `throw_in 공 y=${b.y.toFixed(1)}`).toBe(true);
});

// ── 뷰어 가시성 계약 (#26): 세트피스 taker 와 공이 캔버스 밖으로 잘리면 안 된다. ──
// 엔진은 taker 를 터치라인/코너점(경계) 위에 세운다(실축구상 정상). 뷰어가 그걸 캔버스
// 끝에서 잘라 "던지는 선수가 안 보이는" 인지 갭이 생겼다(#26). freeze 전체뷰에서 taker
// 마커와 공이 완전히 캔버스 안에 보여야 한다.
test("corner → taker 마커와 공이 캔버스 안에 완전히 보인다(경계서 안 잘림)", async ({ page }) => {
  const corners = await eventsOfType(page, "kickoff", "corner");
  expect(corners.length).toBeGreaterThan(0);
  for (const c of corners) {
    const g = await screenGeomAt(page, c.tick);
    expect(g.owner, `corner t${c.tick}: taker(공 소유자) 마커 없음`).not.toBeNull();
    expect(
      circleInside(g.cw, g.ch, g.owner!),
      `corner t${c.tick}: taker 마커 잘림 owner=${JSON.stringify(g.owner)} canvas=${g.cw}x${g.ch}`
    ).toBe(true);
    expect(
      circleInside(g.cw, g.ch, g.ball),
      `corner t${c.tick}: 공 잘림 ball=${JSON.stringify(g.ball)} canvas=${g.cw}x${g.ch}`
    ).toBe(true);
  }
});

test("throw_in → taker 마커와 공이 캔버스 안에 완전히 보인다(경계서 안 잘림)", async ({ page }) => {
  const throwins = await eventsOfType(page, "kickoff", "throw_in");
  expect(throwins.length).toBeGreaterThan(0);
  for (const t of throwins) {
    const g = await screenGeomAt(page, t.tick);
    expect(g.owner, `throw_in t${t.tick}: taker 마커 없음`).not.toBeNull();
    expect(
      circleInside(g.cw, g.ch, g.owner!),
      `throw_in t${t.tick}: taker 마커 잘림 owner=${JSON.stringify(g.owner)} canvas=${g.cw}x${g.ch}`
    ).toBe(true);
    expect(
      circleInside(g.cw, g.ch, g.ball),
      `throw_in t${t.tick}: 공 잘림 ball=${JSON.stringify(g.ball)} canvas=${g.cw}x${g.ch}`
    ).toBe(true);
  }
});

// 세트피스 taker 순간이동(슬라이드) 금지: 재배치 직전 프레임에 taker 가 공처럼 컷돼야(스팟으로
// 미끄러지지 않아야) 한다. 스로인/코너 공통(hero 보고: "스로인도 순간이동해").
test("throw_in → taker 가 스팟으로 슬라이드하지 않고 컷된다(순간이동 방지)", async ({ page }) => {
  const throwins = await eventsOfType(page, "kickoff", "throw_in");
  expect(throwins.length).toBeGreaterThan(0);
  for (const t of throwins) {
    if (!t.playerId) continue;
    const slide = await takerSlideBeforeRestart(page, t.tick, t.playerId);
    if (slide === null) continue;
    expect(slide, `throw_in t${t.tick} taker ${t.playerId} 슬라이드 ${slide?.toFixed(1)}m`).toBeLessThanOrEqual(3);
  }
});

test("corner → taker 가 스팟으로 슬라이드하지 않고 컷된다(순간이동 방지)", async ({ page }) => {
  const corners = await eventsOfType(page, "kickoff", "corner");
  expect(corners.length).toBeGreaterThan(0);
  for (const c of corners) {
    if (!c.playerId) continue;
    const slide = await takerSlideBeforeRestart(page, c.tick, c.playerId);
    if (slide === null) continue;
    expect(slide, `corner t${c.tick} taker ${c.playerId} 슬라이드 ${slide?.toFixed(1)}m`).toBeLessThanOrEqual(3);
  }
});

test("goal_kick → 공이 골라인 부근 골에어리어에 있다", async ({ page }) => {
  const g = await eventsOfType(page, "kickoff", "goal_kick");
  expect(g.length).toBeGreaterThan(0);
  const b = await ballAtTick(page, g[0].tick);
  const nearGoalLine = b.x <= 8 || b.x >= PITCH_W - 8; // 골에어리어 깊이(~5.5m) 여유.
  expect(nearGoalLine, `goal_kick 공 x=${b.x.toFixed(1)}`).toBe(true);
});
