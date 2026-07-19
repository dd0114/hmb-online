import { test, expect } from "@playwright/test";
import { loadViewer } from "./fixture";

// F1(#100) 계약: 실시간 통계 HUD — 현재 틱까지 누적, 재생에 따라 갱신, 최종=전체 합.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

test("liveStats 는 틱 진행에 따라 누적(단조 비감소) + 초반<후반", async ({ page }) => {
  const early = await page.evaluate(() => { (window as any).__viewer.seek(60); return (window as any).__viewer.liveStats(); });
  const late = await page.evaluate(() => { const v = (window as any).__viewer; const ev = v.events(); return (v.seek(ev[ev.length - 1].tick + 1), v.liveStats()); });
  const totEarly = early.home.shots + early.away.shots;
  const totLate = late.home.shots + late.away.shots;
  expect(totLate).toBeGreaterThan(totEarly);
  // 카운트는 감소하지 않는다.
  expect(late.home.corners).toBeGreaterThanOrEqual(early.home.corners);
  expect(late.home.goals).toBeGreaterThanOrEqual(early.home.goals);
});

test("최종 liveStats 합 = 실제 스코어(골) + 점유율 0..100", async ({ page }) => {
  const s = await page.evaluate(() => { const v = (window as any).__viewer; const ev = v.events(); return (v.seek(ev[ev.length - 1].tick + 1), v.liveStats()); });
  const finalScore = await page.evaluate(() => {
    // 스코어보드에서 최종 스코어 읽기.
    return (window as any).__viewer.captions().score;
  });
  const totalGoals = s.home.goals + s.away.goals;
  const [fh, fa] = finalScore.split(":").map((x: string) => parseInt(x.trim(), 10));
  expect(s.home.goals).toBe(fh);
  expect(s.away.goals).toBe(fa);
  expect(totalGoals).toBe(fh + fa);
  expect(s.possessionHome).toBeGreaterThanOrEqual(0);
  expect(s.possessionHome).toBeLessThanOrEqual(100);
  expect(s.momentum).toBeGreaterThanOrEqual(-1);
  expect(s.momentum).toBeLessThanOrEqual(1);
});

test("HUD DOM 이 실시간 갱신 — 점유율%·통계 그리드가 재생 중 값 반영", async ({ page }) => {
  // 초반 seek → 그리드의 Shots 홈값.
  const readShots = () => page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#hudGrid .srow"));
    const shotRow = rows.find((r) => (r.querySelector(".slbl")?.textContent || "").includes("Shots"));
    return shotRow ? shotRow.querySelector(".sv.h")?.textContent : null;
  });
  await page.evaluate(() => (window as any).__viewer.seek(50));
  const earlyShots = Number(await readShots());
  await page.evaluate(() => { const v = (window as any).__viewer; const ev = v.events(); v.seek(ev[ev.length - 1].tick + 1); });
  const lateShots = Number(await readShots());
  expect(lateShots).toBeGreaterThan(earlyShots);
  // 점유율 텍스트가 %로 표시.
  const possText = await page.evaluate(() => document.getElementById("possH")?.textContent || "");
  expect(possText).toMatch(/^\d+%$/);
  // 그리드에 핵심 지표 라벨 존재.
  const labels = await page.$$eval("#hudGrid .slbl", (els) => els.map((e) => e.textContent));
  for (const need of ["Shots", "On target", "xG", "Pass %", "Corners", "Fouls", "Cards"]) {
    expect(labels).toContain(need);
  }
});
