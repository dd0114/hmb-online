import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { openCandidatesTab, openTuneTab } from "./deck-tabs";

/**
 * #244 — 덱·게임 UI 개편 "프롬프트 1급" 계약 (E2E-TDD: 구현보다 먼저 작성됐다, 루트 CLAUDE §2-3).
 *
 * hero 확정 골격(2026-07-28):
 *   · **한 화면** = 배치(보드) + 프롬프트. 일반 축구게임이 [보드 + 세부조정] 이던 자리에
 *     세부조정 대신 **프롬프트**가 앉고, 세부조정은 그 옆(⚙ 버튼 → 그 자리에서 펼침)으로 밀린다.
 *   · **편집은 인라인, 선택은 시트**: 프롬프트·세부조정 = 화면에 그대로 / 보유 선수·상대 정보 = 바텀시트.
 *   · 시트에서 선수를 고르면 배치되고 **그 선수 프롬프트로 화면이 이어진다**.
 *
 * 개편 전 실측(이 스펙이 막는 회귀):
 *   덱 390 진입 시 프롬프트 입력 **0px**(접힌 독 안) · 선수 탭 후에도 세부조정 147px vs 프롬프트 69px
 *   · 브리핑 1874px 문서에 프롬프트 입력 0개(상대표 244px + 컨디션 209px 가 상단 점유).
 *
 * ⚠️ 라우트 매칭은 **오리진 앵커**(url.pathname) — 상대 글롭은 vite dev 소스 요청까지 삼켜 흰 화면이 된다.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
/**
 * **지원 하한을 계약이 직접 잰다** (3차 검증 BL-2). 390×844 하나만 맞춰 두면 갤럭시(360×740)에서
 * 전부 무너지는데 스펙은 green 이었다. 아래 목록이 곧 "우리가 보장하는 화면"이다 — 넓히려면
 * 값을 늘리고 레이아웃 예산(TacticsBoard/TeamSheetBar/PromptBlock 의 max-height 미디어쿼리)을
 * 같이 손봐야 한다.
 */
const PHONES = [
  { width: 360, height: 740, name: "360×740(갤럭시)" },
  { width: 390, height: 844, name: "390×844(iPhone)" },
  { width: 412, height: 915, name: "412×915(안드 대형)" },
];

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const P = (id: string, name: string, position: string, grade: string, ov: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(ov), personality: "CALM",
});

const PLAYERS = [
  P("GK1", "골리원", "GK", "GOLD", 70), P("GK2", "골리투", "GK", "SILVER", 62),
  P("DF1", "수비하나", "DF", "GOLD", 76), P("DF2", "수비둘", "DF", "SILVER", 68),
  P("DF3", "수비셋", "DF", "SILVER", 64), P("DF4", "수비넷", "DF", "BRONZE", 55),
  P("MF1", "미드하나", "MF", "DIA", 84), P("MF2", "미드둘", "MF", "GOLD", 74),
  P("MF3", "미드셋", "MF", "SILVER", 66), P("MF4", "미드넷", "MF", "SILVER", 61),
  P("FW1", "공격하나", "FW", "LEGEND", 90), P("FW2", "공격둘", "FW", "GOLD", 72),
  P("FW3", "공격셋", "FW", "SILVER", 69),
];

/** 선발 10명 — FW 한 자리를 비워 "빈 슬롯 → 시트 → 배치" 시나리오를 태운다. */
const TEN = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1"];
const deckSlots = [
  ...TEN.map((playerId, i) => ({
    playerId, role: "starter", slotIndex: i,
    promptText: playerId === "MF1" ? "공간 만들어라" : null,
  })),
  // 벤치 — 감독시간 교체(T2) 계약을 태우려면 넣을 선수가 있어야 한다.
  { playerId: "FW2", role: "bench", slotIndex: 0, promptText: null },
  { playerId: "GK2", role: "bench", slotIndex: 1, promptText: null },
];

const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);

const MATCH = {
  id: "m244",
  createdAt: "2026-07-28T00:00:00Z",
  state: "BRIEFING",
  conditions: Object.fromEntries(TEN.map((id, i) => [id, 0.3 + (i % 5) * 0.15])),
  opponent: {
    name: "역습 봇",
    analysisText: "빠른 역습과 측면 크로스를 즐긴다.",
    deck: [
      { name: "봇 에이스", position: "FW", grade: "LEGEND", hasPrompt: true },
      { name: "봇 미드", position: "MF", grade: "GOLD", hasPrompt: true },
      { name: "봇 수비", position: "DF", grade: "SILVER", hasPrompt: false },
    ],
  },
};

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** 감독시간 시계 — 남은 시간을 인자로 받아 스키마대로 만든다(만료 경로도 같은 함수로 태운다). */
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

