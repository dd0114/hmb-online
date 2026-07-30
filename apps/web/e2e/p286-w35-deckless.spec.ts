import { expect, test } from "@playwright/test";
import { mockAll } from "./p286-mocks";

/**
 * #286 **W3.5** — 덱 없는 유저의 게임 시작 **계약**. 구현 전에 먼저 박았다(E2E-TDD, 루트 §2-3).
 *
 * hero 발제(라이브 실증): *"덱 없는 유저가 게임 시작까지 도달해 문제가 발생한다."*
 *
 * ⚠️ **서버가 관용적이어서가 아니다.** 실사 결과 `MatchService` 의 매치 생성 3경로가 전부
 * `getActiveDeck` 으로 시작하고 덱이 없으면 404 를 던진다 — 즉 **거부는 이미 하고 있다**.
 * 문제는 그 거부가 화면에서 **막다른 에러 토스트 한 줄**로 끝난다는 것이다(`GamePage` 는 덱을
 * 조회조차 하지 않았다). 그래서 이 웨이브가 고치는 것은 서버가 아니라 **안내 동선**이다.
 *
 * 근원은 둘이고, 계약도 그 둘을 각각 태운다:
 *  (가) 온보딩을 끝까지 안 본 유저 — 덱을 지급하는 `POST /api/me/tutorial-complete` 가 안 불린다
 *  (나) 온보딩을 끝냈어도 **보유 11명 미만**이면 서버가 덱 없이 통과시킨다(`OnboardingService`
 *       주석: *"유저가 카드를 모으면 직접 구성할 수 있다"*) → 자동완성을 눌러도 저장이 안 된다
 *
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5292 npx playwright test p286-w35-deckless.spec.ts
 * (⚠️ e2e 전체 실행 금지 — 일부 스펙이 :8080 라이브 데모에 붙는다.)
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

/**
 * 자동 배치 버튼은 **폭에 따라 두 자리 중 한 곳**에 뜬다(상단 바 `auto-fill-top` = 모바일 /
 * 보드 바 `auto-fill` = 데스크탑). 둘 다 DOM 에는 있으므로 **보이는 쪽**을 눌러야 한다 —
 * 한쪽을 박으면 폭 규칙이 바뀌는 순간 계약이 조용히 거짓 실패한다.
 */
async function clickAutoFill(page: import("@playwright/test").Page) {
  const top = page.getByTestId("auto-fill-top");
  const board = page.getByTestId("auto-fill");
  const target = (await top.isVisible()) ? top : board;
  await expect(target).toBeVisible();
  await target.click();
}

// ── L1: 홈 [게임 시작] ────────────────────────────────────────────────────
test("덱이 없으면 홈 [게임 시작]이 차단되고 안내가 뜬다", async ({ page }) => {
  // hero 문안 그대로: "현재 덱이 없습니다. 덱을 구성하러 가시겠습니까?"
  await mockAll(page, { deck: "missing" });
  await page.goto("/home");
  await page.getByTestId("home-tiles").waitFor();

  await page.getByTestId("home-tile-game").click();

  const dialog = page.getByTestId("deckless-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("현재 덱이 없습니다");

  // ⚠️ **차단이 핵심이다.** 안내만 띄우고 이동해 버리면 유저는 그대로 모드 선택에 도달한다 —
  // 그러면 이 웨이브가 고치려는 상태와 같아진다.
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("game-page")).toHaveCount(0);
});

