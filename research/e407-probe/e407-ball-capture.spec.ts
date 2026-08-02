import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadViewer, VIEWER_URL } from "./fixture";

/**
 * E407 ④ — **실화면 캡처 전용**(판정 아님, 분석 증거 수집). `/visual-capture-qa` 절차.
 * 좌표 추론 금지 → 캔버스를 실제로 찍어 Read 로 눈으로 본다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const capDir = join(repoRoot, "research", "e407-capture");

function loadLog(seed: string): unknown {
  return JSON.parse(readFileSync(join(capDir, `log-${seed}.json`), "utf8"));
}

async function inject(page: import("@playwright/test").Page, seed: string): Promise<void> {
  mkdirSync(capDir, { recursive: true });
  await loadViewer(page, VIEWER_URL);
  await page.evaluate((log) => window.postMessage({ type: "loadMatchLog", matchLog: log }, "*"), loadLog(seed) as never);
  await page.waitForFunction(() => (window as any).__viewer?.ready(), null, { timeout: 30000 });
}

/** 소유 이전(꺾임) 전후 틱을 전체뷰/줌뷰로 찍는다. */
async function shoot(page: import("@playwright/test").Page, seed: string, tick: number, follow: boolean): Promise<unknown[]> {
  const geoms: unknown[] = [];
  if (follow) await page.click("#followBtn");
  for (const t of [tick - 2, tick - 1, tick, tick + 1, tick + 2]) {
    const g = await page.evaluate(
      ({ t }) => {
        const v = (window as any).__viewer;
        v.autoPace(false);
        v.seek(t);
        v.render();
        const geom = v.screenGeom();
        const c = v.cur();
        return { tick: c.tick, ball: c.ball, ballOwner: c.ballOwner, geom, players: v.curPlayers() };
      },
      { t },
    );
    geoms.push(g);
    await page.locator("#pitch").screenshot({
      path: join(capDir, `${seed}-t${tick}-${follow ? "zoom" : "wide"}-${t}.png`),
    });
  }
  return geoms;
}

test("E407 캡처: seed 27182818 t2206 (standoff 4.83m · turn 100° · glue 8.74m)", async ({ page }) => {
  await inject(page, "27182818");
  const wide = await shoot(page, "27182818", 2206, false);
  const zoom = await shoot(page, "27182818", 2206, true);
  // eslint-disable-next-line no-console
  console.log("WIDE " + JSON.stringify(wide.map((g: any) => ({
    tick: g.tick, ball: g.ball, owner: g.ballOwner,
    ballPx: g.geom.ball, ownerPx: g.geom.owner,
  }))));
  // eslint-disable-next-line no-console
  console.log("ZOOM " + JSON.stringify(zoom.map((g: any) => ({
    tick: g.tick, ballPx: g.geom.ball, ownerPx: g.geom.owner,
  }))));
  expect(wide.length).toBe(5);
});

test("E407 캡처: seed 2718281828 t956 (standoff 4.00m · turn 154°)", async ({ page }) => {
  await inject(page, "2718281828");
  const wide = await shoot(page, "2718281828", 956, false);
  const zoom = await shoot(page, "2718281828", 956, true);
  // eslint-disable-next-line no-console
  console.log("WIDE2 " + JSON.stringify(wide.map((g: any) => ({
    tick: g.tick, ball: g.ball, owner: g.ballOwner, ballPx: g.geom.ball, ownerPx: g.geom.owner,
  }))));
  expect(zoom.length).toBe(5);
});

/**
 * 중복 playerId(라이브 하프의 38%) 에서 **소유자 노란 링이 양 팀 모두에** 그려지는지.
 * viewer.impl.mjs:226 `A.ballOwner === pa.playerId` — 팀 비교가 없다.
 */
const DUP_LOG = {
  configVersion: "e407-dup@1",
  seed: "e407-dup",
  finalScore: { home: 0, away: 0 },
  events: [] as unknown[],
  tickSnapshots: Array.from({ length: 12 }, (_, t) => ({
    tick: t,
    minute: 0,
    ball: { x: 21, y: 34 },
    ballOwner: "P078",
    hash: "x",
    players: [
      { playerId: "P074", team: "home", pos: { x: 5, y: 34 } },
      { playerId: "P078", team: "home", pos: { x: 21, y: 34 } }, // 실제 소유자(공 위)
      { playerId: "P078", team: "away", pos: { x: 84, y: 20 } }, // 반대편 동명이인
      { playerId: "P116", team: "away", pos: { x: 99, y: 34 } },
    ],
  })),
};

test("E407 캡처: 중복 playerId 소유자 링", async ({ page }) => {
  mkdirSync(capDir, { recursive: true });
  await loadViewer(page, VIEWER_URL);
  await page.evaluate((log) => window.postMessage({ type: "loadMatchLog", matchLog: log }, "*"), DUP_LOG as never);
  await page.waitForFunction(() => (window as any).__viewer?.ready(), null, { timeout: 20000 });
  const out = await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.autoPace(false);
    v.seek(5);
    v.render();
    return { geom: v.screenGeom(), players: v.curPlayers(), ball: v.cur().ball };
  });
  await page.locator("#pitch").screenshot({ path: join(capDir, "dup-owner-ring.png") });
  // eslint-disable-next-line no-console
  console.log("DUP " + JSON.stringify(out));
  expect(out).toBeTruthy();
});
