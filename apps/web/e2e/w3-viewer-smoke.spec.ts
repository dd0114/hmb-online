import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * W3 뷰어 통합 스모크 (AC-W5) — 실동작 증적용. 풀스택(server-java + ts-servants) 이 떠 있을 때만
 * 실행. H1_BREAK / FINISHED 에서 무대(#169 S3: web 이 직접 마운트한 viewer-core 캔버스)가 실제로
 * 피치·선수·공을 렌더하는지 확인하고 스크린샷을 apps/web/.smoke/ 에 남긴다. (라이브 executor 면 ~2분/하프.)
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

/** 시각 재생(해당 half)의 코어가 로그 로드 후 렌더 상태에 도달했는지 확인.
 *  S3: iframe 제거 — web 이 코어를 직접 마운트하므로 window.__viewer(코어 훅)를 메인 페이지에서 읽는다. */
async function assertViewerRendered(page: Page, half: 1 | 2): Promise<{ score: string; tick: number }> {
  await expect(page.getByTestId(`viewer-canvas-half${half}`)).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 30_000 },
  );
  const info = await page.evaluate(() => {
    const v = (window as unknown as {
      __viewer: { events: () => unknown[]; cur: () => { tick: number }; seek: (t: number) => void };
    }).__viewer;
    const evs = v.events();
    if (evs.length > 0) {
      const midTick = (evs[Math.floor(evs.length / 2)] as { tick: number }).tick;
      v.seek(midTick);
    }
    return { evCount: evs.length, cur: v.cur() };
  });
  expect(info.evCount, "MatchLog 에 이벤트가 있어야 함").toBeGreaterThan(0);
  // 스코어는 무대가 아니라 호스트 스코어바가 소유한다(#169 S1).
  const score = (await page.getByTestId("stage-score").textContent().catch(() => "")) ?? "";
  return { score, tick: info.cur.tick };
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
  // 무대가 곧 시각 재생이다(#169 S1: 모드 탭 제거 — 폴백일 때만 텍스트 타임라인으로 바뀐다).
  await expect(page.getByTestId("viewer-visual-half1")).toBeVisible();
  const h1 = await assertViewerRendered(page, 1);
  console.log(`[smoke] half1 viewer rendered — score ${h1.score}, tick ${h1.tick}`);
  await page.getByTestId("viewer-canvas-half1").screenshot({
    path: `${SMOKE_DIR}w3-half1-visual.png`,
  });
  await page.screenshot({ path: `${SMOKE_DIR}w3-half1-page.png`, fullPage: false });

  // 하프타임 교체 1건 → 후반 시작
  // 7) 하프타임 — 교체 1건 + 추가 프롬프트 → 후반 시작
  // #244 T2: 교체는 select 가 아니라 **하단 탭 + 보드 모드**다. 보드에서 뺄 선수(비-GK 선발)를
  // 누르고 벤치에서 넣을 선수를 누른다. GK 를 빼면 GK_REQUIRED 로 후반 시작이 막힌다.
  await page.getByTestId("halftime-mode-sub").click();
  const outId = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('[data-testid^="board-slot-starter-"]')];
    for (const s of slots) {
      if (s.getAttribute("data-testid") === "board-slot-starter-0") continue; // GK 슬롯 회피
      const tok = s.querySelector('[data-testid^="token-"]');
      if (tok) return tok.getAttribute("data-testid")!.replace("token-", "");
    }
    return "";
  });
  expect(outId, "non-GK 선발 OUT 후보가 있어야 함").not.toBe("");
  await page.getByTestId(`token-${outId}`).click();
  const inId = await page.evaluate(() => {
    const bench = [...document.querySelectorAll('[data-testid^="board-slot-bench-"]')];
    for (const s of bench) {
      const tok = s.querySelector('[data-testid^="token-"]');
      if (tok) return tok.getAttribute("data-testid")!.replace("token-", "");
    }
    return "";
  });
  expect(inId, "벤치 IN 후보가 있어야 함").not.toBe("");
  await page.getByTestId(`token-${inId}`).click();
  await expect(page.getByTestId("sub-chip-0")).toBeVisible();
  await page.getByTestId("halftime-mode-say").click();
  await page.getByTestId("halftime-prompt-team").click().catch(() => {}); // 선수 선택 상태면 팀으로
  await page.getByTestId("halftime-team-prompt").fill("후반은 점유율 위주로 안정적으로");
  await page.getByTestId("resume-button").click();

  // === FINISHED: 후반 시각 재생 ===
  await expect(page.getByTestId("result-page")).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("match-viewer-half2")).toBeVisible();
  await expect(page.getByTestId("viewer-visual-half2")).toBeVisible();
  const h2 = await assertViewerRendered(page, 2);
  console.log(`[smoke] half2 viewer rendered — score ${h2.score}, tick ${h2.tick}`);
  await page.getByTestId("viewer-canvas-half2").screenshot({
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