async function mockApi(
  page: Page,
  slots: unknown[] = deckSlots,
  clock: unknown = halftimeClock(),
  puts?: Array<{ teamPrompt?: string | null }>,
) {
  // #253: 팀 문장은 덱에 저장된다 → 목도 그렇게 행동해야 계약이 진짜다(저장 → 재조회에 남는다).
  const state = { deck: { formation: "4-4-2", slots, teamPrompt: null as string | null } };
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })));
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    route.fulfill(json(Object.fromEntries(TEN.map((id, i) => [id, 0.3 + (i % 5) * 0.15])))));
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json({
    user: { id: "u1", nickname: "테스터", provider: "guest", tutorialDone: true },
    wallet: { points: 1000 }, records: { played: 0, wins: 0, draws: 0, losses: 0 },
  })));
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json({ match: null, locked: false, abandonable: false })));
  await page.route((url) => url.pathname === "/api/matches/m244", (route) => route.fulfill(json(MATCH)));
  await page.route((url) => /^\/api\/matches\/m244h\/halves\/[12]\/log$/.test(url.pathname), (route) =>
    route.fulfill(json(MATCH_LOG)));
  await page.route((url) => url.pathname === "/api/matches/m244h", (route) =>
    route.fulfill(json({
      ...MATCH,
      id: "m244h",
      state: "HALFTIME",
      scoreH1Home: 1, scoreH1Away: 0, scoreHome: 1, scoreAway: 0,
      /*
       * ⚠️ **실제 `MatchClock` 스키마**여야 한다(packages/shared/src/match-clock.ts).
       * 예전엔 `{serverNowMs, deadlineMs}` 같은 **없는 필드**를 넣어서 `phaseEndsAt` 이 비었고,
       * 그러면 카운트다운 문단(프로덕션엔 항상 있는 54px 짜리 줄)이 렌더되지 않아 화면이
       * 실제보다 짧아졌다 = 낡은 픽스처 거짓 green(2차 검증 BLOCKER-1).
       */
      clock,
    })));
  await page.route((url) => url.pathname === "/api/deck", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      puts?.push(body);
      state.deck = { formation: body.formation, slots: body.slots, teamPrompt: body.teamPrompt ?? null };
    }
    return route.fulfill(json(state.deck));
  });
}

async function openDeck(page: Page, slots?: unknown[], puts?: Array<{ teamPrompt?: string | null }>) {
  await mockApi(page, slots ?? deckSlots, halftimeClock(), puts);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
}

async function openBriefing(page: Page) {
  await mockApi(page);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/match/m244");
  await expect(page.getByTestId("briefing-panel")).toBeVisible();
}

/**
 * 요소가 **스크롤 없이 첫 화면에 실제로 보이는가** — 이 에픽의 핵심 지표.
 *
 * ⚠️ 좌표만 재면 안 된다(루트 CLAUDE §2-2 "좌표 추론 금지"). `top < innerHeight` 만 보면
 *   · 요소가 fold 를 **걸쳐** 대부분 잘려도 통과하고,
 *   · `position:fixed` 하단탭(AppNav 56px)에 **완전히 덮여도** 통과한다.
 * 실제로 빈 덱 화면에서 프롬프트가 하단탭에 통째로 삼켜졌는데 구 판정은 green 이었다(#244 검증 B-1/B-2).
 * 그래서 은퇴시킨 `deck-teamsheet.spec.ts` "R3a r2/m5" 가 쓰던 기법을 계승한다:
 * **`elementFromPoint` 로 그 지점의 실제 최상위 요소를 물어본다.**
 */
async function inFirstFold(page: Page, testId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) {
      return {
        found: false, top: 0, bottom: 0, fold: window.innerHeight, scrollY: window.scrollY,
        hitSelf: false, hitWhat: null as string | null,
        blocked: [] as Array<{ at: string; by: string | null }>, margin: 0,
      };
    }
    const r = el.getBoundingClientRect();
    /*
     * ⚠️ **중심 1점만 보면 안 된다**(2차 검증 BLOCKER-3): 입력창 위쪽 절반만 보이고 아래 38px 과
     * 카운터·액션 버튼이 하단탭에 잘려도 중심은 멀쩡해서 green 이 나왔다. 아래쪽 세 점
     * (좌·중·우)까지 물어봐야 "부분 가림"이 잡힌다.
     */
    const probes: Array<{ name: string; x: number; y: number }> = [
      { name: "center", x: r.left + r.width / 2, y: r.top + r.height / 2 },
      { name: "bottomL", x: r.left + 8, y: r.bottom - 4 },
      { name: "bottomC", x: r.left + r.width / 2, y: r.bottom - 4 },
      { name: "bottomR", x: r.right - 8, y: r.bottom - 4 },
    ];
    const blocked: Array<{ at: string; by: string | null }> = [];
    for (const pt of probes) {
      if (pt.y < 0 || pt.y > window.innerHeight - 1) {
        blocked.push({ at: pt.name, by: "OUT_OF_FOLD" });
        continue;
      }
      const hit = document.elementFromPoint(pt.x, pt.y);
      if (!hit || !el.contains(hit)) {
        blocked.push({
          at: pt.name,
          by: hit ? (hit.closest("[data-testid]")?.getAttribute("data-testid") ?? hit.tagName) : null,
        });
      }
    }
    return {
      found: true, top: Math.round(r.top), bottom: Math.round(r.bottom),
      fold: window.innerHeight, scrollY: window.scrollY,
      hitSelf: blocked.length === 0,
      hitWhat: blocked.length ? `${blocked[0]!.at}←${blocked[0]!.by}` : null,
      blocked,
      /** fold 까지 남은 여유 — 0 에 붙어 있으면 다음 한 줄에 다시 깨진다. */
      margin: Math.round(window.innerHeight - r.bottom),
    };
  }, testId);
}

