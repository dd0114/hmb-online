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
 * W6a 브리핑 프리셋 선택 route-mock 스모크 (이슈 #98 요구 2 — "게임 시작 시엔 1/2/3 중 선택 → 그
 * 위에 매치용 추가 수정 → 진행") — 백엔드 없이 vite dev + page.route 로 /api 를 목킹해 박제한다:
 *   브리핑 진입(활성 덱 라인업) → 프리셋 칩 노출(채운 슬롯만 활성) → 슬롯 선택 → 보드가 그 프리셋
 *   라인업으로 교체 → 매치용 1건 수정(팀 프롬프트) → 킥오프 → PUT /api/deck 바디가 **수정 반영된 그
 *   프리셋 라인업**인지 검증 + apply 미호출.
 * 스크린샷 = apps/web/.smoke/.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

const attrs = {
  technical: 72, mental: 68, physical: 75, passing: 70, shooting: 66,
  tackling: 64, pace: 73, stamina: 71, positioning: 69,
};

const mkPlayer = (id: string, name: string, position: string) => ({
  id, name, position, grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs, personality: "CALM",
});

/** 활성 덱용 DECK1..11 + 프리셋용 MAIN1..11 (전부 보유 — 교체가 눈에 보이도록 id 분리). */
const PLAYERS = [
  ...Array.from({ length: 11 }, (_, i) =>
    mkPlayer(`DECK${i + 1}`, `덱선수 ${i + 1}`, i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW"),
  ),
  ...Array.from({ length: 11 }, (_, i) =>
    mkPlayer(`MAIN${i + 1}`, `프리셋선수 ${i + 1}`, i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW"),
  ),
];

const deckSlots = Array.from({ length: 11 }, (_, i) => ({
  playerId: `DECK${i + 1}`, role: "starter", slotIndex: i, promptText: null,
}));

const presetStarters = Array.from({ length: 11 }, (_, i) => ({
  playerId: `MAIN${i + 1}`, slotIndex: i, promptText: null,
}));

/** 활성 덱(4-4-2 · 기본 전술 0.5)과 **다른** 값이어야 전파를 실증할 수 있다. */
const PRESET_FORMATION = "4-3-3";
const PRESET_TACTICS = { line: 0.8, press: 0.3, tempo: 0.7, width: 0.2 };

const PRESETS = [
  {
    slot: 1,
    name: "메인 전술",
    snapshot: {
      formation: PRESET_FORMATION,
      starters: presetStarters,
      bench: [],
      teamTactics: PRESET_TACTICS,
      teamPrompt: "메인 팀 지시",
    },
  },
  { slot: 2, name: null, snapshot: null },
  { slot: 3, name: null, snapshot: null },
];

const MATCH = {
  id: "m1",
  createdAt: "2026-07-19T00:00:00Z",
  state: "BRIEFING",
  opponent: {
    name: "공격 봇",
    analysisText: "빠른 역습 팀",
    deck: [{ name: "봇 에이스", position: "FW", grade: "GOLD", hasPrompt: true }],
  },
};

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

interface Captured {
  deckPuts: Array<{ formation: string; slots: Array<{ playerId: string; role: string; slotIndex: number; promptText: string | null }> }>;
  applyCalls: number;
  presetPuts: number;
  kickoffs: number;
  /** kickoff 요청 바디(= {teamTactics}) — 전술 전파 실측용. */
  kickoffBodies: Array<{ teamTactics?: { line: number; press: number; tempo: number; width: number } }>;
}

async function mockApi(page: Page, cap: Captured) {
  // pathname 매칭(글롭 '**/api/**' 는 vite 소스 /src/api/*.ts 까지 잡아 모듈로딩을 깬다).
  // Playwright 는 나중에 등록한 핸들러가 우선 — catch-all 먼저, 구체 라우트 뒤에.
  const state = { deck: { formation: "4-4-2", slots: deckSlots as unknown[] } };

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/presets", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })));
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({
      user: { id: "u1", nickname: "테스터", provider: "guest" },
      wallet: { points: 1000 },
      records: { played: 0, wins: 0, draws: 0, losses: 0 },
    })));

  await page.route(
    (url) => url.pathname === "/api/deck",
    (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        cap.deckPuts.push(body);
        state.deck = { formation: body.formation, slots: body.slots };
      }
      return route.fulfill(json(state.deck));
    },
  );

  await page.route((url) => url.pathname === "/api/presets/team", (route) => route.fulfill(json(PRESETS)));
  await page.route(
    (url) => /^\/api\/presets\/team\/[123]$/.test(url.pathname),
    (route) => {
      cap.presetPuts += 1;
      return route.fulfill(json(PRESETS[0]));
    },
  );
  await page.route(
    (url) => /^\/api\/presets\/team\/[123]\/apply$/.test(url.pathname),
    (route) => {
      cap.applyCalls += 1;
      return route.fulfill(json(state.deck));
    },
  );

  await page.route((url) => url.pathname === "/api/matches/m1", (route) => route.fulfill(json(MATCH)));
  await page.route((url) => url.pathname === "/api/matches/m1/prompts", (route) => route.fulfill(json(MATCH)));
  await page.route(
    (url) => url.pathname === "/api/matches/m1/kickoff",
    (route) => {
      cap.kickoffs += 1;
      cap.kickoffBodies.push(route.request().postDataJSON() ?? {});
      return route.fulfill(json({ ...MATCH, state: "GEN1" }));
    },
  );
}

