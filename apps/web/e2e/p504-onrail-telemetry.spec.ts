import { expect, test, type Page, type Request } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * #504 D2 — **온레일 관측** E2E (route-mock 전용, 백엔드 무접촉).
 *
 * ## 이 스펙이 지키는 것
 * #493 온레일이 실사용자에게 발화했는지를 조사했더니 **판정 자체가 불가능**했다 — 온레일은
 * 브라우저 안에서만 도는 안내 계층이라 제안 노출·수락·거절·스텝이 서버에 아무 흔적도 안 남기고,
 * 그래서 *"제안을 못 받았다"* 와 *"제안을 받고 거절했다"* 의 DB 흔적이 **완전히 같았다**.
 *
 * 그러므로 여기서 재는 것은 "요청이 하나 나갔다"가 아니라 **세 동선이 서로 다른 사실을 남기는가**다:
 *  ① 홈 타일 → 제안 → 수락 (`offer_shown` → `accepted` → `step`)
 *  ② 홈 타일 → 제안 → 거절 (`offer_shown` → `declined`, **`offer_missed` 아님**)
 *  ③ **하단탭 [게임] 우회** → 제안이 평가조차 안 된다 (`offer_missed`, **`offer_shown` 0**)
 * ③이 D1(동선 결함)의 크기를 재는 유일한 신호다 — 그걸 고치면 이 이벤트가 0 으로 떨어지는 것이
 * 그 수정의 증거가 된다.
 *
 * ④ 는 반대 방향이다: **계측이 동선을 막지 않는다**. 이 축이 없으면 "보고를 await 하고 실패를
 * 토스트로 올리는" 변이체가 ①~③ 을 전부 통과한다 — 그러면 관측이 튜토리얼을 깨뜨린다.
 *
 * ⚠️ 라우트 매칭은 **오리진 앵커**(pathname 술어)다. glob 으로 잡으면 vite 소스까지 먹어 흰 화면이
 * 된다(모듈 CLAUDE.md 규율).
 */

const USER_ID = "u504r";
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
/** 선발 10명 — 한 자리를 비워 둔다(온레일 S2 첫 스텝이 [자동 채우기]라 그 손잡이가 있어야 한다). */
const TEN = PLAYERS.slice(0, 10).map((p) => p.id);

interface Reported {
  event: string;
  stepId?: string;
  path?: string;
}

interface Harness {
  /** 보고된 사실들 — 이 배열이 이 스펙의 관측 대상 전부다. */
  reports: Reported[];
  /** 계측 엔드포인트가 실패하는가(④ 전용). */
  telemetryFails: boolean;
}

async function mockApi(page: Page, over: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = { reports: [], telemetryFails: false, ...over };
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
      // ④ 실패 팔 — 서버가 죽어도 클라가 멈추면 안 된다.
      return h.telemetryFails
        ? route.fulfill(json({ code: "INTERNAL", message: "boom" }, 500))
        : route.fulfill(json({ recorded: true }));
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
    if (p === "/api/deck") return route.fulfill(json(deck));
    return route.fulfill(json({}));
  });
  return h;
}

/** 온보딩을 막 끝낸 계정 = 토큰 + 가이드 pending 래치(제안 모달의 발화 조건). */
async function seedNewUser(page: Page) {
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_user");
    window.localStorage.setItem(`hmb.guide.pending.${uid}`, "1");
  }, USER_ID);
}

const eventsOf = (h: Harness) => h.reports.map((r) => r.event);

/**
 * 그 내비 칸. ⚠️ `AppNav` 는 **같은 항목을 두 벌** 렌더하고 CSS 미디어쿼리로 하나만 보인다
 * (모바일 하단탭 / 데스크탑 사이드바) — 앵커 없이 잡으면 strict mode 위반이고, 한쪽 컨테이너로
 * 앵커하면 **반대 폭에서 영원히 안 보인다**. 우회는 두 표현 모두에 있으므로 **보이는 쪽**을 누른다.
 */
const navTab = (page: Page, key: string) => page.locator(`[data-testid="nav-${key}"]:visible`);

// ── ① 홈 타일 → 제안 → 수락 ───────────────────────────────────────────────