/**
 * 프롬프트가 "그 화면에 온전히 보인다"의 **완전한** 판정 — 좌표 + 잘림 + (부분)가림 + **안전여유**.
 *
 * `MIN_MARGIN` 을 두는 이유: 2차 검증 실측에서 여유가 0~18px 뿐이라 어떤 수정도 다음 한 줄에
 * 다시 깨지는 상태였다(360×740·브라우저 확대에서 전부 무너짐). 여유 자체를 계약으로 박는다.
 */
const MIN_MARGIN = 24;
function expectPromptVisible(
  box: Awaited<ReturnType<typeof inFirstFold>>,
  label: string,
  opts: { requireNoScroll?: boolean } = {},
) {
  const { requireNoScroll = true } = opts;
  expect(box.found, `${label}: 프롬프트 입력이 DOM 에 없다`).toBe(true);
  if (requireNoScroll) expect(box.scrollY, `${label}: 스크롤 없이 판정한다`).toBe(0);
  expect(box.top, `${label}: 프롬프트가 화면 위로 벗어났다`).toBeGreaterThanOrEqual(0);
  expect(box.bottom, `${label}: 프롬프트가 화면 아래로 잘렸다`).toBeLessThanOrEqual(box.fold);
  expect(
    box.hitSelf,
    `${label}: 프롬프트가 가려 실제로는 안 보인다(${box.hitWhat}) — 가린 지점 ${JSON.stringify(box.blocked)}`,
  ).toBe(true);
  expect(
    box.margin,
    `${label}: 화면 아래 여유가 ${box.margin}px 뿐이다(최소 ${MIN_MARGIN}px) — 다음 수정에 바로 깨진다`,
  ).toBeGreaterThanOrEqual(MIN_MARGIN);
}
/** 진입 화면(스크롤 0) 전용 별칭 — 읽는 사람이 조건을 헷갈리지 않게. */
const expectPromptOnFirstScreen = expectPromptVisible;

function hOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.beforeAll(() => mkdirSync(SMOKE_DIR, { recursive: true }));

