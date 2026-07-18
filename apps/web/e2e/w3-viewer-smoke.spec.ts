import { expect, test, type APIRequestContext, type Frame, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * W3 뷰어 통합 스모크 (AC-W5) — 실동작 증적용. 풀스택(server-java + ts-servants) 이 떠 있을 때만
 * 실행. H1_BREAK / FINISHED 에서 [시각 재생] 탭의 QA 뷰어 iframe 이 실제로 피치·선수·공을 렌더하는지
 * 확인하고 스크린샷을 apps/web/.smoke/ 에 남긴다. (라이브 executor 면 ~2분/하프 → 긴 타임아웃.)
 */

// 기본 데모 8080. 격리 스모크(대체 포트)는 HMB_E2E_API_ORIGIN 로 덮어쓴다(8080 무접촉).
const API_ORIGIN = process.env.HMB_E2E_API_ORIGIN ?? "http://localhost:8080";
const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

async function apiLive(request: APIRequestContext): Promise<boolean> {
  try {
    await request.get(`${API_ORIGIN}/internal/health`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function seedDeck(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const token = localStorage.getItem("hmb.auth.token");
    if (!token) return false;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const players: Array<{ id: string; position: string; owned: boolean }> = await (
      await fetch("/api/players", { headers })
    ).json();
    const owned = players.filter((p) => p.owned);
    const gk = owned.find((p) => p.position === "GK");
    if (!gk || owned.length < 11) return false;
    const ordered = [gk, ...owned.filter((p) => p.id !== gk.id)];
    const starters = ordered.slice(0, 11).map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i }));
    const bench = ordered.slice(11, 18).map((p, i) => ({ playerId: p.id, role: "bench", slotIndex: i }));
    const res = await fetch("/api/deck", {
      method: "PUT",
      headers,
      body: JSON.stringify({ formation: "4-4-2", slots: [...starters, ...bench] }),
    });
    return res.ok;
  });
}

/** 시각 재생 iframe(해당 half)의 QA 뷰어가 로그 주입 후 렌더 상태에 도달했는지 확인. */
async function assertViewerRendered(page: Page, half: 1 | 2): Promise<{ score: string; tick: number }> {
  const iframeEl = page.locator(`[data-testid="viewer-visual-half${half}"] iframe`);
  await expect(iframeEl).toBeVisible({ timeout: 15_000 });
  const handle = await iframeEl.elementHandle();
  const frame = (await handle!.contentFrame()) as Frame;
  // 주입(loadMatchLog) → 원본 loadLog → __viewer.ready() true 가 될 때까지 대기.
  await frame.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 30_000 },
  );
  // 재생을 잠깐 진행시켜 선수/공이 그려진 프레임을 만든다(정지 첫 프레임도 렌더되지만 확실히).
  const info = await frame.evaluate(() => {
    const v = (window as unknown as {
      __viewer: {
        events: () => unknown[];
        cur: () => { tick: number };
        captions: () => { score: string };
        seek: (t: number) => void;
      };
    }).__viewer;
    const evs = v.events();
    // 첫 이벤트 근처로 seek 해 액션 프레임을 렌더(피치+선수+공 확실히 보이게).
    if (evs.length > 0) {
      const midTick = (evs[Math.floor(evs.length / 2)] as { tick: number }).tick;
      v.seek(midTick);
    }
    return { evCount: evs.length, cur: v.cur(), caps: v.captions() };
  });
  expect(info.evCount, "주입된 MatchLog 에 이벤트가 있어야 함").toBeGreaterThan(0);
  return { score: info.caps.score, tick: info.cur.tick };
}

test("W3 smoke: 시각 재생 탭이 H1_BREAK·FINISHED 에서 실제 렌더 + 스크린샷", async ({ page, request }) => {
  test.skip(!(await apiLive(request)), "server-java/ts-servants 미기동");
  test.setTimeout(600_000); // 라이브 executor 2분/하프 + 여유
  mkdirSync(SMOKE_DIR, { recursive: true });

  const nickname = `w3smoke_${Date.now().toString(36)}`;

  // 신 /login: provider stage(게스트) → 닉네임 → "계속" (AC-A1 개편)
  await page.goto("/login");
  await page.getByTestId("provider-guest").click();
  await page.getByPlaceholder("2~16자").fill(nickname);
  await page.getByRole("button", { name: "계속" }).click();
  await page.getByRole("button", { name: "확인" }).click();
  await expect(page).toHaveURL(/\/lobby$/);

  expect(await seedDeck(page)).toBe(true);

  // 로비 개편(W5): 게임시작 → 연습/리그 모달 → 연습 경기(mode-practice).
  await page.getByTestId("play-cta").click();
  await page.getByTestId("mode-practice").click();
  await expect(page).toHaveURL(/\/match\//);

  await expect(page.getByTestId("briefing-panel")).toBeVisible();
  await page.getByTestId("editor-team-prompt").fill("측면 활용, 강하게 압박");
  await page.getByTestId("kickoff-button").click();

  // === H1_BREAK: 전반 시각 재생 ===
  await expect(page.getByTestId("halftime-panel")).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("match-viewer-half1")).toBeVisible();
  // 시각 재생 탭이 기본 활성 + iframe 존재.
  await expect(page.getByTestId("viewer-tab-visual-half1")).toHaveAttribute("aria-selected", "true");
  const h1 = await assertViewerRendered(page, 1);
  console.log(`[smoke] half1 viewer rendered — score ${h1.score}, tick ${h1.tick}`);
  await page.locator('[data-testid="viewer-visual-half1"] iframe').screenshot({
    path: `${SMOKE_DIR}w3-half1-visual.png`,
  });
  await page.screenshot({ path: `${SMOKE_DIR}w3-half1-page.png`, fullPage: false });

  // 하프타임 교체 1건 → 후반 시작
  const outSelect = page.getByTestId("sub-out-select");
  const inSelect = page.getByTestId("sub-in-select");
  const outValue = await outSelect.evaluate((el) => {
    const sel = el as HTMLSelectElement;
    const opt = [...sel.options].find((o) => o.value !== "" && !/^GK\b/.test(o.textContent ?? ""));
    return opt?.value ?? "";
  });
  await outSelect.selectOption(outValue);
  await inSelect.selectOption({ index: 1 });
  await page.getByTestId("sub-add").click();
  await page.getByTestId("resume-button").click();

  // === FINISHED: 후반 시각 재생 ===
  await expect(page.getByTestId("result-page")).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("match-viewer-half2")).toBeVisible();
  await expect(page.getByTestId("viewer-tab-visual-half2")).toHaveAttribute("aria-selected", "true");
  const h2 = await assertViewerRendered(page, 2);
  console.log(`[smoke] half2 viewer rendered — score ${h2.score}, tick ${h2.tick}`);
  await page.locator('[data-testid="viewer-visual-half2"] iframe').screenshot({
    path: `${SMOKE_DIR}w3-half2-visual.png`,
  });

  // === 모바일(390px) 가로 오버플로 0 확인 ===
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] 390px horizontal overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SMOKE_DIR}w3-half2-mobile390.png`, fullPage: false });
});
