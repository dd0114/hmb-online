import { expect, test } from "@playwright/test";
import { mockAll } from "./p286-mocks";

/**
 * #286 W2 — 홈/내비 개편 **계약**. 구현 전에 먼저 박았다(E2E-TDD, 루트 §2-3).
 *
 * hero 가 6차 반복으로 확정한 것만 검사한다. 취향이 아니라 **결정**을 박는다:
 *  (1) 내비 6탭 — 홈·게임·덱·선수·영입·내 정보 (육성 탭 소멸)
 *  (2) 홈 = 하단탭을 크게 펼친 런처. **홈에서는 탭바가 없다**
 *  (3) 홈 타일 = 통칸 5개, hero 지정 이름·순서 (게임 시작·덱 구성·영입·내 정보·선수 도감)
 *  (4) 게임 탭 = 모드 선택 화면. 로비식 모달 소멸, 연습이 **마지막**
 *  (5) 경기 중 = 홈 타일 전부 잠금 + 잠금 카드, 다른 화면은 탭 5칸 잠금
 *  (6) 구 URL 리다이렉트 — 북마크·기존 링크 무중단
 *  (7) 카운트 뱃지는 **한 형식**
 *
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5288 npx playwright test p286-home-nav.spec.ts
 * (⚠️ e2e 전체 실행 금지 — 일부 스펙이 :8080 라이브 데모에 붙는다. apps/web/CLAUDE.md 규칙)
 */

/** hero 가 지정한 홈 타일 — **순서까지** 지정이다. */
const TILES = [
  { key: "game", label: "게임 시작", to: "/game" },
  { key: "deck", label: "덱 구성", to: "/deck" },
  { key: "recruit", label: "영입", to: "/recruit" },
  { key: "me", label: "내 정보", to: "/me" },
  { key: "players", label: "선수 도감", to: "/players" },
] as const;

/** 하단 탭바 — 6칸. 홈이 첫 칸이고, 육성은 없다. */
const TABS = ["home", "game", "deck", "players", "recruit", "me"] as const;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

// ── (2) 홈에는 탭바가 없다 ────────────────────────────────────────────────
test("홈에서는 하단 탭바가 없다 — 홈이 곧 내비다", async ({ page }) => {
  await mockAll(page);
  await page.goto("/home");
  await page.getByTestId("home-page").waitFor();
  await expect(page.getByTestId("nav-bottom")).toHaveCount(0);
  await expect(page.getByTestId("nav-sidebar")).toHaveCount(0);
});

// ── (3) 타일 = 통칸 5개, 이름·순서 지정대로 ──────────────────────────────
test("홈 타일 5개가 hero 지정 이름·순서로 있다", async ({ page }) => {
  await mockAll(page);
  await page.goto("/home");
  const tiles = page.locator('[data-testid^="home-tile-"]');
  await expect(tiles).toHaveCount(TILES.length);
  for (const [i, t] of TILES.entries()) {
    const tile = page.getByTestId(`home-tile-${t.key}`);
    await expect(tile).toContainText(t.label);
    // 순서까지 계약이다 — DOM 순서가 hero 지정 순서와 같아야 한다.
    await expect(tiles.nth(i)).toHaveAttribute("data-testid", `home-tile-${t.key}`);
  }
});

test("타일은 전부 통칸이다 — 반칸으로 나누지 않는다", async ({ page }) => {
  await mockAll(page);
  await page.goto("/home");
  await page.getByTestId("home-page").waitFor();
  const widths: number[] = [];
  for (const t of TILES) {
    const box = await page.getByTestId(`home-tile-${t.key}`).boundingBox();
    expect(box).not.toBeNull();
    widths.push(Math.round(box!.width));
  }
  // 전부 같은 폭 = 2열 반칸이 아니다. (반칸이면 절반짜리가 섞인다.)
  expect(new Set(widths).size).toBe(1);
  // 그리고 그 폭은 화면 폭의 절반보다 확실히 크다.
  expect(widths[0]).toBeGreaterThan(390 * 0.7);
});

test("각 타일이 자기 화면으로 이동시킨다", async ({ page }) => {
  await mockAll(page);
  for (const t of TILES) {
    await page.goto("/home");
    await page.getByTestId(`home-tile-${t.key}`).click();
    await expect(page).toHaveURL(new RegExp(`${t.to}$`));
  }
});

// ── (1) 홈 밖에서는 탭바 6칸 + 홈 복귀 경로 ──────────────────────────────
test("홈 밖 화면에는 탭바 6칸이 있고 [홈] 칸으로 돌아온다", async ({ page }) => {
  await mockAll(page);
  await page.goto("/game");
  await expect(page.getByTestId("nav-bottom")).toBeVisible();
  for (const key of TABS) {
    await expect(page.getByTestId("nav-bottom").getByTestId(`nav-${key}`)).toHaveCount(1);
  }
  // 육성 탭은 사라졌다(도감으로 병합).
  await expect(page.getByTestId("nav-bottom").getByTestId("nav-growth")).toHaveCount(0);
  // 탭바가 홈 복귀 경로다 — 이게 없으면 홈이 막힌다(탭바 숨김과 짝).
  await page.getByTestId("nav-bottom").getByTestId("nav-home").click();
  await expect(page).toHaveURL(/\/home$/);
});

