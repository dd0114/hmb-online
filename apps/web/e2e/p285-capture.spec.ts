import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ARENA_HIGH, ARENA_LOW, HIGH_IDS, LOW_IDS, MATCH_ID, XI, auth, mockApi } from "./p285-fixture";

/**
 * #285 실화면 캡처 — **판정이 아니라 눈으로 볼 증빙**이다(루트 CLAUDE §2-2 "좌표 추론 금지").
 * 계약은 `p285-icon-policy.spec.ts` 가 진다. 여기는 before/after 를 같은 절차로 찍는 도구다.
 *
 *   TAG=before npx playwright test p285-capture --config=playwright.config.ts
 *   TAG=after  npx playwright test p285-capture
 */
const TAG = process.env.P285_TAG ?? "cur";
const SHOTS = new URL("../.smoke/", import.meta.url).pathname;
const repoRoot = new URL("../../../", import.meta.url).pathname;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 1000 };

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}p285-${name}-${TAG}.png`, fullPage: false });
}

test("캡처: 브리핑 상단 + 보드 토큰 (모바일·데스크탑)", async ({ page }) => {
  await mockApi(page);
  await auth(page);

  for (const [label, vp] of [["390", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(vp);
    await page.goto(`/match/${MATCH_ID}`);
    await expect(page.getByTestId("briefing-panel")).toBeVisible();
    // 아트 아틀라스가 실제로 붙은 뒤에 찍는다 — 로딩 중 캡처는 "얼굴 없음"을 거짓으로 증명한다.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-avatar-kind="unit"],[data-avatar-kind="character"],[data-avatar-kind="placeholder"]').length > 0,
      null, { timeout: 15_000 },
    );
    await page.waitForTimeout(600);
    await shot(page, `briefing-${label}`);
  }

  await page.setViewportSize(DESKTOP);
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, "deck-desktop");

  // 토큰 확대 — 32~38px 얼굴은 전체 캡처에서 판독이 안 된다(#218 선례).
  const board = page.getByTestId("tactics-board");
  if (await board.count()) await board.screenshot({ path: `${SHOTS}p285-board-crop-${TAG}.png` });
});

/** 경기장 토큰 — 골드 이하만 22명 채워 "얼굴이 뜨나"를 실제 캔버스 픽셀로 남긴다. */
test("캡처: 경기장 토큰 (골드 이하 22명)", async ({ page }) => {
  const log = JSON.parse(readFileSync(`${repoRoot}packages/engine/dev-viewer/match-log.json`, "utf8"));
  const snaps = log.tickSnapshots as Array<{ players?: Array<{ playerId: string }>; ballOwner?: string }>;
  const order: string[] = [];
  for (const s of snaps) for (const p of s.players ?? []) if (!order.includes(p.playerId)) order.push(p.playerId);
  // 앞 절반은 골드 이하, 뒤는 다이아 이상 — 한 화면에서 두 정책이 대비된다.
  // 22칸 = 서로 다른 22개 id — 돌려 쓰면 같은 선수가 양 팀에 앉아 크롭이 뒤섞인다(#231 모양).
  const pool = [...ARENA_LOW, ...ARENA_HIGH];
  const remap = new Map(order.map((old, i) => [old, pool[i]!]));
  for (const s of snaps) {
    for (const p of s.players ?? []) p.playerId = remap.get(p.playerId)!;
    if (s.ballOwner && remap.has(s.ballOwner)) s.ballOwner = remap.get(s.ballOwner)!;
  }

  await auth(page);
  await mockApi(page);
  await page.route((url) => /\/api\/matches\/.+\/halves\/1\/log$/.test(url.pathname), (route) => route.fulfill(json(log)));
  // ⚠️ `clock` 은 **실제 MatchClock 스키마**여야 한다 — 없는 필드를 넣으면 감독시간 화면이
  // 렌더되지 않아 뷰어 캔버스 자체가 안 뜬다(#244 검증 BLOCKER-1 과 같은 함정).
  const now = Date.now();
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) =>
    route.fulfill(json({
      id: MATCH_ID, state: "HALFTIME", scoreH1Home: 1, scoreH1Away: 0, scoreHome: 1, scoreAway: 0,
      createdAt: "2026-07-29T00:00:00Z", opponent: { name: "ㅅㄷㄴ" },
      clock: {
        phase: "HALFTIME",
        kickoffAt: new Date(now - 600_000).toISOString(),
        phaseStartAt: new Date(now - 13_000).toISOString(),
        phaseEndsAt: new Date(now + 47_000).toISOString(),
        serverNow: new Date(now).toISOString(),
        halfRealMs: 180_000, halftimeMs: 60_000,
        seekForwardBlocked: true, seekGraceMs: 1_500,
      },
    })));

  await page.setViewportSize(DESKTOP);
  await page.goto(`/match/${MATCH_ID}`);
  // 감독시간 화면은 [감독 | 경기장면] 탭 2층(#226) — 캔버스는 경기장면 탭 뒤에 있다.
  await page.getByRole("tab", { name: "경기장면" }).click();
  await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => (window as never as ViewerWin).__viewer?.ready?.() === true, null, { timeout: 20_000 });
  await page.evaluate(() => {
    const v = (window as never as ViewerWin).__viewer!;
    v.autoPace(false);
    v.setViewMode("fix");
    v.seek(900);
  });
  await page.waitForTimeout(500);
  await shot(page, "arena");

  // 토큰 확대 크롭 — 골드 이하 4명 + 다이아 이상 2명.
  const wanted = [...ARENA_LOW.slice(0, 4), ...ARENA_HIGH.slice(0, 2)];
  const crops = await page.evaluate((ids) => {
    const v = (window as never as ViewerWin).__viewer!;
    const src = document.querySelector("canvas") as HTMLCanvasElement;
    const players = v.curPlayers();
    const out: Array<{ id: string; data: string }> = [];
    for (const id of ids) {
      const p = players.find((q) => q.id === id);
      if (!p) continue;
      const S = 40, Z = 6;
      const c = document.createElement("canvas");
      c.width = S * Z; c.height = S * Z;
      const cx = c.getContext("2d")!;
      cx.imageSmoothingEnabled = false;
      cx.drawImage(src, Math.round(p.px) - S / 2, Math.round(p.py) - S / 2, S, S, 0, 0, S * Z, S * Z);
      out.push({ id, data: c.toDataURL().split(",")[1] });
    }
    return out;
  }, wanted);
  for (const c of crops) writeFileSync(`${SHOTS}p285-arena-${c.id}-${TAG}.png`, Buffer.from(c.data, "base64"));
  expect(crops.length, "크롭 표본이 잡혀야 증빙이 성립한다").toBeGreaterThan(0);
});

interface ViewerWin {
  __viewer?: {
    ready(): boolean;
    autoPace(on: boolean): void;
    setViewMode(m: string): void;
    seek(t: number): void;
    curPlayers(): Array<{ id: string; px: number; py: number }>;
  };
}

test("표본 점검: 골드 이하·다이아 이상이 모두 화면에 있다", async () => {
  expect(LOW_IDS.length, "골드 이하 표본").toBeGreaterThan(3);
  expect(HIGH_IDS.length, "다이아 이상 표본").toBeGreaterThan(1);
  expect(XI.length).toBe(11);
});
