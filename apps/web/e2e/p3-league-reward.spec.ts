import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mockAppConfig } from "./app-config-mock";

/**
 * W-E 시즌 종료 보상 연출 route-mock (PRD-v4 §E / AC-E1) — **백엔드 없이** vite dev + page.route 로
 * /api/league 를 FINISHED + seasonReward 3가지 status 로 목킹해 화면을 검증한다.
 * (라이브 스택 왕복 = league-season.spec.ts 소관, 여기서 건드리지 않는다.)
 *
 * ⚠️ 라우트 매칭은 **pathname 앵커**로 한다 — glob '**\/api/**' 는 vite 소스 /src/api/*.ts 까지
 * 잡아 모듈 로딩을 깨고 흰 화면이 된다(프로젝트 기지식).
 *
 * 멱등성(AC-E1): 이 스펙은 화면에서 나가는 요청을 전부 기록해 **비-GET 이 0건**임을 단언한다 —
 * 클라가 지급 트리거를 보내지 않음을 계약으로 박제.
 *
 * ⚠️ **status 는 서버가 보내는 값으로 목킹한다**(`GRANTED|PENDING|NONE`, openapi SoT). 이 스펙이
 * 서버가 보내지 않는 `AWARDED` 를 쓰고 있어서, 클라가 `GRANTED` 를 모르는 상태(종료 시즌 전부
 * "지급되지 않았습니다")를 **e2e 가 green 으로 덮고 있었다**(#251). 목이 서버 형상을 지켜야
 * 스펙이 실제 화면을 본다 — 새 status 를 추가할 땐 openapi 를 보고 목부터 맞춰라.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

type Reward = {
  rank: number;
  points: number;
  /** 시즌 종료 젬(#251: 완주 전원 — 1등 9,000 / 2등 6,000 / 3등 4,000 / 4등 이하 3,000). */
  gems?: number;
  status: string;
  awardedAt?: string;
  message?: string;
};

function standings() {
  // 유저는 rank 3 — 봇 9팀은 3을 제외한 1..10 을 가진다(순위 유일).
  const botRanks = [1, 2, 4, 5, 6, 7, 8, 9, 10];
  const bots = botRanks.map((rank, i) => ({
    teamId: `bot${i + 1}`,
    name: `봇 FC ${i + 1}`,
    played: 18,
    won: 12 - i,
    drawn: 3,
    lost: 3 + i,
    goalsFor: 40 - i * 2,
    goalsAgainst: 20 + i,
    goalDiff: 20 - i * 3,
    points: 39 - i * 3,
    rank,
    isUser: false,
  }));
  const me = {
    teamId: "me",
    name: "내 팀",
    played: 18,
    won: 10,
    drawn: 4,
    lost: 4,
    goalsFor: 31,
    goalsAgainst: 22,
    goalDiff: 9,
    points: 34,
    rank: 3,
    isUser: true,
  };
  return [...bots, me];
}

function leagueResponse(reward: Reward | null) {
  const season: Record<string, unknown> = {
    id: "S1",
    seasonNo: 1,
    state: "FINISHED",
    teams: [
      { teamId: "me", name: "내 팀", isUser: true, persona: null, power: null },
      ...Array.from({ length: 9 }, (_, i) => ({
        teamId: `bot${i + 1}`,
        name: `봇 FC ${i + 1}`,
        isUser: false,
        persona: "공격",
        power: 900,
      })),
    ],
    standings: standings(),
    fixtures: [
      {
        id: "f1",
        round: 1,
        homeTeam: "me",
        awayTeam: "bot1",
        isUser: true,
        state: "PLAYED",
        scoreHome: 2,
        scoreAway: 1,
        matchId: "m1",
      },
    ],
    nextUserFixture: null,
  };
  if (reward) season.seasonReward = reward;
  return { season };
}

/** 페이지가 실제로 보낸 /api 요청 method 로그(멱등성 단언용). */
async function mockLeague(page: Page, reward: Reward | null) {
  const methods: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      methods.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill(json({}));
    },
  );
  // 나중에 등록한 핸들러가 우선 — 구체 라우트를 catch-all 뒤에.
  await page.route(
    (url) => url.pathname === "/api/league",
    (route) => {
      methods.push(`${route.request().method()} /api/league`);
      return route.fulfill(json(leagueResponse(reward)));
    },
  );
  // 재화 표기(#232)는 서버가 준다 — 캐치올 `{}` 로 두면 화면이 코드 폴백("GEM 9000")을 그려
  // Z 병기 계약을 검사할 수 없다.
  await mockAppConfig(page);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  return methods;
}

