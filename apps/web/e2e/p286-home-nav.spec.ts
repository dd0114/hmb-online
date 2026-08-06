import { expect, test } from "@playwright/test";
import { mockAll } from "./p286-mocks";
import { openTuneTab } from "./deck-tabs";

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
  // 육성 탭은 사라졌다(도감으로 병합). ⚠️ "없는 testid 를 센다"로 쓰면 **영원히 참**이라 공허하다
  // — 칸 수를 세서 6개를 넘기면 깨지게 한다(탭이 하나라도 되살아나면 여기서 잡힌다).
  await expect(page.getByTestId("nav-bottom").locator("button")).toHaveCount(TABS.length);
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
  // 모드 선택이 **모달이 아니라 화면**이다. 사라진 testid 를 세는 대신(그건 영원히 참이다)
  // "열린 다이얼로그가 없는데도 세 모드가 보인다"를 본다 — 모달로 되돌리면 여기서 깨진다.
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
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
  // ⚠️ **뱃지가 둘 이상 뜨는 상태**로 본다. 하나뿐이면 `Set(styles).size === 1` 이 구현과 무관하게
  // 언제나 참이라 계약이 공허하다(독립검증 MIN-1). 알림 줄 뱃지까지 같은 형식이어야 한다.
  await mockAll(page, { openTrades: 1, unseenAwayReports: 2 });
  await page.goto("/home");
  await page.getByTestId("home-page").waitFor();
  await expect(page.getByTestId("home-notif")).toBeVisible();

  const badges = page.locator('[data-testid^="home-count-"], [data-testid="home-notif"] > span:first-child');
  const n = await badges.count();
  expect(n, "뱃지가 둘 이상이어야 형식 비교가 의미를 갖는다").toBeGreaterThan(1);

  // 같은 형식 = 같은 클래스 · 같은 크기 · 같은 배경색.
  const styles = await badges.evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      // 클래스 이름은 CSS Module 해시라 자리마다 다르다 — **보이는 형식**만 비교한다.
      return `${cs.backgroundColor}|${cs.borderRadius}|${Math.round(el.getBoundingClientRect().height)}`;
    }),
  );
  expect(new Set(styles).size, `형식이 갈라졌다: ${[...new Set(styles)].join(" vs ")}`).toBe(1);
});

test("알림 한 줄은 셀 게 있을 때만 나온다", async ({ page }) => {
  // hero 3R "최대한 간결하게" — 빈 줄이 남으면 "알림 없음"이 아니라 "고장"으로 읽힌다.
  await mockAll(page, { openTrades: 0, unseenAwayReports: 0 });
  await page.goto("/home");
  await page.getByTestId("home-page").waitFor();
  await expect(page.getByTestId("home-notif")).toHaveCount(0);
});

test("셀 게 없으면 뱃지를 그리지 않는다", async ({ page }) => {
  await mockAll(page, { openTrades: 0, unseenAwayReports: 0 });
  await page.goto("/home");
  await page.getByTestId("home-page").waitFor();
  await expect(page.getByTestId("home-count-recruit")).toHaveCount(0);
});

// ── 로비 해체로 잃을 뻔한 것들 ───────────────────────────────────────────
test("팀 사기 위젯이 덱에 살아 있다 — 로비와 함께 사라지지 않았다", async ({ page }) => {
  // 로비를 걷어내면 거기 있던 위젯은 **정의만 남고 화면에서 조용히 없어진다**(독립검증 BL-1 이
  // 실제로 그 상태를 잡았다). 설계 §3.1 이 행선지를 [덱]으로 지정했고, 이 계약이 그걸 지킨다.
  //
  // ⚠️ **이 파일은 `beforeEach` 가 390×844 를 건다** — 즉 여기서 보는 `/deck` 은 #455 A1 의
  //    **책갈피 탭 레이아웃**이고, 팀 사기는 hero 확정 배치대로 `[⚙ 세부 전술]` 탭 꼬리에 있다
  //    (사기는 곁눈질로 보는 값 · 프롬프트가 1순위, #244). 그래서 **탭을 열고** 본다.
  // ⚠️ 약화가 아니다 — 존재(`toHaveCount(1)`)를 먼저 재고, 그 다음 열어서 **실제로 보이는지**
  //    본다. 소비처가 0 이 되면 첫 단언에서, 탭 안에서 안 그려지면 둘째 단언에서 죽는다.
  //    데스크탑(stack)에서 **탭을 열지 않고도** 보이는지는 `p455-a1-layout-band.spec.ts` ⑨ 가
  //    같이 잰다(A1 초판이 그 갈래를 통째로 잃었고 이 스펙이 그때 red 였다).
  await mockAll(page);
  await page.goto("/deck");
  await expect(page.getByTestId("team-morale")).toHaveCount(1);
  await openTuneTab(page);
  await expect(page.getByTestId("team-morale")).toBeVisible();
});

