import { expect, test, type Page } from "@playwright/test";

/**
 * #294 MAJOR — **감독시간 실패가 화면에서 보여야 한다** (E2E-TDD, 전면 목킹).
 *
 * `POST /halftime` 이 실패하면 `HalftimePanel` 은 `ErrorToast` 를 띄우는데, 그 토스트가
 * **스크롤 영역 맨 끝**에 있고 CTA(`resume-button`)는 그 아래 고정이라 — 토스트가 CTA **뒤로**
 * 들어가 보이지 않았다(실측 alert `y=800.5 h=43` vs CTA `y=772 h=52`).
 * 유저 눈에는 [후반 시작]을 눌렀는데 **화면이 클릭 전과 완전히 동일**하다 → "버튼 먹통"으로 읽힌다.
 * `scrollIntoViewIfNeeded()` 를 호출해야만 보였다(= 유저는 볼 방법이 없다).
 *
 * ⚠️ **선행 결함이다** — #284 가 만든 게 아니라 #244 가 CTA 를 스크롤 밖 바닥에 앉히면서 생겼다.
 * 그 결정 자체는 옳다(프롬프트를 안 덮으려는 것) → 그러니 CTA 를 되돌리지 말고 **토스트를
 * 스크롤 밖으로** 옮긴다.
 *
 * ⚠️ 이 계약은 `toBeVisible()` 을 믿지 않는다 — 그건 뷰포트 밖도 통과시킨다(#286 W3.5 에서
 * 실제로 당했다). **좌표로 잰다**: 토스트가 뷰포트 안에 있고 CTA 와 겹치지 않는다.
 */

const PHONE = { width: 390, height: 844 };

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const P = (id: string, name: string, position: string, grade: string, ov: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(ov), personality: "CALM",
});

const PLAYERS = [
  P("GK1", "골리원", "GK", "GOLD", 70),
  P("DF1", "수비하나", "DF", "GOLD", 76), P("DF2", "수비둘", "DF", "SILVER", 68),
  P("DF3", "수비셋", "DF", "SILVER", 64), P("DF4", "수비넷", "DF", "BRONZE", 55),
  P("MF1", "미드하나", "MF", "DIA", 84), P("MF2", "미드둘", "MF", "GOLD", 74),
  P("MF3", "미드셋", "MF", "SILVER", 66), P("MF4", "미드넷", "MF", "SILVER", 61),
  P("FW1", "공격하나", "FW", "LEGEND", 90), P("FW2", "공격둘", "FW", "GOLD", 72),
  P("SUB1", "교체자원", "FW", "SILVER", 69), P("SUB2", "교체골리", "GK", "BRONZE", 58),
];
const SNAP_STARTERS = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1", "FW2"];
const SNAPSHOT = {
  formation: "4-4-2",
  starters: SNAP_STARTERS.map((playerId, i) => ({ playerId, slotIndex: i, promptText: null })),
  bench: [
    { playerId: "SUB1", slotIndex: 0, promptText: null },
    { playerId: "SUB2", slotIndex: 1, promptText: null },
  ],
  teamTactics: { line: 0.25, press: 0.5, tempo: 0.5, width: 0.5 },
};
const deckSlots = [
  ...SNAP_STARTERS.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
  { playerId: "SUB1", role: "bench", slotIndex: 0, promptText: null },
  { playerId: "SUB2", role: "bench", slotIndex: 1, promptText: null },
];

const json = (body: unknown, status = 200) => ({
  status, contentType: "application/json", body: JSON.stringify(body),
});

function halftimeClock(remainingMs = 47_000) {
  const now = Date.now();
  return {
    phase: "HALFTIME",
    kickoffAt: new Date(now - 600_000).toISOString(),
    phaseStartAt: new Date(now - (60_000 - remainingMs)).toISOString(),
    phaseEndsAt: new Date(now + remainingMs).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: 180_000,
    halftimeMs: 60_000,
    seekForwardBlocked: true,
    seekGraceMs: 1_500,
  };
}