test.describe("#244 프롬프트 1급 — 덱 편성", () => {
  test.use({ viewport: PHONE });

  test("AC1 진입 즉시 팀 프롬프트 입력이 첫 화면 안에 보인다 (스크롤 0)", async ({ page }) => {
    await openDeck(page);
    const box = await inFirstFold(page, "editor-team-prompt");
    console.log("[p244] team prompt", JSON.stringify(box));
    expectPromptOnFirstScreen(box, "덱(선발 10/11)");
    await expect(page.getByTestId("editor-team-prompt")).toBeVisible();
    await page.screenshot({ path: `${SMOKE_DIR}p244-deck-390.png`, fullPage: true });
  });

  /**
   * ⚠️ **빈 덱(선발 0/11) = 신규 유저의 첫 화면**이다. 이 상태에서 보드 하단 바에 버튼이 하나 더
   * 붙으면서(Auto CTA) 힌트가 접혀 카드가 부풀었고, 프롬프트가 하단탭 아래로 삼켜졌다(검증 B-1).
   * 픽스처가 늘 "선발 10명"이면 이 경로를 영영 못 밟는다 → 빈 덱을 따로 태운다.
   */
  test("AC1-b 빈 덱(0/11)에서도 팀 프롬프트가 첫 화면에 **가림 없이** 보인다", async ({ page }) => {
    await openDeck(page, []);
    await expect(page.getByTestId("starter-count")).toHaveText("선발 0/11");
    const box = await inFirstFold(page, "editor-team-prompt");
    console.log("[p244] empty-deck team prompt", JSON.stringify(box));
    expectPromptOnFirstScreen(box, "덱(빈 덱 0/11)");
    await page.screenshot({ path: `${SMOKE_DIR}p244-deck-empty-390.png`, fullPage: true });
  });

  /**
   * ⚠️ #455 A1 로 **접힘의 모양이 바뀌었다**(뜻은 더 강해졌다).
   * 폰 덱셋팅은 이제 경기장 아래가 책갈피 탭이고, 팀 세부 전술은 3순위 탭 `[⚙ 세부 전술]` 이다 —
   * 즉 접힘 장치가 ⚙ 토글에서 **탭 그 자체**로 바뀌었다(`team-tune-toggle` 은 이 화면에 없다).
   * 두 겹으로 두지 않은 이유: 탭 안에 다시 토글을 두면 유저가 같은 것을 두 번 펴야 한다.
   * 이 스펙이 재는 것(= "프롬프트가 1급, 세부조정은 뒤")은 그대로이고 오히려 더 뒤에 있다 —
   * 첫 화면에서 다이얼이 **DOM 에 그려져 있지도 않다**(구 동작은 hidden 으로 존재했다).
   * ⚠️ 경기전·감독시간은 `layout="stack"` 이라 ⚙ 토글이 살아 있다(`briefing-teamsheet` 가 잰다).
   */
  test("AC2 세부조정은 기본 접힘 — [⚙ 세부 전술] 탭을 열어야 전술 다이얼이 나온다", async ({ page }) => {
    await openDeck(page);
    await expect(page.getByTestId("team-tactics-panel")).toBeHidden();
    await expect(page.getByTestId("team-tune-toggle"), "탭이 접힘이므로 토글은 없다").toHaveCount(0);
    // 첫 화면의 기본 탭은 [📣 전체 지시] — 프롬프트가 먼저다.
    await expect(page.getByTestId("deck-tab-team")).toHaveAttribute("aria-selected", "true");

    await openTuneTab(page);
    await expect(page.getByTestId("team-tactics-panel")).toBeVisible();

    // 다시 [📣 전체 지시] 로 넘기면 다이얼은 도로 화면 밖이다(접힘이 왕복한다).
    await page.getByTestId("deck-tab-team").click();
    await expect(page.getByTestId("team-tactics-panel")).toBeHidden();
  });

  test("AC3 보유 선수는 본문이 아니라 시트 — 빈 슬롯을 누르면 그 포지션으로 열린다", async ({ page }) => {
    await openDeck(page);
    await expect(page.getByTestId("player-pool")).toBeHidden();
    // 선발 10명 → 슬롯 10(11번째)이 비어 있다.
    await page.getByTestId("board-slot-starter-10").click();
    await expect(page.getByTestId("pool-sheet")).toBeVisible();
    await expect(page.getByTestId("player-pool")).toBeVisible();
    // 자리 포지션(4-4-2 의 11번 슬롯 = FW)으로 자동 필터.
    await expect(page.getByTestId("picker-filter-FW")).toHaveAttribute("aria-selected", "true");
  });

  test("AC4 시트에서 고르면 배치되고 **그 선수 프롬프트**로 이어진다", async ({ page }) => {
    await openDeck(page);
    await page.getByTestId("board-slot-starter-10").click();
    await page.getByTestId("pick-FW3").click();
    // 시트가 닫히고
    await expect(page.getByTestId("pool-sheet")).toBeHidden();
    // 보드에 들어가고
    await expect(page.getByTestId("board-slot-starter-10").getByTestId("token-FW3")).toBeVisible();
    // 지시 영역이 그 선수로 바뀐다
    await expect(page.getByTestId("rail-title")).toHaveText("공격셋");
    // A′: 선수를 고르면 화면이 그 입력창까지 따라온다 → **스크롤이 끝난 뒤** 가림·잘림을 잰다
    // (자동 스크롤이 가림을 숨기지 못하게, 판정식은 동일하게 하단 3점 히트테스트를 쓴다).
    await page.waitForTimeout(600);
    const box = await inFirstFold(page, "rail-prompt-input");
    console.log("[p244] player prompt", JSON.stringify(box));
    expectPromptVisible(box, "덱(선수 프롬프트)", { requireNoScroll: false });
    await expect(page.getByTestId("rail-prompt-input")).toBeVisible();
  });

  /**
   * 자리 맥락이 없는 시트([보유 선수])에서 **이미 배치된** 선수를 고르면, 예전 구현은 그 선수를
   * "첫 빈 자리"로 옮겨 **라인업을 조용히 흐트러뜨렸다**(DF 가 FW 자리로 가고 원래 자리는 공석,
   * 되돌리기 없음 — 독립 검증 M-1). 자리를 바꾸는 건 그 자리에서 열었을 때만이다.
   */
  test("AC4-b 자리 미지정 시트에서 배치된 선수를 고르면 **자리는 그대로**, 지시 대상만 바뀐다", async ({ page }) => {
    await openDeck(page);
    const before = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="board-slot-starter-"]')].map((s) => ({
        slot: s.getAttribute("data-testid"),
        player: s.querySelector('[data-testid^="token-"]')?.getAttribute("data-testid") ?? null,
      })));
    await openCandidatesTab(page); // #455 A1: 폰에서 여는 버튼은 [👥 후보] 탭 안
    await page.getByTestId("pool-sheet-open").click();
    await page.getByTestId("pick-DF1").click();
    await expect(page.getByTestId("pool-sheet")).toBeHidden();
    const after = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="board-slot-starter-"]')].map((s) => ({
        slot: s.getAttribute("data-testid"),
        player: s.querySelector('[data-testid^="token-"]')?.getAttribute("data-testid") ?? null,
      })));
    expect(after, "배치된 선수를 골랐다고 라인업이 움직이면 안 된다").toEqual(before);
    await expect(page.getByTestId("rail-title")).toHaveText("수비하나"); // 지시 대상만 바뀐다
  });

  test("AC5 선수 세부조정(역할·지시 칩)도 기본 접힘", async ({ page }) => {
    await openDeck(page);
    await page.getByTestId("token-MF1").click();
    await expect(page.getByTestId("rail-prompt-input")).toBeVisible();
    await expect(page.getByTestId("rail-tactical-layer")).toBeHidden();
    await page.getByTestId("rail-tune-toggle").click();
    await expect(page.getByTestId("rail-tactical-layer")).toBeVisible();
    await expect(page.getByTestId("rail-role")).toBeVisible();
  });

  /**
   * 시트가 새 **1급 배치 경로**다 — 그 안의 컨트롤이 44px 탭 타깃(#73 P1)을 지켜야 한다.
   * 시트는 flex 컬럼이라 리스트가 길어지면 위 형제가 수축한다: 실제로 보유 22명에서 필터 줄이
   * **23px 로 반토막** 났다(검증 B-3). 목록 길이에 따라 달라지므로 **긴 목록**으로 잰다.
   */
  test("AC3-b 시트 필터는 목록이 길어져도 44px 탭 타깃을 지킨다", async ({ page }) => {
    const many = Array.from({ length: 22 }, (_, i) =>
      P(`X${i}`, `여분${i}`, ["GK", "DF", "MF", "FW"][i % 4]!, "SILVER", 50 + i));
    await mockApi(page, deckSlots);
    await page.route((url) => url.pathname === "/api/players", (route) =>
      route.fulfill(json([...PLAYERS, ...many])));
    await page.addInitScript(() => {
      localStorage.setItem("hmb.auth.token", "mock-token");
      localStorage.setItem("hmb.auth.provider", "guest");
    });
    await page.goto("/deck");
    await expect(page.getByTestId("deck-editor")).toBeVisible();
    await openCandidatesTab(page); // #455 A1
    await page.getByTestId("pool-sheet-open").click();
    await expect(page.getByTestId("pool-sheet")).toBeVisible();

    const m = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="player-pool"] [role="tablist"]')!;
      const tab = list.querySelector('[role="tab"]')!;
      return {
        tablistH: Math.round(list.getBoundingClientRect().height),
        tabH: Math.round(tab.getBoundingClientRect().height),
      };
    });
    console.log("[p244] sheet filter", JSON.stringify(m));
    expect(m.tabH, "시트 필터 칩이 44px 탭 타깃 아래로 눌렸다").toBeGreaterThanOrEqual(44);
    expect(m.tablistH, "필터 줄이 리스트에 밀려 잘렸다").toBeGreaterThanOrEqual(44);
  });

  /**
   * #253 이 머지되며 팀 문장은 **덱에 저장된다**(decks.team_prompt / V23). 임시 localStorage 프리필은
   * 걷어냈다 — 이 계약은 이제 "서버 값이 화면과 저장 요청에 그대로 흐르는가"를 잰다.
   */
  test("AC12 팀 문장이 덱에 저장되고 브리핑이 그 값을 이어받는다 (#253)", async ({ page }) => {
    const puts: Array<{ teamPrompt?: string | null }> = [];
    // [저장]은 선발 11 일 때만 열린다 → 이 계약은 꽉 찬 덱으로 태운다.
    const fullDeck = [
      ...[...TEN, "FW3"].map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
      { playerId: "FW2", role: "bench", slotIndex: 0, promptText: null },
    ];
    await openDeck(page, fullDeck, puts);
    await page.getByTestId("editor-team-prompt").fill("초반부터 강하게 압박");
    await page.getByTestId("save-deck").click();
    await expect(page.getByTestId("deck-saved-note")).toBeVisible();
    expect(puts.at(-1)?.teamPrompt, "PUT 바디에 팀 문장이 실려야 한다").toBe("초반부터 강하게 압박");

    // 서버가 그 값을 돌려주면 화면·브리핑이 그대로 이어받는다(빈칸으로 시작하면 저장이 지워진다).
    await page.goto("/match/m244");
    await expect(page.getByTestId("briefing-panel")).toBeVisible();
    await expect(page.getByTestId("editor-team-prompt")).toHaveValue("초반부터 강하게 압박");
  });

  test("AC7 가로 오버플로 0 (390 / 1280)", async ({ page }) => {
    await openDeck(page);
    expect(await hOverflow(page), "390 가로 오버플로").toBe(0);
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(200);
    expect(await hOverflow(page), "1280 가로 오버플로").toBe(0);
    await page.screenshot({ path: `${SMOKE_DIR}p244-deck-1280.png` });
  });
});

