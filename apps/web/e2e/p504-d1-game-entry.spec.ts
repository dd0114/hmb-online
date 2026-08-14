import { expect, test, type Page, type Request } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * #504 D1-A — **제안 판정 지점이 `/game` 도착으로 올라갔다** (hero 결정, 2026-08-15).
 *
 * ## 무엇이 문제였나
 * 온레일 제안 판정은 홈 타일 `pressTile` **한 곳에만** 있었다. 그런데 게임 화면으로 가는 길은
 * 그것 하나가 아니다 — **하단탭 [게임]**(전 화면 상시 노출) · 덱 화면의 `navigate("/game")` ·
 * URL 직접 · 뒤로가기. 그 경로들은 판정을 **평가조차 하지 않아** 신규 유저가 온레일의 존재를
 * 모른 채 지나갔다. 오픈베타 실유저 2명 / 온레일 발화 **0명**이 그 결과다.
 *
 * ## 무엇을 계약하나
 * 판정을 **도착 지점**으로 올렸으므로 계약도 "어느 버튼을 눌렀나"가 아니라 **"게임 화면에 닿았나"**
 * 로 쓴다. 그래서 ①하단탭 · ②URL 직접 · ③홈 타일 세 경로가 **같은 결과**여야 한다 —
 * 그게 D1-B(탭에만 같은 판정을 심기)와 갈리는 지점이고, 새 진입로가 생겨도 안 새는 이유다.
 *
 * ⚠️ **수용한 대가**(hero 명시): 리그·원정만 하러 온 신규 유저도 **1회** 모달을 본다. 자격은 그
 * 순간 소모되므로(수락이든 거절이든) 두 번은 없다 — ⑤가 그 성질을 박제한다.
 *
 * ⚠️ 라우트 매칭은 **오리진 앵커**(pathname 술어)다. glob 으로 잡으면 vite 소스까지 먹어 흰 화면이 된다.
 */

const USER_ID = "u504d1";
const TELEMETRY = "/api/me/onrail-events";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const P = (id: string, name: string, position: string) => ({
  id, name, position, grade: "GOLD", owned: true, ownedCount: 1, attributes: attrs(70), active: true,
});
const PLAYERS = [
  P("GK1", "골리원", "GK"), P("DF1", "수비하나", "DF"), P("DF2", "수비둘", "DF"),
  P("DF3", "수비셋", "DF"), P("DF4", "수비넷", "DF"), P("MF1", "미드하나", "MF"),
  P("MF2", "미드둘", "MF"), P("MF3", "미드셋", "MF"), P("MF4", "미드넷", "MF"),
  P("FW1", "공격하나", "FW"), P("FW2", "공격둘", "FW"),
];
const TEN = PLAYERS.slice(0, 10).map((p) => p.id);

interface Reported {
  event: string;
  stepId?: string;
}

interface Harness {
  reports: Reported[];
  /** 덱 없는 계정 팔 — `/api/deck` 이 404(= `useDeck` 이 `null` 로 정규화). */
  deckMissing: boolean;
}

