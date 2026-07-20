import { expect, test, type Page } from "@playwright/test";

/**
 * ⚠️ 이슈 #106 — 프리셋 UI 를 **화면에서 내렸다**(삭제가 아니라 렌더 중단: 컴포넌트 파일·훅·서버
 * 계약은 전부 존치). 이 파일의 스펙들은 그 진입점을 통해서만 성립하므로 **보류(skip)** 한다.
 * 지우지 않는 이유 = 프리셋 재도입 시 이 계약을 그대로 되살리기 위함.
 * (프리셋 부재 자체의 계약은 e2e/deck-teamsheet.spec.ts + 단위테스트가 담당한다.)
 */
test.skip(true, "#106: 프리셋 UI 를 화면에서 내림 — 재도입 시 이 스펙을 해제한다");

import { mkdirSync } from "node:fs";

/**
 * W5 "과거 세팅 로그 → 프리셋" (이슈 #98 요구 2) route-mock 스모크. 백엔드 없이 vite dev + page.route:
 *   1) 로그 탭 경기 행 → [이 경기 세팅 보기] → 매치 상세의 userDeckSnapshot 요약이 뜬다.
 *   2) [슬롯 N에 저장] → PUT /api/presets/team/{빈 슬롯} 이 **그 스냅샷 그대로**의 바디로 나간다(실측).
 *   3) 스냅샷 없는 경기(구 매치)는 저장 경로 비노출 + 안내.
 * 스크린샷 = apps/web/.smoke/.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

const attrs = {
  technical: 70, mental: 70, physical: 70, passing: 70, shooting: 70,
  tackling: 70, pace: 70, stamina: 70, positioning: 70,
};

const PLAYERS = Array.from({ length: 12 }, (_, i) => ({
  id: `P${i}`,
  name: `선수${i}`,
  position: i === 0 ? "GK" : "MF",
  grade: "GOLD",
  owned: true,
  ownedCount: 1,
  attributes: attrs,
  personality: "CALM",
}));

const SNAPSHOT = {
  formation: "4-3-3",
  starters: Array.from({ length: 11 }, (_, i) => ({
    playerId: `P${i}`,
    slotIndex: i,
    promptText: i === 0 ? "라인 올려" : null,
  })),
  bench: [{ playerId: "P11", slotIndex: 0, promptText: null }],
  teamTactics: { line: 0.8, press: 0.3, tempo: 0.7, width: 0.2 },
  // teamPrompt 없음 = 실서버 형상. server snapshotDeck 은 매치 스냅샷에 teamPrompt 를 저장하지
  // 않으므로 로그→프리셋 경로에서는 항상 비어 있다(UI/투영의 teamPrompt 분기는 방어 코드).
};

const LOGS = [
  {
    id: "with-snap",
    mode: "practice",
    opponentName: "봇A",
    result: "WIN",
    scoreHome: 2,
    scoreAway: 1,
    userWasHome: true,
    hasHalves: true,
    createdAt: "2026-07-19T10:00:00Z",
  },
  {
    id: "no-snap",
    mode: "practice",
    opponentName: "구경기봇",
    result: "LOSS",
    scoreHome: 0,
    scoreAway: 2,
    userWasHome: true,
    hasHalves: false,
    createdAt: "2026-06-01T10:00:00Z",
  },
];

const PRESETS = [
  { slot: 1, name: "메인", snapshot: SNAPSHOT, updatedAt: "2026-07-18T00:00:00Z" },
  { slot: 2, name: null, snapshot: null, updatedAt: null },
  { slot: 3, name: null, snapshot: null, updatedAt: null },
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

interface PutCapture {
  url: string;
  body: unknown;
}

async function mockApi(page: Page, puts: PutCapture[], presets = PRESETS) {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/logs/matches", (route) => route.fulfill(json(LOGS)));
  await page.route((url) => url.pathname === "/api/logs/trades", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/matches/with-snap", (route) =>
    route.fulfill(json({ id: "with-snap", state: "FINISHED", mode: "practice", userDeckSnapshot: SNAPSHOT })),
  );
  await page.route((url) => url.pathname === "/api/matches/no-snap", (route) =>
    route.fulfill(json({ id: "no-snap", state: "FINISHED", mode: "practice", userDeckSnapshot: null })),
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/presets/team"),
    (route) => {
      if (route.request().method() === "PUT") {
        puts.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
        return route.fulfill(json({ slot: 2, name: "vs 봇A 07.19", snapshot: SNAPSHOT, updatedAt: "now" }));
      }
      return route.fulfill(json(presets));
    },
  );
}

async function openLogs(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  // R3b E: 실기기 크기(390×844). 1200 은 존재하지 않는 폰 높이다.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/logs");
  await expect(page.getByTestId("logs-matches")).toBeVisible();
}

test("W5 경기 로그 → 세팅 보기 → 빈 슬롯에 프리셋 저장(PUT 바디 실측)", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  const puts: PutCapture[] = [];
  await mockApi(page, puts);
  await openLogs(page);

  await page.getByTestId("match-snapshot-open-with-snap").click();
  await expect(page.getByTestId("match-snapshot-dialog")).toBeVisible();

  // 1) 요약 = 그 경기 스냅샷
  await expect(page.getByTestId("snapshot-formation")).toHaveText("4-3-3");
  await expect(page.getByTestId("snapshot-starter-count")).toContainText("11");
  await expect(page.getByTestId("snapshot-starter-P0")).toHaveText("선수0"); // 카탈로그 조인
  await expect(page.getByTestId("snapshot-tactic-line")).toHaveText("0.80");
  // 실서버 스냅샷엔 teamPrompt 가 없다 → 표시도 없어야 한다.
  await expect(page.getByTestId("snapshot-team-prompt")).toHaveCount(0);

  // 2) 빈 슬롯(2)이 기본 대상
  await expect(page.getByTestId("snapshot-slot-2")).toHaveAttribute("data-selected", "true");

  await page.screenshot({ path: `${SMOKE_DIR}logs-snapshot-390.png`, fullPage: true });

  await page.getByTestId("snapshot-save").click();
  await expect(page.getByTestId("snapshot-saved")).toContainText("슬롯 2");

  // 3) PUT 바디 실측 — 그 경기 스냅샷 그대로(포메이션·선발11·프롬프트·벤치·팀전술·팀프롬프트)
  expect(puts).toHaveLength(1);
  expect(puts[0]!.url).toBe("/api/presets/team/2");
  expect(puts[0]!.body).toEqual({
    name: "vs 봇A 07.19",
    formation: "4-3-3",
    starters: SNAPSHOT.starters,
    bench: SNAPSHOT.bench,
    teamTactics: SNAPSHOT.teamTactics,
    teamPrompt: null,
  });

  // 390px 가로 오버플로 0
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("W5 전 슬롯이 차 있으면 기본 선택 없음 + 저장 비활성(1탭 덮어쓰기 방지)", async ({ page }) => {
  const puts: PutCapture[] = [];
  await mockApi(page, puts, PRESETS.map((s) => ({ ...s, name: `프리셋${s.slot}`, snapshot: SNAPSHOT })));
  await openLogs(page);

  await page.getByTestId("match-snapshot-open-with-snap").click();
  for (const n of [1, 2, 3]) {
    await expect(page.getByTestId(`snapshot-slot-${n}`)).toHaveAttribute("data-selected", "false");
  }
  const save = page.getByTestId("snapshot-save");
  await expect(save).toBeDisabled();
  await expect(save).toHaveText("저장할 슬롯을 선택하세요");
  expect(puts).toHaveLength(0);

  // 명시적으로 탭해야 활성 — 라벨이 파괴성을 드러낸다(툴팁 아님).
  await page.getByTestId("snapshot-slot-3").click();
  await expect(save).toHaveText("슬롯 3 덮어쓰기");
  await save.click();
  await expect(page.getByTestId("snapshot-saved")).toContainText("슬롯 3");
  expect(puts.map((p) => p.url)).toEqual(["/api/presets/team/3"]);
});

test("W5 스냅샷 없는 경기는 저장 경로 비노출 + 안내", async ({ page }) => {
  const puts: PutCapture[] = [];
  await mockApi(page, puts);
  await openLogs(page);

  await page.getByTestId("match-snapshot-open-no-snap").click();
  await expect(page.getByTestId("match-snapshot-none")).toBeVisible();
  await expect(page.getByTestId("snapshot-save")).toHaveCount(0);
  await expect(page.getByTestId("match-snapshot-summary")).toHaveCount(0);

  await page.getByTestId("match-snapshot-close").click();
  await expect(page.getByTestId("match-snapshot-dialog")).toHaveCount(0);
  expect(puts).toHaveLength(0);
});

test("W5 데스크탑(1280px)에서도 다이얼로그가 깨지지 않는다", async ({ page }) => {
  const puts: PutCapture[] = [];
  await mockApi(page, puts);
  await openLogs(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByTestId("match-snapshot-open-with-snap").click();
  await expect(page.getByTestId("match-snapshot-dialog")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SMOKE_DIR}logs-snapshot-1280.png`, fullPage: true });
});