test.describe("#244 지원 뷰포트 스윕 — 프롬프트는 어디서나 첫 화면에 있다", () => {
  for (const vp of PHONES) {
    test(`AC13 ${vp.name}: 덱·브리핑 팀 프롬프트가 가림 없이 첫 화면 (여유 ≥${MIN_MARGIN}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openDeck(page);
      const deckBox = await inFirstFold(page, "editor-team-prompt");
      console.log(`[p244] ${vp.name} deck`, JSON.stringify(deckBox));
      expectPromptVisible(deckBox, `덱 ${vp.name}`);

      await page.goto("/match/m244");
      await expect(page.getByTestId("briefing-panel")).toBeVisible();
      // 에디터는 덱 로드 후에 마운트된다 — 입력이 뜬 뒤에 재야 한다(안 그러면 found:false 레이스).
      await expect(page.getByTestId("editor-team-prompt")).toBeVisible();
      const briefBox = await inFirstFold(page, "editor-team-prompt");
      console.log(`[p244] ${vp.name} briefing`, JSON.stringify(briefBox));
      expectPromptVisible(briefBox, `브리핑 ${vp.name}`);
      await page.screenshot({ path: `${SMOKE_DIR}p244-sweep-${vp.width}x${vp.height}.png`, fullPage: true });
    });
  }
});

test.describe("#244 프롬프트 1급 — 브리핑", () => {
  test.use({ viewport: PHONE });

  test("AC6 상대 정보는 시트 뒤로 가고, 프롬프트가 첫 화면 안에 있다", async ({ page }) => {
    await openBriefing(page);
    // 상대 분석 표는 본문에서 내려가고 요약 줄 + 진입 버튼만 남는다
    await expect(page.getByTestId("opponent-analysis")).toBeHidden();
    await expect(page.getByTestId("opp-sheet-open")).toBeVisible();
    const box = await inFirstFold(page, "editor-team-prompt");
    console.log("[p244] briefing prompt", JSON.stringify(box));
    expectPromptOnFirstScreen(box, "브리핑");
    // 시트를 열면 상대 라인업이 나온다
    await page.getByTestId("opp-sheet-open").click();
    await expect(page.getByTestId("opponent-analysis")).toBeVisible();
    await page.screenshot({ path: `${SMOKE_DIR}p244-briefing-sheet.png` });
  });
});

test.describe("#244 T2 — 감독시간(하프타임)", () => {
  test.use({ viewport: PHONE });

  async function openHalftime(page: Page, clock = halftimeClock()) {
    await mockApi(page, deckSlots, clock);
    await page.addInitScript(() => {
      localStorage.setItem("hmb.auth.token", "mock-token");
      localStorage.setItem("hmb.auth.provider", "guest");
    });
    await page.goto("/match/m244h");
    await expect(page.getByTestId("halftime-panel")).toBeVisible({ timeout: 30_000 });
  }

  /**
   * hero 확정: *"덱에서 셋팅하던 것과 전후반 사이 차이점은 새로운 선수 배치가 안 된다는 것뿐"*.
   * 그래서 감독시간은 **덱과 같은 컴포넌트**를 쓰고, 차이는 배치 잠금 + 교체뿐이어야 한다.
   *
   * ⚠️ **#276 으로 "배치가 잠긴다"의 범위가 좁아졌다**: 감독시간에도 포메이션·선발 자리 바꾸기는
   * 열린다(hero 결정). 잠기는 것은 **경기 스쿼드 밖에서 선수를 데려오는 것**뿐이고, 이 스펙이
   * 재는 것도 정확히 그것이다(보유 선수 시트·Auto·초기화·빈 자리 탭). 여기 `MATCH` 픽스처엔
   * `userDeckSnapshot` 이 없어 **폴백 경로**(덱 파생 + 교체만)로 도는 것도 계약이다 —
   * 배치가 열린 경로는 `p276-halftime-shape.spec.ts` 가 잰다.
   */
  test("AC8 덱과 **같은 형식** — 배치만 잠기고 교체가 더해진다", async ({ page }) => {
    await openHalftime(page);
    // 같은 에디터 · 같은 프롬프트 블록
    await expect(page.getByTestId("deck-editor")).toBeVisible();
    await expect(page.getByTestId("editor-team-prompt")).toBeVisible();
    await expect(page.getByTestId("halftime-countdown")).toBeVisible();
    // 배치 계열은 없다(새 선수를 넣는 화면이 아니다)
    for (const id of ["pool-sheet-open", "auto-fill", "board-reset", "board-empty-auto"]) {
      await expect(page.getByTestId(id), `${id} 는 감독시간에 없어야 한다`).toHaveCount(0);
    }
    // 빈 자리(선발 11번)를 눌러도 시트가 열리지 않는다 — 새 선수를 넣는 화면이 아니다
    await page.getByTestId("board-slot-starter-10").click();
    await expect(page.getByTestId("pool-sheet")).toHaveCount(0);
    // 벤치 줄은 한마디 모드에서 접혀 있다(넣을 선수를 고를 일이 없다)
    await expect(page.getByTestId("board-bench-section")).toHaveCount(0);
    // #254 가 머지되며 후반 전술 변경이 **허용**됐다 → 덱과 같은 자리(⚙)에 그대로 있다.
    await expect(page.getByTestId("team-tune-toggle")).toBeVisible();
    // 교체는 덱에 없는 추가분
    await expect(page.getByTestId("halftime-mode-sub")).toBeVisible();
  });

  test("AC9 교체: 보드에서 뺄 선수 → 벤치에서 넣을 선수 → OUT 뱃지 + 칩", async ({ page }) => {
    await openHalftime(page);
    await page.getByTestId("halftime-mode-sub").click();
    await expect(page.getByTestId("halftime-swap-guide")).toBeVisible();

    await page.getByTestId("token-MF1").click();
    await expect(page.getByTestId("halftime-swap-guide")).toContainText("미드하나");
    await page.getByTestId("token-FW2").click(); // 벤치
    await expect(page.getByTestId("sub-chip-0")).toContainText("미드하나");
    await expect(page.getByTestId("sub-chip-0")).toContainText("공격둘");
    // 보드가 교체를 말한다(칩만이 아니라) — 60초 안에 "누굴 뺐더라"를 보드에서 읽어야 한다
    await expect(page.getByTestId("token-out-MF1")).toBeVisible();

    // ⚠️ 등록되면 칩 줄이 한 줄 생겨 프롬프트가 다시 밀린다 — **등록 후에도** 보여야 한다
    //    (실화면에서 잡힌 구멍: 모드 전환 직후만 재면 이 상태를 못 본다).
    await page.waitForTimeout(600);
    const after = await inFirstFold(page, "editor-team-prompt");
    console.log("[p244] halftime after-sub", JSON.stringify(after));
    expectPromptVisible(after, "감독시간(교체 등록 후)", { requireNoScroll: false });
  });

  test("AC10 교체 중에도 프롬프트가 화면에 남는다 (T1/T3 을 기각한 근거)", async ({ page }) => {
    await openHalftime(page);
    await expect(page.getByTestId("editor-team-prompt")).toBeVisible();
    const say = await inFirstFold(page, "editor-team-prompt");
    console.log("[p244] halftime say", JSON.stringify(say));
    expectPromptVisible(say, "감독시간(한마디)");

    // 교체 모드는 벤치 줄이 펴지므로 덱과 **같은 규칙**(A′)으로 화면이 프롬프트까지 따라온다 →
    // 스크롤이 끝난 뒤에 가림·잘림을 잰다(판정식은 동일한 하단 3점 히트테스트).
    await page.getByTestId("halftime-mode-sub").click();
    await page.waitForTimeout(600);
    const sub = await inFirstFold(page, "editor-team-prompt");
    console.log("[p244] halftime sub", JSON.stringify(sub));
    expectPromptVisible(sub, "감독시간(교체 모드)", { requireNoScroll: false });
  });

  test("AC11 감독시간이 끝나면 입력·교체까지 닫힌다", async ({ page }) => {
    await openHalftime(page, halftimeClock(-1_000)); // 이미 만료
    await expect(page.getByTestId("halftime-countdown")).toContainText("감독시간 종료");
    await expect(page.getByTestId("resume-button")).toBeDisabled();
    await expect(page.getByTestId("editor-team-prompt")).toBeDisabled();
    await expect(page.getByTestId("halftime-mode-sub")).toBeDisabled();
  });
  /**
   * hero 지시: *"1 아래에 타임라인이랑 돌려볼 수 있게 하자. 시간바도 줘서 필요한 장면 볼 수 있게"*.
   * 감독시간 경기장면 **탭**은 관전 무대와 달리 "돌려보는 화면"이므로 재생 컨트롤을 전부 편다.
   *
   * 여기서 박제하는 건 두 가지다:
   *   ① 되돌릴 수 있다 — 시간바(스크럽)·핀 타임라인을 만지면 **경기 시계가 실제로 바뀐다**
   *   ② 컨트롤이 피치를 **덮지 않는다** — 무대에선 모서리에 겹치는 오버레이라(리서치 R6)
   *      그대로 두면 좁은 폰에서 피치를 가린다. 실화면 캡처에서 실제로 그랬다.
   * (경기 종료 후 결과 화면·기록 다시보기에도 같은 도구가 필요하다 — 그건 **별도 이슈**다.)
   */
  test("AC15 경기장면 탭 — 시간바·타임라인으로 장면을 되돌린다 (피치를 가리지 않는다)", async ({ page }) => {
    await openHalftime(page);
    await page.getByTestId("stage-tab-stage").click();

    const canvas = page.locator('[data-testid^="viewer-canvas-half"]');
    const controls = page.getByTestId("viewer-controls-half1");
    const scrub = page.getByTestId("viewer-scrub-half1");
    const clock = page.getByTestId("viewer-clock-half1");
    await expect(canvas).toBeVisible();
    await expect(controls).toBeVisible();
    await expect(scrub).toBeVisible();

    // ② 겹침 0 — 컨트롤 상단이 캔버스 하단보다 아래에 있다(오버레이면 이 값이 음수로 뒤집힌다)
    const cb = (await canvas.boundingBox())!;
    const tb = (await controls.boundingBox())!;
    console.log("[p244] stage-tab geom", JSON.stringify({ canvas: cb, controls: tb }));
    expect(tb.y, "컨트롤이 피치 위에 겹쳐 있다").toBeGreaterThanOrEqual(cb.y + cb.height - 1);
    /*
     * ⚠️ 좌표만 재면 **오버레이가 되살아나도 통과할 수 있다**(독립 검증 BL-3: 다른 규칙이 우연히
     * 같은 좌표를 만들어 냈다). 그래서 "무대 모서리 겹침 스킨"이 실제로 꺼져 있는지를 직접 잰다 —
     * 돌려보는 화면의 컨트롤은 **흐름(static)** 이어야 한다.
     */
    const overlayOff = await controls.evaluate((el) => {
      const wrap = el.parentElement!;
      const cs = getComputedStyle(wrap);
      return { position: cs.position, host: getComputedStyle(el).position };
    });
    console.log("[p244] controls flow", JSON.stringify(overlayOff));
    expect(overlayOff.position, "컨트롤 래퍼가 무대 위 오버레이로 되돌아갔다").toBe("static");
    expect(await hOverflow(page), "컨트롤 줄이 폰 폭 밖으로 나간다").toBe(0);
    // 시간바는 화면 안에 있어야 만질 수 있다
    const sb = (await scrub.boundingBox())!;
    const fold = page.viewportSize()!.height;
    expect(sb.y + sb.height, "시간바가 첫 화면 밖").toBeLessThanOrEqual(fold);

    /*
     * ③ **유저용 트랜스포트**(#244 재설계) — 이 화면의 컨트롤은 4개다: 이전 장면 · 재생 · 다음 장면 · 배속.
     * QA 도구(배속 6단·프레임 스텝·mm:ss)는 그대로 있되 **접혀 있어야** 한다. 그전에는 21개가
     * 펼쳐진 채 유저에게 노출됐다(재설계 진단).
     */
    for (const id of ["viewer-prev-scene-half1", "viewer-play-toggle-half1", "viewer-next-scene-half1", "viewer-speed-cycle-half1"]) {
      await expect(page.getByTestId(id), `${id} 가 없다`).toBeVisible();
    }
    const advanced = page.getByTestId("viewer-advanced-half1");
    await expect(advanced).toHaveCount(1);
    expect(await advanced.evaluate((el) => (el as HTMLDetailsElement).open), "고급 컨트롤이 펼쳐진 채다").toBe(false);
    await expect(page.getByTestId("viewer-goto-half1"), "mm:ss 입력이 접히지 않았다").toBeHidden();

    // ① 시간바로 되돌린다
    const before = (await clock.textContent())?.trim();
    await scrub.focus();
    for (let i = 0; i < 12; i += 1) await scrub.press("ArrowRight");
    await expect.poll(async () => (await clock.textContent())?.trim(), { timeout: 5_000 }).not.toBe(before);

    // ① 핀(골·슛)을 눌러 그 장면으로 점프한다
    const moved = (await clock.textContent())?.trim();
    await page.locator('[data-testid^="viewer-pin-"]').last().click();
    await expect.poll(async () => (await clock.textContent())?.trim(), { timeout: 5_000 }).not.toBe(moved);
    // ④ 장면 리스트 — "12'34\" 골" 처럼 **이름으로** 골라 그 장면으로 간다
    const scenes = page.getByTestId("viewer-scenes-half1").locator('[data-testid^="viewer-scene-"]');
    expect(await scenes.count(), "장면 리스트가 비어 있다").toBeGreaterThan(0);
    const jumped = (await clock.textContent())?.trim();
    /*
     * **첫** 장면을 누른다 — 앞 단계에서 시간바를 끝으로 끌어 놨으므로 마지막 장면을 누르면
     * 이미 그 자리라 시계가 안 바뀐다(재생이 멈춘 채 열리도록 바꾼 뒤 드러난 구멍).
     */
    await scenes.first().click();
    await expect.poll(async () => (await clock.textContent())?.trim(), { timeout: 5_000 }).not.toBe(jumped);
    await page.screenshot({ path: `${SMOKE_DIR}p244-halftime-stagetab.png` });

    // 탭을 되돌리면 감독 화면(프롬프트 1급)은 그대로다 — 통일성
    await page.getByTestId("stage-tab-halftime").click();
    await expect(page.getByTestId("editor-team-prompt")).toBeVisible();
  });
});