async function mockApi(page: Page, over: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = { reports: [], deckMissing: false, ...over };
  const deck = {
    formation: "4-4-2",
    slots: TEN.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
    teamPrompt: null,
  };

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const req: Request = route.request();
    const p = new URL(req.url()).pathname;

    if (p === TELEMETRY && req.method() === "POST") {
      h.reports.push((req.postDataJSON() ?? {}) as Reported);
      return route.fulfill(json({ recorded: true }));
    }

    if (p === "/api/me") {
      return route.fulfill(json({
        user: { id: USER_ID, nickname: "온레일", tutorialDone: true },
        wallet: { points: 5000, gems: 0 },
        records: { played: 0, wins: 0, draws: 0, losses: 0 },
        rating: 1000,
        coupons: { FREE_ENHANCE: 1, FREE_TRADE_RUSH: 1, FIRST_TRADE_EPIC: 1 },
      }));
    }
    if (p === "/api/players") return route.fulfill(json(PLAYERS));
    if (p === "/api/presets") return route.fulfill(json([]));
    if (p === "/api/presets/team") {
      return route.fulfill(json([1, 2, 3].map((slot) => ({ slot, name: null, snapshot: null }))));
    }
    if (p === "/api/relations") return route.fulfill(json({ morale: 60, streak: 0, players: [] }));
    if (p === "/api/conditions/today") {
      return route.fulfill(json(Object.fromEntries(TEN.map((id, i) => [id, 0.3 + (i % 5) * 0.15]))));
    }
    if (p === "/api/growth/choices") return route.fulfill(json({ choices: [] }));
    if (p === "/api/me/active-match") {
      return route.fulfill(json({ match: null, locked: false, abandonable: false }));
    }
    if (p === "/api/deck") {
      if (h.deckMissing) {
        /*
         * ⚠️ **이 지연이 계약의 일부다**(독립 검증 m1). 목이 즉시 응답하면 `me` 와 `deck` 이 같은
         * 배치에 도착해 **로딩 창이 열리지 않고**, 그러면 `GamePage` 의 `deck === undefined` 가드를
         * 지워도 이 스펙이 통과한다(실측: 변이체 생존). 실서버에는 그 창이 있고, 거기서 가드가
         * 없으면 `deckMissing(undefined) === false` 라 **덱 없는 유저에게 제안이 떠** D3 분기가
         * 언제나 "제안"으로 굳는다 — 스위치가 무의미해지는 바로 그 시나리오다.
         */
        await new Promise((r) => setTimeout(r, 300));
        return route.fulfill(json({ code: "NOT_FOUND", message: "덱이 없습니다" }, 404));
      }
      return route.fulfill(json(deck));
    }
    return route.fulfill(json({}));
  });
  return h;
}

/** 온보딩을 막 끝낸 계정 = 토큰 + 가이드 pending 래치(제안의 발화 조건). */
async function seedNewUser(page: Page) {
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_user");
    window.localStorage.setItem(`hmb.guide.pending.${uid}`, "1");
  }, USER_ID);
}

/** 토큰만 있는 기존 유저 — 래치가 없다. */
async function seedExistingUser(page: Page) {
  await skipSplash(page);
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
}

const eventsOf = (h: Harness) => h.reports.map((r) => r.event);

/**
 * ⚠️ `AppNav` 는 같은 항목을 **두 벌** 렌더하고 CSS 로 하나만 보인다(모바일 하단탭 / 데스크탑
 * 사이드바) — 앵커 없이 잡으면 strict mode 위반, 한쪽으로 앵커하면 반대 폭에서 영원히 안 보인다.
 */
const navTab = (page: Page, key: string) => page.locator(`[data-testid="nav-${key}"]:visible`);

// ── ① 하단탭 [게임] — 이 이슈를 만든 바로 그 경로 ─────────────────────────

test("① 하단탭 [게임]으로 들어가도 제안이 뜬다 (우회가 사라졌다)", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  // 홈에는 하단탭이 없다(홈 자체가 내비) — 실유저가 그러듯 다른 화면에서 탭을 누른다.
  await page.goto("/deck");
  await navTab(page, "game").click();
  await expect(page).toHaveURL(/\/game$/);

  await expect(page.getByTestId("practice-tutorial-dialog")).toBeVisible();
  await expect.poll(() => eventsOf(h)).toContain("onrail_offer_shown");
  // **핵심** — 이 경로가 우회로 세어지던 것이 D1 이었다. 이제 세어지지 않는다.
  expect(eventsOf(h)).not.toContain("onrail_offer_missed");
});

// ── ② URL 직접·뒤로가기 — 버튼이 아니라 '도착'이 판정 지점이라는 증거 ───────

