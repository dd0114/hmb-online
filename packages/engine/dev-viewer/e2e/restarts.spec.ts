import { test, expect } from "@playwright/test";
import {
  loadViewer, eventsOfType, ballAtTick, PITCH_W, PITCH_H,
  screenGeomAt, circleInside, takerSlideBeforeRestart,
  VIEWER_REAL_URL, events, playUntilSituationContains,
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

// ── #42: CAUSE 정지 skip 이 라이브 플레이를 삼키면 안 된다. ──
// 세이브 후 공이 라이브인 체인(패스→2차슛→빗나감→골킥)에서, 세이브 정지가 다음 재시작까지
// 하드 스킵하면 중간 '빗나감!' 상황카드가 통째로 드롭된다(관객은 왜 골킥인지 모름).
// 계약: 라이브 체인을 지나 재생하면 중간 상황카드가 실제로 발화해야 한다. (real 픽스처 커버)
test("세이브→라이브 체인→골킥: 중간 '빗나감' 상황카드가 드롭되지 않는다 (#42)", async ({ page }) => {
  await loadViewer(page, VIEWER_REAL_URL);
  const all = await events(page);
  const kind = (e: { type: string; detail?: string }) =>
    e.type === "kickoff" ? (e.detail || "kickoff") : e.type === "shot" && e.detail ? "shot_" + e.detail : e.type;
  const RESTART = new Set(["corner", "goal_kick", "throw_in", "free_kick", "kickoff"]);
  // 패턴 탐색: save → (라이브 이벤트 ≥1) → shot_off_target → (다음 재시작), 스팬 45틱 이내.
  let found: { save: number; off: number } | null = null;
  for (let i = 0; i < all.length && !found; i++) {
    if (kind(all[i]) !== "save") continue;
    for (let j = i + 1; j < all.length && all[j].tick <= all[i].tick + 45; j++) {
      const k = kind(all[j]);
      if (RESTART.has(k)) break; // 세이브 직후 곧장 재시작(체인 아님) → 다음 save 로
      if (k === "shot_off_target" && j > i + 1) { found = { save: all[i].tick, off: all[j].tick }; break; }
    }
  }
  expect(found, "real 픽스처에 세이브→라이브 체인→빗나감 케이스가 있어야(없으면 픽스처 시드 확인)").toBeTruthy();
  // 세이브 직전부터 실제 재생 → '선방!' 정지를 지나 라이브 체인이 재생되고 '빗나감!' 카드가 떠야 한다.
  const caps = await playUntilSituationContains(page, found!.save - 2, "빗나감", 20000);
  expect(caps.situation).toContain("빗나감");
});

test("goal_kick → 공이 골라인 부근 골에어리어에 있다", async ({ page }) => {
  const g = await eventsOfType(page, "kickoff", "goal_kick");
  expect(g.length).toBeGreaterThan(0);
  const b = await ballAtTick(page, g[0].tick);
  const nearGoalLine = b.x <= 8 || b.x >= PITCH_W - 8; // 골에어리어 깊이(~5.5m) 여유.
  expect(nearGoalLine, `goal_kick 공 x=${b.x.toFixed(1)}`).toBe(true);
});
