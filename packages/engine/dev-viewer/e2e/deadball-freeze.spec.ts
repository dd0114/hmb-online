import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType } from "./fixture";

// #52: 데드볼 정지 재생 + taker 워크인. 정지 중 선수들이 정비 이동(tick 진행)하고,
// taker 가 스팟으로 순간이동하지 않고 걸어온다(단일 프레임 점프 ≤ 걷기속도).
test.beforeEach(async ({ page }) => { await loadViewer(page); });

/** causeTick 부근 재생 → 자막 등장 후 정지 구간 동안 taker 렌더 경로 + tick 샘플. */
async function sampleFreeze(page: any, causeTick: number, sub: string, takerId: string) {
  await page.evaluate((t: number) => { const v = (window as any).__viewer; v.autoPace(false); v.seek(t - 2); v.play(); }, causeTick);
  await page.waitForFunction((s: string) => { const c = (window as any).__viewer.captions(); return c.situation && c.situation.includes(s); }, sub, { timeout: 12000 });
  const res = await page.evaluate(async ({ sub, taker }: { sub: string; taker: string }) => {
    const v = (window as any).__viewer;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const takerPath: { x: number; y: number }[] = []; const ticks: number[] = [];
    for (let i = 0; i < 30; i++) {
      const c = v.captions();
      const tk = v.curPlayers().find((p: any) => p.id === taker);
      if (tk) takerPath.push({ x: tk.x, y: tk.y });
      ticks.push(v.cur().tick);
      if (!(c.situation && c.situation.includes(sub)) && ticks.length > 4) break; // 정지 끝
      await sleep(25);
    }
    v.pause();
    return { takerPath, ticks };
  }, { sub, taker: takerId });
  return res as { takerPath: { x: number; y: number }[]; ticks: number[] };
}

function maxJump(path: { x: number; y: number }[]) {
  let m = 0;
  for (let i = 1; i < path.length; i++) m = Math.max(m, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  return m;
}

test("#52 throw_in → taker 워크인(단일프레임 점프 ≤ 걷기) + 정지 중 tick 진행(정비 재생)", async ({ page }) => {
  const throwins = await eventsOfType(page, "kickoff", "throw_in");
  let checked = 0;
  for (const t of throwins.slice(0, 4)) {
    if (!t.playerId) continue;
    const { takerPath, ticks } = await sampleFreeze(page, t.tick, "스로인", t.playerId);
    if (takerPath.length < 3) continue;
    checked++;
    expect(maxJump(takerPath), `throw_in t${t.tick} taker 단일프레임 점프(순간이동)`).toBeLessThanOrEqual(4);
    expect(new Set(ticks).size, `throw_in t${t.tick} 정지 중 tick 고정(정적 홀드=정비 안 보임)`).toBeGreaterThan(1);
  }
  expect(checked, "검사된 스로인 없음").toBeGreaterThan(0);
});

test("#52 corner → taker 워크인 + 정지 중 tick 진행", async ({ page }) => {
  const corners = await eventsOfType(page, "kickoff", "corner");
  let checked = 0;
  for (const c of corners.slice(0, 4)) {
    if (!c.playerId) continue;
    const { takerPath, ticks } = await sampleFreeze(page, c.tick, "코너킥", c.playerId);
    if (takerPath.length < 3) continue;
    checked++;
    expect(maxJump(takerPath), `corner t${c.tick} taker 단일프레임 점프(순간이동)`).toBeLessThanOrEqual(4);
    expect(new Set(ticks).size, `corner t${c.tick} 정지 중 tick 고정`).toBeGreaterThan(1);
  }
  expect(checked, "검사된 코너 없음").toBeGreaterThan(0);
});
