import { test, expect } from "@playwright/test";
import {
  loadViewer, eventsOfType, ballAtTick, PITCH_W, PITCH_H,
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

test("goal_kick → 공이 골라인 부근 골에어리어에 있다", async ({ page }) => {
  const g = await eventsOfType(page, "kickoff", "goal_kick");
  expect(g.length).toBeGreaterThan(0);
  const b = await ballAtTick(page, g[0].tick);
  const nearGoalLine = b.x <= 8 || b.x >= PITCH_W - 8; // 골에어리어 깊이(~5.5m) 여유.
  expect(nearGoalLine, `goal_kick 공 x=${b.x.toFixed(1)}`).toBe(true);
});