// ── (4) 게임 탭 ──────────────────────────────────────────────────────────
test("게임 탭 = 모드 선택 화면. 모달이 아니고, 연습이 마지막이다", async ({ page }) => {
  await mockAll(page);
  await page.goto("/game");
  await page.getByTestId("game-page").waitFor();

  // 모달을 열지 않아도 세 모드가 보인다(현행은 [게임 시작]을 눌러야 보였다).
  for (const id of ["mode-league", "mode-away", "mode-practice"]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  // hero Q1 확정 — 연습은 **최하단**.
  const modes = page.locator('[data-testid^="mode-"]');
  await expect(modes.last()).toHaveAttribute("data-testid", "mode-practice");
  // 모드 선택 모달은 소멸했다.
  await expect(page.getByTestId("play-cta")).toHaveCount(0);
});

test("게임 탭 리그·원정 카드가 각자 페이지로 간다", async ({ page }) => {
  await mockAll(page);
  await page.goto("/game");
  await page.getByTestId("mode-league").click();
  await expect(page).toHaveURL(/\/league$/);
  await page.goto("/game");
  await page.getByTestId("mode-away").click();
  await expect(page).toHaveURL(/\/away$/);
});

// ── (5) 경기 중 잠금 ─────────────────────────────────────────────────────
const ACTIVE_LOCKED = {
  match: { id: "M1", state: "H1_BREAK" },
  locked: true,
  abandonable: true, // 강제 이동(#217)은 아니지만 홈은 잠긴다 — 이 둘은 다른 층이다.
};

test("경기 중이면 홈 타일이 전부 잠기고 이어하기/포기만 남는다", async ({ page }) => {
  await mockAll(page, { active: ACTIVE_LOCKED });
  await page.goto("/home");
  await page.getByTestId("home-lock-card").waitFor();
  await expect(page.getByTestId("home-resume")).toBeVisible();
  await expect(page.getByTestId("home-abandon")).toBeVisible();
  for (const t of TILES) {
    await expect(page.getByTestId(`home-tile-${t.key}`)).toBeDisabled();
  }
});

test("경기 중 홈 타일은 눌러도 이동하지 않는다", async ({ page }) => {
  await mockAll(page, { active: ACTIVE_LOCKED });
  await page.goto("/home");
  await page.getByTestId("home-lock-card").waitFor();
  await page.getByTestId("home-tile-deck").click({ force: true }).catch(() => {});
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/home$/);
});

test("경기 중이면 홈 밖 화면의 탭 5칸이 잠긴다 — 홈 칸만 열려 있다", async ({ page }) => {
  await mockAll(page, { active: ACTIVE_LOCKED });
  await page.goto("/game");
  const nav = page.getByTestId("nav-bottom");
  await nav.waitFor();
  for (const key of TABS) {
    const item = nav.getByTestId(`nav-${key}`);
    if (key === "home") {
      await expect(item).not.toHaveAttribute("aria-disabled", "true");
    } else {
      await expect(item).toHaveAttribute("aria-disabled", "true");
    }
  }
});

// ── (6) 구 URL 리다이렉트 ────────────────────────────────────────────────
const REDIRECTS: Array<[string, string]> = [
  ["/lobby", "/home"],
  ["/codex", "/players"],
  ["/growth", "/players"],
  ["/shop", "/recruit"],
  ["/trade", "/recruit"],
  ["/logs", "/me"],
];

test("구 URL 은 새 경로로 리다이렉트된다 — 북마크가 죽지 않는다", async ({ page }) => {
  await mockAll(page);
  for (const [from, to] of REDIRECTS) {
    await page.goto(from);
    // 쿼리는 허용한다 — /trade 는 탭 지정(`?tab=trade`)이 붙는다. 보는 건 **경로**다.
    await expect(page, `${from} → ${to}`).toHaveURL(new RegExp(`${to}(\\?|$)`));
  }
});

test("/trade 북마크는 뽑기가 아니라 트레이드 탭으로 떨어진다", async ({ page }) => {
  // 리다이렉트가 경로만 맞추고 탭을 안 넘기면 트레이드 북마크가 조용히 뽑기 화면이 된다 —
  // 화면은 정상이라 눈으로는 안 잡힌다. 그래서 계약이 필요하다.
  await mockAll(page);
  await page.goto("/trade");
  await expect(page.getByTestId("recruit-tab-trade")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("trade-slots")).toBeVisible();
});

test("루트(/)는 홈으로 간다", async ({ page }) => {
  await mockAll(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/home$/);
});

// ── (7) 카운트 뱃지 단일 형식 ────────────────────────────────────────────
test("카운트 뱃지는 한 형식이다 — 리본/원형이 섞이지 않는다", async ({ page }) => {
  await mockAll(page, { openTrades: 1 });
  await page.goto("/home");
  await page.getByTestId("home-page").waitFor();

  const badges = page.locator('[data-testid^="home-count-"]');
  const n = await badges.count();
  expect(n).toBeGreaterThan(0);

  // 같은 형식 = 같은 클래스 · 같은 크기 · 같은 배경색.
  const styles = await badges.evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      return `${el.className}|${cs.backgroundColor}|${cs.borderRadius}|${Math.round(el.getBoundingClientRect().height)}`;
    }),
  );
  expect(new Set(styles).size).toBe(1);
});

test("셀 게 없으면 뱃지를 그리지 않는다", async ({ page }) => {
  await mockAll(page, { openTrades: 0 });
  await page.goto("/home");
  await page.getByTestId("home-page").waitFor();
  await expect(page.getByTestId("home-count-recruit")).toHaveCount(0);
});

// ── 팀 한 줄 ─────────────────────────────────────────────────────────────
test("홈 상단 팀 한 줄이 서버 값을 그린다", async ({ page }) => {
  await mockAll(page);
  await page.goto("/home");
  const row = page.getByTestId("home-team-row");
  await expect(row).toContainText("감독 박");
  // 디비전 이름은 **서버가 준 값 그대로** — 클라가 level 로 만들지 않는다(#262 BL-1).
  await expect(row).toContainText("브론즈 리그");
  await expect(row).toContainText("4-3-3");
});
