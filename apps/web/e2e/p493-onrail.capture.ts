import { expect, test, type Page, type Request } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { skipSplash } from "./splash-mock";

/**
 * #493 W7-v3 실화면 캡처 — 증빙(계약 아님). 온레일 튜토리얼의 각 국면을 **폰 뷰포트**로 찍는다.
 *
 * 실행:
 *   cd apps/web && CI=1 WEB_E2E_PORT=5288 \
 *     npx playwright test --config=playwright.capture.config.ts e2e/p493-onrail.capture.ts
 *
 * ⚠️ 폰(390×844)으로 찍는다 — 온레일은 **딤이 화면을 막는** 오버레이라 좁은 화면에서 말풍선이
 * 대상이나 CTA 를 덮는지가 데스크탑에서는 드러나지 않는다.
 */
const OUT = new URL("../../../evidence/493/", import.meta.url).pathname;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const USER_ID = "u493cap";
const MATCH_ID = "m493cap";

const HALF_LOG = JSON.parse(
  readFileSync(new URL("./fixtures/p388-half1.json", import.meta.url).pathname, "utf8"),
) as unknown;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const P = (id: string, name: string, position: string, grade: string, ov: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(ov), active: true,
});
const PLAYERS = [
  P("GK1", "골리원", "GK", "GOLD", 70), P("DF1", "수비하나", "DF", "GOLD", 76),
  P("DF2", "수비둘", "DF", "SILVER", 68), P("DF3", "수비셋", "DF", "SILVER", 64),
  P("DF4", "수비넷", "DF", "BRONZE", 55), P("MF1", "미드하나", "MF", "DIA", 84),
  P("MF2", "미드둘", "MF", "GOLD", 74), P("MF3", "미드셋", "MF", "SILVER", 66),
  P("MF4", "미드넷", "MF", "SILVER", 61), P("FW1", "공격하나", "FW", "LEGEND", 90),
  P("FW2", "공격둘", "FW", "GOLD", 72), P("FW3", "공격셋", "FW", "SILVER", 69),
];
const TEN = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1"];

async function mockApi(page: Page) {
  const state = {
    deck: {
      formation: "4-4-2",
      slots: TEN.map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
      teamPrompt: null,
    },
  };
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const req: Request = route.request();
    const p = new URL(req.url()).pathname;
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
      if (req.method() === "PUT") {
        const b = req.postDataJSON();
        state.deck = { formation: b.formation, slots: b.slots, teamPrompt: b.teamPrompt ?? null };
      }
      return route.fulfill(json(state.deck));
    }
    if (p === "/api/matches" || p === `/api/matches/${MATCH_ID}`) {
      return route.fulfill(json({
        id: MATCH_ID, state: "FIRST_HALF", mode: "practice", tutorial: true, auto: false,
        opponent: { name: "봇 FC" }, createdAt: "2026-08-13T00:00:00Z",
        scoreH1Home: null, scoreH1Away: null, scoreHome: null, scoreAway: null, result: null,
      }));
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(p)) return route.fulfill(json(HALF_LOG));
    return route.fulfill(json({}));
  });
}

async function seed(page: Page) {
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_user");
    window.localStorage.setItem(`hmb.guide.pending.${uid}`, "1");
  }, USER_ID);
}

test("온레일 국면 캡처", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await mockApi(page);
  await seed(page);

  // S1 — 제안 모달
  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await expect(page.getByTestId("practice-tutorial-dialog")).toBeVisible();
  await page.screenshot({ path: `${OUT}W7v3-s1-offer-phone.png` });

  // S2 ① — AUTO 만 허용(나머지는 딤)
  await page.getByTestId("practice-tutorial-accept").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-auto");
  await page.screenshot({ path: `${OUT}W7v3-s2-auto-phone.png` });

  // S2 ② — 지정 선수
  await page.getByTestId("auto-fill").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-player");
  await page.screenshot({ path: `${OUT}W7v3-s2-player-phone.png` });

  // S2 ③ — 한마디(행동형: [다음]이 없다)
  //
  // ⚠️ 폰에서는 토큰 탭이 **선수 메뉴**를 먼저 연다(#455 A2). 그 메뉴는 자기 모달이라 온레일이
  // 비켜나고(`shieldFor` = hidden), [한마디 쓰기]를 고르면 그때 지시 칸이 열리며 온레일이
  // 그 자리에서 다시 잡는다. 데스크탑은 토큰 탭이 곧 선택이라 이 한 탭이 없다.
  await page.getByTestId("token-GK1").click();
  await page.getByTestId("pmenu-say").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-prompt");
  await page.screenshot({ path: `${OUT}W7v3-s2-prompt-phone.png` });

  // S2 ⑤ — 저장 후 [경기 시작] CTA
  const input = page.getByTestId("rail-prompt-input");
  await input.fill("오늘 너만 믿는다");
  await input.blur();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-save");
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "deck-done");
  await page.screenshot({ path: `${OUT}W7v3-s2-done-phone.png` });

  // S3 — 경기 화면 투어(재생 정지 + 스킵 잠금)
  await page.getByTestId("onrail-next").click();
  await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));
  await expect(page.getByTestId("onrail-bubble")).toHaveAttribute("data-step-id", "match-scoreboard");
  await page.screenshot({ path: `${OUT}W7v3-s3-tour-phone.png` });
});