test("안내는 진짜 모달이다 — 화면 안에 온전히 들어오고 백드롭이 뒤를 막는다", async ({ page }) => {
  /**
   * ⚠️ **`toBeVisible()` 로는 이걸 못 잡는다.** 처음 구현은 `Modal` 에 `overlayClassName` 을
   * 넘기지 않아 오버레이가 **스타일 0인 래퍼**가 됐고, 다이얼로그가 문서 흐름에 인라인으로
   * 들어가 홈에서 버튼 하단이 잘렸다(390×844 실측 `dialogBottom` 859 > 844). 그런데 계약
   * 9건이 전부 green 이었다 — 보이기는 했으니까. 독립검증 BL-1.
   *
   * 그래서 여기서는 **위치**를 본다: 뷰포트 안에 온전히 들어오는가, 백드롭이 실제로 깔리는가,
   * 홈의 "페이지 스크롤 0" 성질이 유지되는가.
   */
  // 알림 줄까지 있는 상태 = 홈이 가장 길어지는 평범한 복귀 유저.
  await mockAll(page, { deck: "missing", unseenAwayReports: 3, openTrades: 1 });
  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();

  const dialog = page.getByTestId("deckless-dialog");
  await expect(dialog).toBeVisible();

  const box = await dialog.boundingBox();
  expect(box, "다이얼로그 박스를 못 읽었다").not.toBeNull();
  const vh = page.viewportSize()!.height;
  expect(box!.y, "다이얼로그 상단이 화면 위로 잘렸다").toBeGreaterThanOrEqual(0);
  expect(
    box!.y + box!.height,
    `다이얼로그 하단이 화면 밖이다 — 버튼을 누르려면 스크롤해야 한다 (bottom=${box!.y + box!.height}, viewport=${vh})`,
  ).toBeLessThanOrEqual(vh);

  // 백드롭 = 뒤 화면을 막는 층. 없으면 잠긴 척하면서 뒤 타일이 그대로 눌린다.
  const overlayFixed = await dialog.evaluate((el) => {
    const overlay = el.parentElement!;
    const cs = getComputedStyle(overlay);
    return { position: cs.position, bg: cs.backgroundColor };
  });
  expect(overlayFixed.position).toBe("fixed");
  expect(overlayFixed.bg, "백드롭이 투명하다").not.toBe("rgba(0, 0, 0, 0)");

  // 홈 셸은 페이지 스크롤 0 이 성질이다(#169 S1) — 다이얼로그가 그걸 깨면 안 된다.
  const scrolls = await page.evaluate(() => ({
    doc: document.documentElement.scrollHeight,
    win: window.innerHeight,
  }));
  expect(scrolls.doc, "다이얼로그가 문서를 늘렸다 = 흐름에 인라인으로 들어갔다").toBeLessThanOrEqual(
    scrolls.win,
  );
});

test("[예] 를 누르면 덱 화면으로 가고 덱 튜토리얼이 뜬다", async ({ page }) => {
  await mockAll(page, { deck: "missing" });
  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("deckless-go-deck").click();

  await expect(page).toHaveURL(/\/deck/);
  // 코치마크가 실제로 떠야 한다 — 이동만 시키면 유저는 빈 전술보드 앞에 그대로 남는다.
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
});

test("덱이 있으면 안내가 뜨지 않는다 — 정상 유저 회귀 방지", async ({ page }) => {
  // 이 계약이 없으면 가드가 과하게 걸려도(예: 로딩 중을 '덱 없음'으로 읽어도) 아무도 모른다.
  await mockAll(page);
  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();

  await expect(page.getByTestId("game-page")).toBeVisible();
  await expect(page.getByTestId("deckless-dialog")).toHaveCount(0);
});

