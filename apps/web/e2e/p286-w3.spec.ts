import { expect, test } from "@playwright/test";
import { mockAll, PLAYERS } from "./p286-mocks";
import { CHAR_ART_MIN_GRADE, showsCharacterArt } from "../src/common/icon-policy";

/**
 * #286 **W3** — 화면 내용 심화 **계약**. 구현 전에 먼저 박았다(E2E-TDD, 루트 §2-3).
 *
 * W2 가 IA(6탭·홈 런처·게임 탭)를 옮겼다면 W3 은 **hero 가 발제에서 요구한 화면 내용**이다:
 *  (1) 덱 — 지시 레일에 `[⚡ 선수 강화]` 한 줄. 누르면 **선수 탭과 같은** 강화 시트가 열린다
 *  (2) 경기 중에는 그 줄만 잠긴다(배치·프롬프트는 하프타임 지시라 열어 둔다)
 *  (3) 선수 탭 — 카드가 **전신**이고 미보유는 **전신 실루엣**
 *  (4) 선수 탭에서도 강화가 열린다(= 덱과 싱크)
 *  (5) 영입 — 트레이드가 무엇인지 **설명이 화면에 있다**(hero 지적: 튜토리얼에 없다)
 *
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5292 npx playwright test p286-w3.spec.ts
 * (⚠️ e2e 전체 실행 금지 — 일부 스펙이 :8080 라이브 데모에 붙는다.)
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

/** 보드에서 선수 하나를 골라 지시 레일을 연다. */
async function openRail(page: import("@playwright/test").Page) {
  await page.goto("/deck");
  await page.getByTestId("tactics-board").waitFor();
  await page.locator('[data-testid^="token-"]').nth(3).click();
  await page.getByTestId("rail-title").waitFor();
}

// ── (1) 덱 지시 레일의 강화 진입 ─────────────────────────────────────────
test("덱 지시 레일에 [선수 강화] 줄이 있고, 누르면 강화 시트가 열린다", async ({ page }) => {
  // hero: "선수 누르면 프롬프트를 치거나 세부설정을 누를 수 있는데 여기서 강화탭도 사용가능하게".
  // 새 화면이 아니라 **레일의 한 줄**이다 — 세부 조정 옆에 붙는다.
  await mockAll(page);
  await openRail(page);

  const growthRow = page.getByTestId("rail-growth-open");
  await expect(growthRow).toBeVisible();
  await expect(growthRow).toBeEnabled();

  await growthRow.click();
  await expect(page.getByTestId("growth-detail"), "강화 시트가 안 열렸다").toBeVisible();
});

test("덱과 선수 탭이 **같은 강화 시트**를 연다 (hero 가 말한 싱크)", async ({ page }) => {
  // 두 진입점이 다른 컴포넌트를 그리면 한쪽만 고쳐지는 날이 온다. 같은 testid 를 여는지 본다.
  await mockAll(page);

  await openRail(page);
  await page.getByTestId("rail-growth-open").click();
  const fromDeck = await page.getByTestId("growth-detail").getAttribute("data-growth-source");

  await page.goto("/players");
  await page.locator('[data-testid^="codex-card-"]').first().getByRole("button").first().click();
  const fromPlayers = await page.getByTestId("growth-detail").getAttribute("data-growth-source");

  // 같은 컴포넌트가 두 자리에서 열린다 — 값 자체가 아니라 **둘 다 존재**한다는 게 계약이다.
  expect(fromDeck, "덱에서 연 시트에 출처 표시가 없다").toBe("deck");
  expect(fromPlayers, "선수 탭에서 연 시트에 출처 표시가 없다").toBe("players");
});

// ── (2) 경기 중에는 강화만 잠긴다 ────────────────────────────────────────
const ACTIVE_LOCKED = {
  match: { id: "M1", state: "H1_BREAK" },
  locked: true,
  abandonable: true,
};

test("경기 중에는 강화 줄만 잠기고 프롬프트·배치는 열려 있다", async ({ page }) => {
  // hero: "게임중에는 비활성화여야해. 버그가 있을수 있을거같아." — 경기 중 능력치가 바뀌면
  // 진행 중인 시뮬이 쓰는 값과 어긋난다. 다만 **하프타임 지시**는 써야 하므로 프롬프트는 산다.
  await mockAll(page, { active: ACTIVE_LOCKED });
  await openRail(page);

  await expect(page.getByTestId("rail-growth-open")).toBeDisabled();
  // 같은 화면의 프롬프트·세부조정은 그대로다 — "경기 중이라 덱을 통째로 잠갔다"가 아니다.
  await expect(page.getByTestId("rail-tune-toggle")).toBeEnabled();
  await expect(page.getByTestId("rail-prompt-input")).toBeEditable();
});