test("W6a briefing-preset: 프리셋 1/2/3 선택 → 매치용 수정 → 킥오프가 그 라인업을 영속", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  const cap: Captured = { deckPuts: [], applyCalls: 0, presetPuts: 0, kickoffs: 0, kickoffBodies: [] };
  await mockApi(page, cap);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/match/m1");

  // 1) 브리핑 진입 — 기본은 활성 덱 라인업(현행 동작 유지).
  await expect(page.getByTestId("briefing-panel")).toBeVisible();
  await expect(page.getByTestId("token-DECK1")).toBeVisible();
  await expect(page.getByTestId("briefing-preset-chip-1")).toHaveAttribute("data-selected", "false");

  // 2) 칩 노출: 채워진 슬롯만 활성, 빈 슬롯은 비활성 + "비어 있음".
  await expect(page.getByTestId("briefing-preset-chip-1")).toBeEnabled();
  await expect(page.getByTestId("briefing-preset-chip-1")).toContainText("메인 전술");
  await expect(page.getByTestId("briefing-preset-chip-2")).toBeDisabled();
  await expect(page.getByTestId("briefing-preset-chip-2")).toContainText("비어 있음");
  await expect(page.getByTestId("briefing-preset-hint")).toBeVisible();
  await page.screenshot({ path: `${SMOKE_DIR}w6a-briefing-presets.png`, fullPage: true });

  // 3) 슬롯 1 선택 → 보드가 프리셋 라인업으로 교체(활성 덱 토큰 사라짐).
  await page.getByTestId("briefing-preset-chip-1").click();
  await expect(page.getByTestId("token-MAIN1")).toBeVisible();
  await expect(page.getByTestId("token-DECK1")).toHaveCount(0);
  await expect(page.getByTestId("briefing-preset-chip-1")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("editor-team-prompt")).toHaveValue("메인 팀 지시");

  // 4) 매치용 수정 1건(팀 프롬프트) — 프리셋 위에 덧씌우는 매치 전용 편집.
  await page.getByTestId("editor-team-prompt").fill("오늘은 수비적으로");

  // 5) 킥오프 → PUT /api/deck 바디 = 프리셋 라인업(수정 반영), apply/preset PUT 미호출.
  await page.getByTestId("kickoff-button").click();
  await expect.poll(() => cap.kickoffs).toBe(1);
  expect(cap.deckPuts.length).toBe(1);
  const put = cap.deckPuts[0]!;
  const starters = put.slots.filter((s) => s.role === "starter").map((s) => s.playerId).sort();
  console.log(`[smoke] PUT /api/deck starters = ${starters.join(",")}`);
  expect(starters).toEqual(presetStarters.map((s) => s.playerId).sort());
  expect(starters.some((id) => id.startsWith("DECK"))).toBe(false);

  // 5b) 포메이션 전파: 활성 덱 4-4-2 ≠ 프리셋 4-3-3 → PUT 바디는 프리셋 값이어야 한다.
  console.log(`[smoke] PUT /api/deck formation = ${put.formation} (active deck was 4-4-2)`);
  expect(put.formation).toBe(PRESET_FORMATION);

  // 5c) 팀 전술 전파: kickoff 인자 teamTactics = 프리셋 스냅샷 값(기본 0.5 아님).
  const kicked = cap.kickoffBodies[0]!;
  console.log(`[smoke] kickoff teamTactics = ${JSON.stringify(kicked.teamTactics)}`);
  expect(kicked.teamTactics).toEqual(PRESET_TACTICS);

  expect(cap.applyCalls).toBe(0); // 브리핑은 매치 작업사본 — 활성 덱을 미리 바꾸지 않는다
  expect(cap.presetPuts).toBe(0); // 프리셋 자체도 수정하지 않는다

  // 6) 390px 가로 오버플로 0.
  await page.goto("/match/m1");
  await expect(page.getByTestId("briefing-panel")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] 390px horizontal overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("W6a briefing-preset: 매치용 수정 후 다른 프리셋 선택 → 덮어쓰기 확인(취소/불러오기)", async ({ page }) => {
  const cap: Captured = { deckPuts: [], applyCalls: 0, presetPuts: 0, kickoffs: 0, kickoffBodies: [] };
  const presets2 = [
    PRESETS[0],
    {
      slot: 2,
      name: "백업 전술",
      snapshot: {
        formation: "4-3-3",
        starters: Array.from({ length: 11 }, (_, i) => ({ playerId: `DECK${i + 1}`, slotIndex: i, promptText: null })),
        bench: [],
        teamTactics: { line: 0.6, press: 0.6, tempo: 0.6, width: 0.6 },
        teamPrompt: "백업 팀 지시",
      },
    },
    PRESETS[2],
  ];
  await mockApi(page, cap);
  // 슬롯 2도 채운 목록으로 덮어쓴다(마지막 등록 핸들러 우선).
  await page.route((url) => url.pathname === "/api/presets/team", (route) => route.fulfill(json(presets2)));
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/match/m1");
  await expect(page.getByTestId("briefing-panel")).toBeVisible();

  await page.getByTestId("briefing-preset-chip-1").click();
  await expect(page.getByTestId("token-MAIN1")).toBeVisible();
  await page.getByTestId("editor-team-prompt").fill("오늘은 수비적으로");

  // 취소 → 매치 수정 유지
  await page.getByTestId("briefing-preset-chip-2").click();
  await expect(page.getByTestId("briefing-preset-confirm")).toBeVisible();
  await page.screenshot({ path: `${SMOKE_DIR}w6a-briefing-preset-confirm.png`, fullPage: false });
  await page.getByTestId("briefing-preset-confirm-cancel").click();
  await expect(page.getByTestId("briefing-preset-confirm")).toHaveCount(0);
  await expect(page.getByTestId("editor-team-prompt")).toHaveValue("오늘은 수비적으로");
  await expect(page.getByTestId("token-MAIN1")).toBeVisible();

  // a11y 계약(W6b-1): 열림 시 포커스가 다이얼로그 내부 · Tab 순환이 밖으로 새지 않음 ·
  // Esc = 취소(매치 수정·선택 슬롯 무변경) · 닫힌 뒤 포커스는 트리거 칩으로 복원.
  await page.getByTestId("briefing-preset-chip-2").click();
  await expect(page.getByTestId("briefing-preset-confirm")).toBeVisible();
  const focusedTestId = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
  const focusInsideDialog = () =>
    page.evaluate(() => {
      const dlg = document.querySelector('[data-testid="briefing-preset-confirm"]');
      return Boolean(dlg && document.activeElement && dlg.contains(document.activeElement));
    });
  expect(await focusInsideDialog()).toBe(true);
  const cycle: string[] = [await focusedTestId()];
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInsideDialog()).toBe(true);
    cycle.push(await focusedTestId());
  }
  await page.keyboard.press("Shift+Tab");
  expect(await focusInsideDialog()).toBe(true);
  console.log(`[smoke] briefing-confirm focus cycle = ${cycle.join(" > ")}`);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("briefing-preset-confirm")).toHaveCount(0);
  await expect(page.getByTestId("editor-team-prompt")).toHaveValue("오늘은 수비적으로");
  await expect(page.getByTestId("briefing-preset-chip-1")).toHaveAttribute("data-selected", "true");
  expect(await focusedTestId()).toBe("briefing-preset-chip-2"); // 포커스 복원

  // 칩 이름 툴팁(잘린 이름 확인용).
  await expect(page.getByTestId("briefing-preset-chip-1")).toHaveAttribute("title", /메인 전술/);

  // 불러오기 → 수정 폐기하고 슬롯 2 로드
  await page.getByTestId("briefing-preset-chip-2").click();
  await expect(page.getByTestId("briefing-preset-confirm")).toBeVisible();
  await page.getByTestId("briefing-preset-confirm-load").click();
  await expect(page.getByTestId("briefing-preset-confirm")).toHaveCount(0);
  await expect(page.getByTestId("editor-team-prompt")).toHaveValue("백업 팀 지시");
  await expect(page.getByTestId("token-DECK1")).toBeVisible();
  await expect(page.getByTestId("briefing-preset-chip-2")).toHaveAttribute("data-selected", "true");
});