test("① 홈 [게임 시작]에서 제안이 뜨면 '노출'이, 수락하면 '수락'과 첫 스텝이 남는다", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await expect(page.getByTestId("practice-tutorial-dialog")).toBeVisible();
  await expect.poll(() => eventsOf(h)).toContain("onrail_offer_shown");

  await page.getByTestId("practice-tutorial-accept").click();
  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByTestId("onrail-overlay")).toBeVisible();

  await expect.poll(() => eventsOf(h)).toContain("onrail_accepted");
  // 스텝 진입이 남아야 "어디서 이탈했나"를 읽는다 — 노출·수락만으로는 퍼널이 S1 에서 끝난다.
  await expect.poll(() => h.reports.filter((r) => r.event === "onrail_step").length).toBeGreaterThan(0);
  expect(h.reports.find((r) => r.event === "onrail_step")?.stepId).toBeTruthy();

  // 제안을 **받은** 유저는 우회로 세어지면 안 된다(두 축이 섞이면 D1 의 크기를 못 잰다).
  expect(eventsOf(h)).not.toContain("onrail_offer_missed");
});

// ── ② 거절이 '미노출'과 다른 사실로 남는다 (이 이슈의 두 번째 결함) ─────────

test("② 거절은 '거절'로 남는다 — 제안을 못 받은 것과 구별된다", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("practice-tutorial-decline").click();
  await expect(page).toHaveURL(/\/game$/);

  await expect.poll(() => eventsOf(h)).toContain("onrail_declined");
  expect(eventsOf(h)).toContain("onrail_offer_shown");
  // ⚠️ 거절한 유저는 이제 자격이 소모돼(`hmb.guide.practice`) /game 도착이 우회가 아니다.
  expect(eventsOf(h)).not.toContain("onrail_offer_missed");
});

// ── ③ 하단탭 우회 — D1 의 크기를 재는 유일한 신호 ─────────────────────────

test("③ 하단탭 [게임]으로 들어가면 제안이 평가조차 안 된 사실이 남는다", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  // 홈에는 하단탭이 없다(홈 자체가 내비) — 실제 유저가 그러듯 다른 화면에서 탭을 누른다.
  await page.goto("/deck");
  await navTab(page, "game").click();
  await expect(page).toHaveURL(/\/game$/);

  await expect.poll(() => eventsOf(h)).toContain("onrail_offer_missed");
  expect(h.reports.find((r) => r.event === "onrail_offer_missed")?.path).toBe("/game");
  // **이것이 계약의 핵심이다** — 제안 모달도, 노출 이벤트도 없다. 자격은 그대로 남아 있다.
  await expect(page.getByTestId("practice-tutorial-dialog")).toHaveCount(0);
  expect(eventsOf(h)).not.toContain("onrail_offer_shown");
  expect(eventsOf(h)).not.toContain("onrail_declined");
});

test("③-b 같은 우회를 반복해도 한 번만 센다 (유저 수를 세지 방문 수를 세지 않는다)", async ({ page }) => {
  const h = await mockApi(page);
  await seedNewUser(page);

  await page.goto("/deck");
  await navTab(page, "game").click();
  await expect.poll(() => eventsOf(h)).toContain("onrail_offer_missed");
  await navTab(page, "deck").click();
  await navTab(page, "game").click();
  await expect(page).toHaveURL(/\/game$/);
  await page.waitForTimeout(300);

  expect(h.reports.filter((r) => r.event === "onrail_offer_missed")).toHaveLength(1);
});

// ── ④ 계측이 죽어도 튜토리얼은 돈다 (반대 방향) ───────────────────────────

test("④ 보고가 500 이어도 제안·수락·스텝이 그대로 진행된다", async ({ page }) => {
  const h = await mockApi(page, { telemetryFails: true });
  await seedNewUser(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await expect(page.getByTestId("practice-tutorial-dialog")).toBeVisible();
  await page.getByTestId("practice-tutorial-accept").click();

  await expect(page).toHaveURL(/\/deck$/);
  await expect(page.getByTestId("onrail-overlay")).toBeVisible();
  await expect(page.getByTestId("onrail-bubble")).toBeVisible();

  expect(h.reports.length).toBeGreaterThan(0);
  expect(errors, "계측 실패가 화면으로 새면 안 된다").toEqual([]);
});