test("경기 중에는 선수 탭에서도 강화 시트가 열리지 않는다", async ({ page }) => {
  // 덱만 막고 선수 탭을 열어 두면 우회로가 남는다(같은 시트를 여는 두 문 중 하나만 잠근 셈).
  await mockAll(page, { active: ACTIVE_LOCKED });
  await page.goto("/players");
  await page.locator('[data-testid^="codex-card-"]').first().getByRole("button").first().click();
  await page.waitForTimeout(400);
  await expect(page.getByTestId("growth-detail")).toHaveCount(0);
  await expect(page.getByTestId("codex-locked-note"), "왜 안 열리는지 말해 준다").toBeVisible();
});

// ── (3) 선수 탭 — 전신 아트 + 미보유 전신 실루엣 ────────────────────────
test("선수 카드가 전신 아트다 — 얼굴 타일이 아니다", async ({ page }) => {
  // hero: "아이콘 아니라 전신 보여주자. 아이콘만 하면 모으는 재미가 떨어질 것 같아."
  await mockAll(page);
  await page.goto("/players");

  const card = page.locator('[data-testid^="codex-card-"]').first();
  await expect(card).toBeVisible();
  const art = card.locator('[data-testid="codex-card-art"]');
  await expect(art, "전신 아트 창이 없다").toBeVisible();

  // 세로가 더 긴 창이어야 전신이다(얼굴 타일은 정사각이었다).
  const box = await art.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height / box!.width, "아트 창이 세로로 길지 않다 = 얼굴 타일이다").toBeGreaterThan(1.2);
});

/**
 * **전신은 다이아 이상만이다 — hero 확정(Q6 = B, 2026-07-30).**
 *
 * #285 노출 정책(`icon-policy.CHAR_ART_MIN_GRADE`)이 도감보다 먼저 걸려 골드 이하는 아트를
 * 안 그린다. hero 는 그 사실을 알고 **AC 를 좁히는 쪽**을 택했다(하위 133명이 공용 도트 하나를
 * 공유해서, 전신으로 깔면 같은 그림이 133칸 반복된다).
 *
 * ⚠️ 이 계약은 **정책 상수를 직접 읽는다** — 등급 이름을 여기 적으면 임계를 옮길 때 조용히
 * 어긋난다(`icon-policy` 주석이 금지하는 그것). 임계가 바뀌면 여기가 **먼저 깨져서** 그때
 * "도감 AC 를 다시 볼 때"임을 알려 준다.
 */
test("전신은 다이아 이상만 — 그 아래는 아트를 그리지 않는다 (hero Q6=B)", async ({ page }) => {
  await mockAll(page);
  await page.goto("/players");
  await page.getByTestId("codex-scope-all").click();

  // ⚠️ **결정 자체를 박는다.** 아래 루프만 두면 앱과 계약이 **같은 상수를 읽어 같이 움직여서**
  //    임계를 옮겨도 초록이다(실측: DIA→GOLD 로 바꿔도 통과 = tautology). 그건 "앱이 정책을
  //    따르나"만 보는 것이고, hero 가 고른 건 **"DIA"라는 값** 이다. 값이 바뀌면 여기가 먼저
  //    깨져서 "도감 AC(전신 범위)를 다시 볼 때"임을 알린다.
  expect(
    CHAR_ART_MIN_GRADE,
    "아트 노출 임계가 바뀌었다 — 도감 전신 AC(hero Q6=B: 다이아 이상만)를 다시 보라",
  ).toBe("DIA");

  const above = PLAYERS.filter((p) => showsCharacterArt(p.grade as never));
  const below = PLAYERS.filter((p) => !showsCharacterArt(p.grade as never));
  expect(above.length, "임계 이상 표본이 없다").toBeGreaterThan(0);
  expect(below.length, "임계 미만 표본이 없다").toBeGreaterThan(0);

  for (const p of above) {
    const img = page.getByTestId(`codex-card-${p.id}`).locator('[data-testid="codex-card-art"] img');
    await expect(img, `${p.id}(${p.grade}) 는 임계 이상인데 아트가 없다`).toHaveCount(1);
  }
  for (const p of below) {
    const img = page.getByTestId(`codex-card-${p.id}`).locator('[data-testid="codex-card-art"] img');
    await expect(img, `${p.id}(${p.grade}) 는 임계 미만인데 아트가 그려졌다(#285 정책 위반)`).toHaveCount(0);
  }
});