test("② URL 로 /game 에 직접 들어가도 제안이 뜬다", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/game");

  await expect(page.getByTestId("practice-tutorial-dialog")).toBeVisible();
  await expect.poll(() => eventsOf(h)).toContain("onrail_offer_shown");
  expect(eventsOf(h)).not.toContain("onrail_offer_missed");
});

// ── ③ 홈 타일도 같은 결과 — 경로가 하나로 합쳐졌다 ─────────────────────────

test("③ 홈 [게임 시작]도 같은 제안에 도달한다 (판정이 두 벌이 아니다)", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();

  // ⚠️ 구 동작과 갈리는 지점: 모달은 이제 **홈이 아니라 게임 화면**에서 뜬다.
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByTestId("practice-tutorial-dialog")).toBeVisible();
  await expect.poll(() => eventsOf(h)).toContain("onrail_offer_shown");
});

// ── ④ 수락 = 온레일 시작 ──────────────────────────────────────────────────

test("④ 수락하면 덱 화면에서 온레일이 시작된다", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/game");
  await page.getByTestId("practice-tutorial-accept").click();

  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByTestId("onrail-overlay")).toBeVisible();
  await expect.poll(() => eventsOf(h)).toContain("onrail_accepted");
});

// ── ⑤ 거절 = 그 자리에 남고 다시 묻지 않는다 (수용한 대가의 상한) ──────────

test("⑤ 거절하면 게임 화면에 그대로 남고, 다시 들어와도 묻지 않는다", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/game");
  await page.getByTestId("practice-tutorial-decline").click();

  // 안내가 동선을 끊지 않는다 — 원래 가려던 화면이 그대로 남는다.
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByTestId("game-page")).toBeVisible();
  await expect.poll(() => eventsOf(h)).toContain("onrail_declined");

  // 재진입 — 자격이 소모됐다. "리그 하러 온 유저가 매번 막힌다"가 되지 않는 근거.
  await navTab(page, "deck").click();
  await navTab(page, "game").click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByTestId("practice-tutorial-dialog")).toHaveCount(0);
  expect(eventsOf(h)).not.toContain("onrail_offer_missed");
});

// ── ⑥ 자격 없는 유저는 그대로 통과 (기존 유저 방해 0) ──────────────────────

test("⑥ 래치 없는 기존 유저는 /game 에서 아무것도 맞지 않는다", async ({ page }) => {
  const h = await mockApi(page);
  await seedExistingUser(page);

  await page.goto("/game");
  await expect(page.getByTestId("game-page")).toBeVisible();
  await page.waitForTimeout(300);

  await expect(page.getByTestId("practice-tutorial-dialog")).toHaveCount(0);
  expect(eventsOf(h)).toEqual([]);
});

// ── ⑦ D3 스위치 기본값 = ②현행 유지 (덱없음 가드가 제안보다 먼저) ──────────

test("⑦ 덱이 없는 자격자에게는 제안 대신 '우회' 사실이 남는다 (D3 기본값)", async ({ page }) => {
  const h = await mockApi(page, { deckMissing: true });
  await seedNewUser(page);

  await page.goto("/game");
  await expect(page.getByTestId("game-page")).toBeVisible();

  /*
   * D3(덱없음 가드와 제안의 순서)는 **hero 미회신**이라 기본값을 ②현행 유지로 착지시켰다.
   * 그래서 이 경우만은 여전히 "자격이 있는데 제안 없이 도착"이고 — 그 사실이 서버에 남는다.
   * ⚠️ `offer_missed` 가 **죽은 이벤트가 되지 않는 이유**가 여기다: D1-A 로 우회가 사라져도
   * 이 창은 남아 있고, 그 크기를 재는 것이 D3 를 뒤집을지 말지의 근거가 된다.
   */
  await expect.poll(() => eventsOf(h)).toContain("onrail_offer_missed");
  await expect(page.getByTestId("practice-tutorial-dialog")).toHaveCount(0);
  expect(eventsOf(h)).not.toContain("onrail_offer_shown");
});