// ── L2: /game 직접 진입 ───────────────────────────────────────────────────
test("URL 로 /game 에 바로 들어와 모드를 눌러도 같은 안내로 막힌다", async ({ page }) => {
  // L1 은 홈 타일에만 걸린다 — 뒤로가기·북마크·딥링크가 그 위를 지나간다.
  await mockAll(page, { deck: "missing" });
  await page.goto("/game");
  await page.getByTestId("game-page").waitFor();

  await page.getByTestId("mode-practice").click();

  await expect(page.getByTestId("deckless-dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/game$/); // 매치로 넘어가지 않았다
});

// ── L3: 서버 거부 ─────────────────────────────────────────────────────────
for (const [label, kind] of [
  ["W4 가 붙일 전용 코드", "deck-required"],
  ["지금 서버의 뭉뚱그린 404", "legacy-404"],
] as const) {
  test(`매치 생성이 ${label}로 거부돼도 같은 안내로 흡수한다`, async ({ page }) => {
    // 경합(다른 탭에서 덱 삭제 등)으로 클라 가드를 통과하는 경로. 클라 가드는 진실이 아니다.
    // ⚠️ 두 케이스를 **같은 화면**으로 받는 것이 계약이다 — 서버가 코드를 붙이기 전에 web 이
    // 먼저 나가도 깨지지 않아야 W3.5 와 W4 의 순서 의존이 사라진다.
    await mockAll(page, { createMatchError: kind }); // 덱은 **있다**(클라 가드를 통과한다)
    await page.goto("/game");
    await page.getByTestId("mode-practice").click();

    await expect(page.getByTestId("deckless-dialog")).toBeVisible();
  });
}

test("리그·원정 페이지로 직접 들어와도 매치를 시작할 수 없다", async ({ page }) => {
  /**
   * ⚠️ **처음엔 게임 탭에만 가드를 걸었다가 독립검증에 잡혔다(MAJ-2).** `/league`·`/away` 는
   * 북마크·뒤로가기로 직접 들어올 수 있고, 거기 [다음 경기]·[원정 떠나기]도 매치를 만든다.
   * 가드가 한 화면에만 있으면 나머지는 **조용히 예전 상태**(막다른 토스트)로 남는다.
   */
  await mockAll(page, { deck: "missing" });

  await page.goto("/away");
  await page.getByTestId("away-start").click();
  await expect(page.getByTestId("deckless-dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/away$/);
});

// ── (나) 보유 11명 미만 — hero Q8 = C ────────────────────────────────────
test("보유가 11명 미만이면 덱 구성이 아니라 영입으로 안내한다", async ({ page }) => {
  // 이 유저는 자동완성을 눌러도 11칸이 안 차서 저장 버튼이 열리지 않는다 —
  // "덱을 구성하러 가시겠습니까?" 는 **할 수 없는 일을 시키는 안내**가 된다.
  await mockAll(page, { deck: "missing", ownedCount: 10 });
  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();

  const dialog = page.getByTestId("deckless-dialog");
  await expect(dialog).toBeVisible();
  // 실수치를 보여준다 — 몇 명이 모자란지 모르면 다음 행동을 정할 수 없다.
  await expect(page.getByTestId("deckless-shortage")).toContainText("10/11");
  // 덱 구성으로 유도하지 **않는다**.
  await expect(page.getByTestId("deckless-go-deck")).toHaveCount(0);

  await page.getByTestId("deckless-go-recruit").click();
  await expect(page).toHaveURL(/\/recruit/);
});

// ── 저장 → 복귀 (hero Q9 = A) ────────────────────────────────────────────
test("자동완성 → 감독 한마디 → 저장 → 복귀 CTA (자동 이동 없음)", async ({ page }) => {
  await mockAll(page, { deck: "missing" });
  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("deckless-go-deck").click();
  await page.getByTestId("tactics-board").waitFor();

  // ③ 배치는 자동이다 — 유저에게 11칸을 손으로 채우게 하지 않는다(hero).
  await clickAutoFill(page);
  // ③ 유저가 직접 타이핑하는 것은 감독 한마디 하나뿐.
  await page.getByTestId("editor-team-prompt").fill("초반부터 강하게 압박");
  await page.getByTestId("save-deck").click();

  const cta = page.getByTestId("deck-ready-cta");
  await expect(cta).toBeVisible();
  // ⚠️ **자동 이동하지 않는다**(hero Q9=A). 이 단언이 없으면 다음 사람이 "편의상" 자동 이동으로
  // 되돌리고, 유저는 방금 자동 배치된 덱을 확인할 틈을 잃는다.
  await expect(page).toHaveURL(/\/deck/);

  await cta.click();
  await expect(page).toHaveURL(/\/game$/);
});

// ── 온보딩 완료를 우회하지 않는다 ────────────────────────────────────────
test("이 흐름은 튜토리얼 완료를 저장하지 않는다", async ({ page }) => {
  // 완료 SoT 는 "모든 코치마크를 봤다"(`seen`)이고, 그 저장이 서버에서 **덱 지급**을 트리거한다.
  // 이 안내 흐름이 완료를 대신 찍으면 홈 코치마크를 한 번도 못 본 유저가 완료 처리된다 —
  // 지금 고치려는 (가)를 반대 방향으로 재현하는 셈이다.
  const completeCalls: string[] = [];
  await mockAll(page, { deck: "missing" });
  await page.route(
    (url) => url.pathname === "/api/me/tutorial-complete",
    (r) => {
      completeCalls.push(r.request().method());
      return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    },
  );

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("deckless-go-deck").click();
  await page.getByTestId("tutorial-overlay").waitFor();

  /**
   * ⚠️ **코치마크를 끝까지 진행시켜야 한다.** 처음엔 저장까지만 하고 단언했는데, 그러면
   * 완료 저장 코드에 **도달조차 하지 않아** 계약이 통과하는 척만 했다(변이 검증에서 들켰다 —
   * "셋업 흐름도 온보딩을 끝낸 것으로 친다"는 오구현이 살아남았다). 마지막 스텝까지 밀어야
   * `advanceOrEnd` 가 완료 판정을 실제로 돌린다.
   */
  const next = page.getByTestId("tutorial-next");
  for (let i = 0; i < 12 && (await next.isVisible().catch(() => false)); i += 1) {
    await next.click();
    await page.waitForTimeout(120);
  }
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);

  await clickAutoFill(page);
  await page.getByTestId("editor-team-prompt").fill("압박");
  await page.getByTestId("save-deck").click();
  await page.getByTestId("deck-ready-cta").waitFor();

  expect(completeCalls).toEqual([]);
});