test("미보유 카드는 아트가 있으면 실루엣이다", async ({ page }) => {
  // 잠긴 카드에 원색 전신을 띄우면 잠금 표현과 어긋난다(그게 원래 정책의 이유였다).
  // 실루엣이 그 이유를 해소하므로 정책을 뒤집는 대가가 없다.
  //
  // ⚠️ **아트가 있는 카드에만 해당한다.** #285 정책이 다이아 미만 아트를 막아 GOLD 이하는
  //    `<img>` 자체가 없다 — 필터를 걸 대상이 없는 것이지 구현이 빠진 게 아니다.
  //    `.first()` 로 하나만 보면 그 사실이 통째로 숨는다(독립검증 W3 BL-1 이 그걸 잡았다).
  await mockAll(page);
  await page.goto("/players");
  await page.getByTestId("codex-scope-all").click();

  const lockedCards = page.locator('[data-testid^="codex-card-"][data-owned="false"]');
  const n = await lockedCards.count();
  expect(n, "미보유 표본이 없다").toBeGreaterThan(0);

  let withArt = 0;
  for (let i = 0; i < n; i += 1) {
    const img = lockedCards.nth(i).locator('[data-testid="codex-card-art"] img');
    if ((await img.count()) === 0) continue;   // 아트 미노출 등급(#285) — 아래 계약이 따로 본다
    withArt += 1;
    const filter = await img.first().evaluate((el) => getComputedStyle(el).filter);
    expect(filter, `실루엣 처리가 없다(filter=${filter})`).toContain("brightness(0)");
  }
  expect(withArt, "아트가 붙은 미보유 카드가 하나도 없다 = 표본이 계약을 대표하지 못한다")
    .toBeGreaterThan(0);
});

test("미보유 잠금 표현은 **등급과 무관하게** 같다", async ({ page }) => {
  // 독립검증 W3 BL-1: 아트가 있는 등급만 자물쇠가 붙어, **같은 상태가 등급에 따라 두 그림**으로
  // 갈렸다(DIA=검은 판+자물쇠 / GOLD=밝은 이니셜 원). 잠금은 등급의 함수가 아니다.
  await mockAll(page);
  await page.goto("/players");
  await page.getByTestId("codex-scope-all").click();

  const lockedCards = page.locator('[data-testid^="codex-card-"][data-owned="false"]');
  const n = await lockedCards.count();
  const marks = await lockedCards.evaluateAll((els) =>
    els.map((el) => {
      const art = el.querySelector('[data-testid="codex-card-art"]');
      if (!art) return "no-art-window";
      return getComputedStyle(art, "::after").content !== "none" ? "lock" : "none";
    }),
  );
  expect(marks).toHaveLength(n);
  expect(new Set(marks).size, `잠금 표현이 갈라졌다: ${[...new Set(marks)].join(" vs ")}`).toBe(1);
  expect(marks[0]).toBe("lock");
});

test("미보유 카드는 이름을 감춘다 — 이니셜까지", async ({ page }) => {
  // ⚠️ 라벨만 `？？？` 로 바꾸면 **아트 폴백이 이름 파생 이니셜**을 그린다(실측 "선2").
  //    `not.toContainText("선수 ")` 는 뒤 공백 때문에 그걸 못 잡았다(독립검증 W3 MAJ-1).
  //    그래서 카드 안에 **원래 이름의 앞글자**가 남아 있지 않은지 본다.
  await mockAll(page);
  await page.goto("/players");
  await page.getByTestId("codex-scope-all").click();

  const lockedCards = page.locator('[data-testid^="codex-card-"][data-owned="false"]');
  const n = await lockedCards.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) {
    const text = (await lockedCards.nth(i).innerText()).replace(/\s/g, "");
    expect(text, `미보유 카드에 이름 흔적이 남았다: ${text}`).not.toMatch(/선수\d/);
    expect(text, `미보유 카드에 이름 이니셜이 남았다: ${text}`).not.toMatch(/선\d/);
  }
});

// ── (5) 영입 — 트레이드 설명 ─────────────────────────────────────────────
test("영입 [트레이드] 탭에 무엇인지 설명이 있다", async ({ page }) => {
  // hero: "튜토리얼에 트레이드 설명이 빠져 있음 → 추가."
  // 상시 안내 카드로 둔다 — 코치마크만이면 한 번 보고 넘긴 사람은 영영 못 본다.
  await mockAll(page);
  await page.goto("/recruit?tab=trade");
  const guide = page.getByTestId("trade-guide");
  await expect(guide).toBeVisible();
  // 무엇을 하는 곳인지 말한다 — 두 갈래(FA·맞교환)가 있다는 사실이 핵심이다.
  await expect(guide).toContainText("FA");
  await expect(guide).toContainText("교환");
});

test("뽑기 탭에는 트레이드 설명이 없다 — 지금 하는 일만 말한다", async ({ page }) => {
  await mockAll(page);
  await page.goto("/recruit");
  await expect(page.getByTestId("trade-guide")).toHaveCount(0);
});