async function horizontalOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe("W-E 시즌 종료 보상 연출 (route-mock)", () => {
  test("GRANTED(서버 enum) — 순위·G·Z 병기 + 시즌 요약 표시 + 지급 트리거 요청 0", async ({ page }) => {
    mkdirSync(SMOKE_DIR, { recursive: true });
    const methods = await mockLeague(page, {
      rank: 3,
      points: 500,
      gems: 4000, // 3등 = 완주 3,000 + 순위 보너스 1,000 (#251)
      status: "GRANTED",
      awardedAt: "2026-07-20T09:00:00Z",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/league");

    await expect(page.getByTestId("season-end")).toBeVisible();
    await expect(page.getByTestId("final-rank")).toContainText("3위");

    const card = page.getByTestId("season-reward");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-status", "GRANTED");
    await expect(page.getByTestId("season-reward-status")).toContainText("지급 완료");

    // 카운트업이 끝나면 최종 포인트가 보인다(연출은 값 정확성을 해치지 않는다).
    const points = page.getByTestId("season-reward-points");
    await expect(points).toHaveAttribute("data-awarded", "true");
    await expect(points).toContainText("500");

    // #251 Z 병기: 젬 줄이 보이고, 표기(심볼)는 서버 config 를 따른다(#232 — 하드코딩 금지).
    const gemLine = page.getByTestId("season-reward-gems");
    await expect(gemLine).toBeVisible();
    await expect(gemLine).toHaveAttribute("data-gems", "4000");
    await expect(gemLine).toContainText("4,000");
    await expect(gemLine).toContainText("Z");
    // 문장에서도 G·Z 를 함께 읽어 준다(숫자만 있으면 무슨 재화인지 알 수 없다).
    const detail = page.getByTestId("season-reward-message");
    await expect(detail).toContainText("500 G");
    await expect(detail).toContainText("4,000 Z");

    // 시즌 요약(승/무/패·득실·승점) — standings 의 isUser 행에서 파생.
    const summary = page.getByTestId("season-summary");
    await expect(summary).toBeVisible();
    await expect(page.getByTestId("season-summary-record")).toContainText("10승 4무 4패");
    await expect(page.getByTestId("season-summary-goals")).toContainText("31 - 22");
    await expect(page.getByTestId("season-summary-goals")).toContainText("+9");
    await expect(page.getByTestId("season-summary-points")).toContainText("34");

    // 지급 완료에는 재조회 버튼 없음.
    await expect(page.getByTestId("season-reward-retry")).toHaveCount(0);

    const overflow = await horizontalOverflow(page);
    console.log(`[smoke] 390px horizontal overflow px = ${overflow}`);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `${SMOKE_DIR}p3-league-reward-granted-390.png`,
      fullPage: true,
      animations: "disabled",
    });

    // 멱등성: 화면이 보낸 요청 중 비-GET 0건(지급 트리거 POST 없음).
    console.log(`[smoke] requests = ${JSON.stringify(methods)}`);
    expect(methods.filter((m) => !m.startsWith("GET "))).toEqual([]);
  });

  test("PENDING — '지급 처리 중' 안내 + 재조회(GET) 가능, 미지급 명시", async ({ page }) => {
    const methods = await mockLeague(page, { rank: 5, points: 300, status: "PENDING" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/league");

    const card = page.getByTestId("season-reward");
    await expect(card).toHaveAttribute("data-status", "PENDING");
    await expect(page.getByTestId("season-reward-status")).toContainText("처리 중");
    await expect(page.getByTestId("season-reward-points")).toHaveAttribute("data-awarded", "false");
    await expect(page.getByTestId("season-reward-points")).toContainText("미지급");

    const retry = page.getByTestId("season-reward-retry");
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(card).toHaveAttribute("data-status", "PENDING");

    // 재조회 후에도 비-GET 0건.
    console.log(`[smoke] requests after retry = ${JSON.stringify(methods)}`);
    expect(methods.filter((m) => !m.startsWith("GET "))).toEqual([]);
    expect(methods.filter((m) => m === "GET /api/league").length).toBeGreaterThanOrEqual(2);
  });

  test("FAILED — 서버 message 를 사용자에게 노출(숨김 금지) + 재조회 버튼", async ({ page }) => {
    await mockLeague(page, {
      rank: 7,
      points: 0,
      status: "FAILED",
      message: "지갑 반영 실패 — 관리자에게 문의하세요",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/league");

    const card = page.getByTestId("season-reward");
    await expect(card).toHaveAttribute("data-status", "FAILED");
    await expect(page.getByTestId("season-reward-status")).toContainText("지급되지 않았습니다");
    await expect(page.getByTestId("season-reward-message")).toContainText("지갑 반영 실패");
    await expect(page.getByTestId("season-reward-retry")).toBeVisible();
    // 요약은 status 와 무관하게 표시된다.
    await expect(page.getByTestId("season-summary")).toBeVisible();

    // 인지 갭 가드: toBeVisible 은 opacity:0 도 통과한다 — 페이드인이 끝난 뒤 실제로
    // **눈에 보이는지**(opacity 1)를 별도로 단언한다(캡처가 페이드 도중에 걸린 적 있음).
    await expect
      .poll(() => page.getByTestId("season-reward").evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");

    const overflow = await horizontalOverflow(page);
    console.log(`[smoke] FAILED 390px overflow px = ${overflow}`);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `${SMOKE_DIR}p3-league-reward-failed-390.png`,
      fullPage: true,
      animations: "disabled",
    });
  });

  test("NONE(서버: 종료됐으나 지급행 없음) — 미지급으로 노출 + 재조회 버튼", async ({ page }) => {
    // 서버 enum 3종 중 마지막. 이것도 클라가 몰라서 '알 수 없는 응답'으로 뭉개지고 있었다(#251).
    await mockLeague(page, { rank: 4, points: 0, gems: 0, status: "NONE" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/league");

    const card = page.getByTestId("season-reward");
    await expect(card).toHaveAttribute("data-status", "NONE");
    await expect(page.getByTestId("season-reward-status")).toContainText("지급되지 않았습니다");
    await expect(page.getByTestId("season-reward-retry")).toBeVisible();
    // 미지급이면 젬 줄도 없다(0 을 굳이 그리지 않는다).
    await expect(page.getByTestId("season-reward-gems")).toHaveCount(0);
  });

  test("구 별칭 AWARDED — 여전히 지급 완료로 해석(호환 유지)", async ({ page }) => {
    // 서버는 GRANTED 만 보내지만, 구 클라·구 목이 쓰던 이름을 갑자기 FAILED 로 떨어뜨리지 않는다.
    await mockLeague(page, { rank: 1, points: 100_000, gems: 9000, status: "AWARDED" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/league");

    await expect(page.getByTestId("season-reward")).toHaveAttribute("data-status", "AWARDED");
    await expect(page.getByTestId("season-reward-status")).toContainText("지급 완료");
    await expect(page.getByTestId("season-reward-gems")).toContainText("9,000");
  });

  test("seasonReward 부재(구 서버) — 기존 종료 화면 그대로, 깨짐 0", async ({ page }) => {
    await mockLeague(page, null);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/league");

    await expect(page.getByTestId("season-end")).toBeVisible();
    await expect(page.getByTestId("final-rank")).toContainText("3위");
    await expect(page.getByTestId("standings")).toBeVisible();
    await expect(page.getByTestId("new-season")).toBeVisible();
    // 보상 카드는 렌더되지 않는다(폴백).
    await expect(page.getByTestId("season-reward")).toHaveCount(0);

    const overflow = await horizontalOverflow(page);
    console.log(`[smoke] fallback 390px overflow px = ${overflow}`);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("seasonReward 가 원시값(계약 밖) — 카드가 사라지지 않고 FAILED 로 노출", async ({ page }) => {
    // 손상/계약이탈 응답 회귀 가드: 필드가 **있는데** 형태가 틀린 경우는 폴백이 아니라 노출이다.
    // (verifier probe 재현: 예전 구현은 cardCount 0 으로 카드가 통째로 사라졌다.)
    await mockLeague(page, "boom" as unknown as Reward);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/league");

    await expect(page.getByTestId("season-end")).toBeVisible();
    const card = page.getByTestId("season-reward");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-status", "FAILED");
    await expect(page.getByTestId("season-reward-message")).toContainText("확인할 수 없습니다");
    await expect(page.getByTestId("season-reward-retry")).toBeVisible();
    // 순위·요약 등 나머지 화면은 정상 유지(깨짐 0).
    await expect(page.getByTestId("final-rank")).toContainText("3위");
    await expect(page.getByTestId("season-summary")).toBeVisible();

    const overflow = await horizontalOverflow(page);
    console.log(`[smoke] primitive-reward 390px overflow px = ${overflow}`);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("prefers-reduced-motion: reduce — 연출 애니메이션 정지(값은 그대로)", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await mockLeague(page, { rank: 3, points: 500, status: "GRANTED" });
    await page.goto("/league");

    const points = page.getByTestId("season-reward-points");
    await expect(points).toContainText("500");
    // 카드에 진입 애니메이션 클래스가 붙지 않는다 + CSS 로도 animation-name: none.
    const anim = await page
      .getByTestId("season-reward")
      .evaluate((el) => getComputedStyle(el).animationName);
    console.log(`[smoke] reduced-motion animationName = ${anim}`);
    expect(anim).toBe("none");
    const rankAnim = await page
      .getByTestId("final-rank")
      .evaluate((el) => getComputedStyle(el.querySelector("strong")!).animationName);
    console.log(`[smoke] reduced-motion rank animationName = ${rankAnim}`);
    expect(rankAnim).toBe("none");
    await ctx.close();
  });

  test("데스크탑 1280px — 가로 오버플로 0", async ({ page }) => {
    await mockLeague(page, { rank: 3, points: 500, status: "GRANTED" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/league");
    await expect(page.getByTestId("season-reward")).toBeVisible();
    const overflow = await horizontalOverflow(page);
    console.log(`[smoke] 1280px horizontal overflow px = ${overflow}`);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SMOKE_DIR}p3-league-reward-desktop.png`, fullPage: false });
  });
});