/** `halftimeFails` = `POST /halftime` 이 500 을 준다(= 후반 시작 실패 경로). */
async function openHalftime(page: Page, opts: { halftimeFails?: boolean } = {}) {
  const match = {
    id: "m294",
    createdAt: "2026-07-31T00:00:00Z",
    state: "HALFTIME",
    scoreH1Home: 0, scoreH1Away: 1, scoreHome: 0, scoreAway: 1,
    conditions: Object.fromEntries(SNAP_STARTERS.map((id, i) => [id, 0.3 + (i % 5) * 0.15])),
    opponent: { name: "역습 봇", analysisText: "빠른 역습.", deck: [] },
    clock: halftimeClock(),
    userDeckSnapshot: SNAPSHOT,
  };

  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (r) => r.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/relations", (r) =>
    r.fulfill(json({ morale: 60, streak: 0, players: [] })));
  await page.route((url) => url.pathname === "/api/conditions/today", (r) =>
    r.fulfill(json(Object.fromEntries(SNAP_STARTERS.map((id, i) => [id, 0.5])))));
  await page.route((url) => url.pathname === "/api/me", (r) => r.fulfill(json({
    user: { id: "u1", nickname: "테스터", provider: "guest", tutorialDone: true },
    wallet: { points: 1000 }, records: { played: 0, wins: 0, draws: 0, losses: 0 },
  })));
  await page.route((url) => url.pathname === "/api/me/active-match", (r) =>
    r.fulfill(json({ match: null, locked: false, abandonable: false })));
  await page.route((url) => url.pathname === "/api/deck", (r) =>
    r.fulfill(json({ formation: "4-4-2", slots: deckSlots, teamPrompt: null })));
  await page.route((url) => url.pathname === "/api/matches/m294/halftime", (r) =>
    opts.halftimeFails
      ? r.fulfill(json({ code: "INTERNAL", message: "후반 시뮬레이션 큐가 응답하지 않습니다" }, 500))
      : r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/matches/m294", (r) => r.fulfill(json(match)));

  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/match/m294");
  await expect(page.getByTestId("halftime-panel")).toBeVisible({ timeout: 30_000 });
}

test.use({ viewport: PHONE });

test("후반 시작이 실패하면 그 사실이 화면에 보인다 — CTA 에 가리지 않는다 (#294 MAJOR)", async ({ page }) => {
  await openHalftime(page, { halftimeFails: true });

  await page.getByTestId("resume-button").click();

  const alert = page.getByRole("alert").filter({ hasText: "후반 시뮬레이션 큐" });
  await alert.waitFor({ timeout: 10_000 });

  /**
   * ⚠️ 여기서 `toBeVisible()` 로 끝내면 **결함이 그대로 통과한다** — 스크롤 영역 끝의 토스트도
   * "visible" 이다. 유저가 실제로 볼 수 있는지는 **좌표**로만 알 수 있다.
   */
  const [box, cta, vp] = await Promise.all([
    alert.boundingBox(),
    page.getByTestId("resume-button").boundingBox(),
    page.viewportSize(),
  ]);
  expect(box, "실패 안내 박스를 측정할 수 없다").not.toBeNull();
  expect(cta).not.toBeNull();

  const bottom = box!.y + box!.height;
  expect(box!.y, `실패 안내가 화면 위로 벗어났다 (y=${box!.y})`).toBeGreaterThanOrEqual(0);
  expect(bottom, `실패 안내가 화면 아래로 벗어났다 (bottom=${bottom}, vp=${vp!.height})`)
    .toBeLessThanOrEqual(vp!.height);

  // CTA 와 세로로 겹치지 않는다 — 겹치면 둘 중 하나가 상대를 가린다(이 결함의 본체).
  const overlap = Math.min(bottom, cta!.y + cta!.height) - Math.max(box!.y, cta!.y);
  expect(overlap, `실패 안내와 CTA 가 ${Math.round(overlap)}px 겹친다`).toBeLessThanOrEqual(0);

  // 그리고 실제로 그 자리에서 **읽힌다** — 다른 요소가 위에 덮여 있지 않은지 히트테스트.
  const onTop = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x as number, y as number);
    return Boolean(el?.closest('[role="alert"]'));
  }, [box!.x + box!.width / 2, box!.y + box!.height / 2]);
  expect(onTop, "실패 안내 위에 다른 요소가 덮여 있다").toBe(true);
});

test("성공 경로에서는 실패 안내가 뜨지 않는다 (자리만 차지하지 않는다)", async ({ page }) => {
  // 실패 안내를 상시 노출로 '해결'하는 회귀를 막는다 — 빈 알림 자리는 그 자체로 소음이다.
  await openHalftime(page, { halftimeFails: false });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("resume-button")).toBeVisible();
});

/**
 * #294 MINOR-2 — **벤치 선수 지시를 감독시간에서 보고 고칠 수 있다** (main 확정 ⓑ).
 *
 * 전반 `후반 지시` 탭은 벤치에게도 지시를 쓸 수 있고 서버에 저장된다(로스터 = 선발+벤치).
 * 그런데 감독시간 보드에 **벤치 토큰이 없어서** 어느 선수에게 쓴 건지 화면에서 볼 수 없었다 —
 * 동작 손실은 없고 **열람·수정 경로만** 없는 상태였다. 교체가 일어나는 시점이 정확히 감독시간이라
 * 들어올 선수에게 한 말을 그 자리에서 보고 고치는 것이 자연스럽다.
 */
