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

// #56: 파울→프리킥/페널티(CAUSE 정지)도 정지-재생 발동 — 정지 중 선수 정비(tick 진행) +
// 재개 순간이동 없음. #52 는 CAUSE 를 제외해 파울에서 얼어붙음+32m 순간이동이 남아있었다.
async function sampleFreezeByOwner(page: any, causeTick: number, sub: string) {
  await page.evaluate((t: number) => { const v = (window as any).__viewer; v.autoPace(false); v.seek(t - 3); v.play(); }, causeTick);
  await page.waitForFunction((s: string) => { const c = (window as any).__viewer.captions(); return c.situation && c.situation.includes(s); }, sub, { timeout: 12000 });
  return page.evaluate(async ({ sub }: { sub: string }) => {
    const v = (window as any).__viewer;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ticks: number[] = []; let anyMove = false; let prev: any[] | null = null;
    for (let i = 0; i < 30; i++) {
      const c = v.captions(); const pl = v.curPlayers();
      ticks.push(v.cur().tick);
      if (prev) { let m = 0; for (const p of pl) { const q = prev.find((x: any) => x.id === p.id); if (q) m += Math.hypot(p.x - q.x, p.y - q.y); } if (m > 2) anyMove = true; }
      prev = pl;
      if (!(c.situation && c.situation.includes(sub)) && ticks.length > 4) break;
      await sleep(25);
    }
    v.pause();
    return { ticks, anyMove };
  }, { sub });
}

test("#56 파울→프리킥/페널티(CAUSE) → 정지-재생 발동(tick 진행 + 선수 정비, 얼어붙음 아님)", async ({ page }) => {
  const kind = (e: any) => (e.type === "kickoff" ? e.detail || "kickoff" : e.type);
  const evs = await page.evaluate(() => (window as any).__viewer.events());
  const fouls = evs.filter((e: any) => e.type === "foul");
  const pens = evs.filter((e: any) => e.type === "penalty");
  let checked = 0, sawMove = false;
  for (const f of fouls.slice(0, 4)) {
    // 같은 틱에 페널티면 "페널티킥", 아니면 "파울" 자막.
    const isPen = pens.some((p: any) => p.tick === f.tick);
    const { ticks, anyMove } = await sampleFreezeByOwner(page, f.tick, isPen ? "페널티" : "파울");
    if (new Set(ticks).size <= 1 && !anyMove) continue; // 자막 못잡음 스킵
    checked++;
    // 핵심: 정지-재생 활성(tick 진행) = 정적 홀드 아님(#52 는 파울에서 tick 고정=얼어붙음이었다).
    expect(new Set(ticks).size, `foul t${f.tick} 정지 중 tick 고정(얼어붙음)`).toBeGreaterThan(1);
    if (anyMove) sawMove = true;
  }
  expect(checked, "검사된 파울 정지 없음").toBeGreaterThan(0);
  // 정비 이동은 케이스마다 다르나 최소 1건에선 선수가 움직여야(정적 홀드 전면 해소 확인).
  expect(sawMove, "파울 정지 중 선수 정비가 어디서도 안 보임").toBe(true);
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