test("보유 선수만 보는 뷰가 남아 있다 — 육성 탭이 사라져도", async ({ page }) => {
  // 육성 탭이 하던 일이 정확히 `owned` 필터 하나였다. 탭만 지우고 필터를 안 옮기면
  // "내가 키우는 카드만 보기"가 도달 불가가 된다(독립검증 MIN-5).
  await mockAll(page);
  await page.goto("/players");
  await expect(page.getByTestId("codex-scope-owned")).toHaveAttribute("aria-selected", "true");
  const ownedCount = await page.locator('[data-testid^="codex-card-"]').count();
  await page.getByTestId("codex-scope-all").click();
  const allCount = await page.locator('[data-testid^="codex-card-"]').count();
  expect(allCount, "전체가 보유보다 많아야 스코프가 실제로 걸린 것이다").toBeGreaterThan(ownedCount);
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

// ── 빈 응답 내성 ─────────────────────────────────────────────────────────
/**
 * **전 라우트가 200 `{}` 에도 살아남는다** (독립검증 MAJ-3).
 *
 * 왜 계약이 필요한가: 이건 세 번 반복된 결함이다 — `(x ?? [])` 도 `me?.wallet.points` 도
 * **`{}` 를 막지 못한다**(옵셔널 체이닝은 앞 단계만 본다). 구 서버·부분 장애가 정확히 그 형태를
 * 주고, 그때 화면은 "데이터 없음"이 아니라 **흰 화면**이 된다. #245 가 로비에서 같은 방식으로
 * 당했고("부가 기능이 앱 진입점을 죽이면 안 된다"), #286 은 진입점을 6개로 늘렸다.
 *
 * ⚠️ 눈으로 "떴다"만 보면 안 된다 — `pageerror` 를 같이 센다. React 는 자식 하나가 던져도
 * 부모까지 언마운트하므로, 단언 대상만 우연히 살아 있는 경우가 생긴다.
 */
const EMPTY_SAFE_ROUTES = [
  ["/home", "home-page"],
  ["/game", "game-page"],
  ["/away", "away-page"],
  ["/deck", "deck-editor"],
  ["/players", "codex-owned-total"],
  ["/recruit", "recruit-page"],
  ["/me", "me-page"],
] as const;

for (const [route, marker] of EMPTY_SAFE_ROUTES) {
  test(`빈 응답(200 {})에도 ${route} 가 죽지 않는다`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // 전 엔드포인트가 `{}` — 배열도 객체 필드도 없다.
    await page.route((url) => url.pathname.startsWith("/api/"), (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.addInitScript(() => {
      window.localStorage.setItem("hmb.auth.token", "tok");
      window.localStorage.setItem("hmb.tutorial.done", "1");
    });

    await page.goto(route);
    // ⚠️ **쿼리가 해소된 뒤에** 본다. 로딩 중에는 데이터를 안 만지므로 화면이 멀쩡하고, 크래시는
    //    `{}` 가 도착하는 순간 일어난다 — 바로 단언하면 로딩 프레임을 보고 통과한다(실제로
    //    이 계약이 그 상태였고 변이체가 살아남았다). 응답이 끝나고 렌더가 한 번 더 돈 뒤에 본다.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    expect(errors, `${route} 렌더 중 예외:\n${errors.join("\n")}`).toEqual([]);
    await expect(page.getByTestId(marker), `${route} 가 흰 화면이다`).toBeVisible();
  });
}

test("빈 응답에서 원정 상대 고르기를 눌러도 죽지 않는다", async ({ page }) => {
  // 후보 목록은 **누른 뒤에** 받아오므로 위 루프가 닿지 못하는 경로다(실제로 여기가 살아남았다).
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route((url) => url.pathname.startsWith("/api/"), (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });
  await page.goto("/away");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("away-start").click();
  await page.waitForTimeout(600);
  expect(errors, `원정 2택 렌더 중 예외:\n${errors.join("\n")}`).toEqual([]);
  await expect(page.getByTestId("away-pick")).toBeVisible();
});