test.describe("감독시간 벤치 지시 (#294 MINOR-2)", () => {
  test("[감독의 한마디] 에서 벤치 토큰이 보이고, 눌러 지시를 쓸 수 있다", async ({ page }) => {
    await openHalftime(page);

    // 기본 모드가 [감독의 한마디] — 여기서 벤치가 펴져 있어야 한다.
    await expect(page.getByTestId("halftime-mode-say")).toHaveAttribute("aria-selected", "true");

    /**
     * ⚠️ **기본은 접힘이다.** 상시 노출은 #276 AC7 을 깬다 — 그 계약은 기본 모드에서 팀 프롬프트가
     * **스크롤 0 에서 여유까지** 보일 것을 요구하는데(2R blocker-1), 벤치 줄이 약 87px 를 더해
     * 360×740 에서 프롬프트가 CTA 를 9px 침범했다(실측). 그래서 "필요할 때 편다"로 간다.
     */
    await expect(page.getByTestId("token-SUB1")).toHaveCount(0);
    await page.getByTestId("halftime-bench-toggle").click();
    await expect(page.getByTestId("token-SUB1"), "벤치 토큰이 보드에 없다").toBeVisible();

    await page.getByTestId("token-SUB1").click();
    await expect(page.getByTestId("rail-title")).toContainText("교체자원");

    const posts: Array<{ scope?: string; playerId?: string | null; text?: string }> = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      if (!new URL(req.url()).pathname.endsWith("/prompts")) return;
      try {
        posts.push(JSON.parse(req.postData() ?? "{}"));
      } catch { /* 바디 없는 요청은 계약 밖 */ }
    });

    await page.getByTestId("rail-prompt-input").fill("들어가면 바로 앞으로 뛰어라");
    await page.getByTestId("resume-button").click();

    await expect
      .poll(() => posts.filter((p) => p.playerId === "SUB1").map((p) => p.text))
      .toEqual(["들어가면 바로 앞으로 뛰어라"]);
  });

  test("[자리] 모드에서는 벤치를 접는다 — 넣을 선수를 고를 자리가 아니다", async ({ page }) => {
    // 모드마다 벤치의 뜻이 다르다. 전부 펴 버리면 [자리]에서 벤치를 눌러도 아무 일이 안 나는
    // 죽은 손잡이가 생긴다(자리 바꾸기는 선발끼리다).
    await openHalftime(page);
    // 감독 모드에서 펴 둔 뒤 [자리]로 가도 접혀 있어야 한다(모드마다 벤치의 뜻이 다르다).
    await page.getByTestId("halftime-bench-toggle").click();
    await expect(page.getByTestId("token-SUB1")).toBeVisible();
    await page.getByTestId("halftime-mode-move").click();
    await expect(page.getByTestId("token-SUB1")).toHaveCount(0);
    await expect(page.getByTestId("halftime-bench-toggle"), "[자리]에는 벤치 토글이 없다").toHaveCount(0);
  });

  test("벤치를 펴도 선발 자리로 끌어올릴 수는 없다 — 그건 교체다", async ({ page }) => {
    /**
     * ⚠️ 이 계약이 새로 필요해진 이유: 벤치를 펴기 전까지 `DeckEditor` 의 벤치↔선발 드래그 차단은
     * **도달 불가능한 방어**였다(그 파일 주석이 "hideBench 가 바뀌는 순간 이 줄이 유일한 방벽이
     * 되므로 지우지 마라"라고 예고해 뒀다). 이제 도달 가능하므로 계약을 건다.
     * 교체는 규칙(≤3·GK≥1)을 가진 [교체] 모드가 소유한다 — 같은 일을 하는 손잡이를 둘로 만들지 않는다.
     */
    await openHalftime(page);
    await page.getByTestId("halftime-bench-toggle").click();
    const before = await page.getByTestId("token-FW2").boundingBox();
    const bench = await page.getByTestId("token-SUB1").boundingBox();
    expect(before).not.toBeNull();
    expect(bench).not.toBeNull();

    await page.mouse.move(bench!.x + bench!.width / 2, bench!.y + bench!.height / 2);
    await page.mouse.down();
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // 선발은 그대로다 — 벤치 선수가 선발 슬롯을 차지하지 않았다.
    const starterIds = await page.evaluate(() =>
      [...document.querySelectorAll("[data-testid^='board-slot-starter-']")]
        .map((el) => el.querySelector("[data-testid^='token-']")?.getAttribute("data-testid") ?? null));
    expect(starterIds, "벤치 선수가 드래그로 선발에 들어갔다").not.toContain("token-SUB1");
  });
});
