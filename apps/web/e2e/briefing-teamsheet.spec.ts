import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * 브리핑에 임베드된 팀 시트 계약 (이슈 #106 R1 검증 B1 회귀 가드).
 *
 * DeckEditor 는 덱 화면과 **브리핑에 동시에 임베드**된다. 브리핑 컨테이너(~688px)는 덱 화면보다
 * 훨씬 좁으므로, 레이아웃 전환을 **뷰포트 폭**으로 걸면 넓은 모니터에서 브리핑의 보드가 0 으로
 * 붕괴한다(검증자 실측: vw=1280 에서 pitch 50x53, 11 슬롯이 한 점에 겹쳐 GK 외 선택 불가).
 * 그래서 이 스펙은 **브리핑 화면에서** 다음을 박제한다:
 *   1) 1279 / 1280(경계) / 1440 에서 피치가 붕괴하지 않는다(width ≥ 200px)
 *   2) 선발 11 슬롯이 **서로 다른 좌표**에 있고 **각각 탭 가능**하다(elementFromPoint = 그 슬롯)
 *   3) 킥오프가 브리핑 편집(라인업·프롬프트·전술)을 PUT /api/deck 로 영속하고 프리셋 경로는
 *      건드리지 않는다 — 구 briefing-preset.spec.ts 의 프리셋 무관 가드를 프리셋 없는 형태로 복원.
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

const PLAYERS = Array.from({ length: 14 }, (_, i) =>
  mkPlayer(`DECK${i + 1}`, `덱선수 ${i + 1}`, i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW"),
);

const deckSlots = Array.from({ length: 11 }, (_, i) => ({
  playerId: `DECK${i + 1}`, role: "starter", slotIndex: i, promptText: null,
}));

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
  kickoffBodies: Array<{ teamTactics?: { line: number; press: number; tempo: number; width: number } }>;
}

/** ⚠️ 라우트 매칭은 오리진 앵커(pathname) — 상대 글롭은 vite 소스 요청까지 삼켜 흰 화면이 된다. */
async function mockApi(page: Page, cap: Captured) {
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
  await page.route((url) => url.pathname === "/api/deck", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      cap.deckPuts.push(body);
      state.deck = { formation: body.formation, slots: body.slots };
    }
    return route.fulfill(json(state.deck));
  });
  await page.route((url) => /^\/api\/presets\/team\/[123]$/.test(url.pathname), (route) => {
    cap.presetPuts += 1;
    return route.fulfill(json({}));
  });
  await page.route((url) => /^\/api\/presets\/team\/[123]\/apply$/.test(url.pathname), (route) => {
    cap.applyCalls += 1;
    return route.fulfill(json(state.deck));
  });
  await page.route((url) => url.pathname === "/api/matches/m1", (route) => route.fulfill(json(MATCH)));
  await page.route((url) => url.pathname === "/api/matches/m1/prompts", (route) => route.fulfill(json(MATCH)));
  await page.route((url) => url.pathname === "/api/matches/m1/kickoff", (route) => {
    cap.kickoffs += 1;
    cap.kickoffBodies.push(route.request().postDataJSON() ?? {});
    return route.fulfill(json({ ...MATCH, state: "GEN1" }));
  });
}

interface SlotProbe {
  testId: string;
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** 슬롯 중심의 elementFromPoint 가 그 슬롯 자신(또는 그 자손)인가 = 실제로 탭 가능한가 */
  tappable: boolean;
}

/** 선발 11 슬롯의 기하 + 히트테스트를 한 번에 실측한다(좌표 추론 금지 — 실제 DOM hit-test). */
async function probeSlots(page: Page): Promise<{ pitch: { width: number; height: number }; slots: SlotProbe[] }> {
  return page.evaluate(() => {
    const pitchEl = document.querySelector('[data-testid="tactics-board"]')!.getBoundingClientRect();
    const els = Array.from(document.querySelectorAll('[data-testid^="board-slot-starter-"]'));
    const slots = els.map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        testId: el.getAttribute("data-testid")!,
        cx: Math.round(cx),
        cy: Math.round(cy),
        width: Math.round(r.width),
        height: Math.round(r.height),
        tappable: Boolean(hit && (el === hit || el.contains(hit))),
      };
    });
    return { pitch: { width: Math.round(pitchEl.width), height: Math.round(pitchEl.height) }, slots };
  });
}

async function openBriefing(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/match/m1");
  await expect(page.getByTestId("briefing-panel")).toBeVisible();
  await expect(page.getByTestId("deck-editor")).toBeVisible();
}

test("B1 회귀 가드: 브리핑 전술보드가 1279/1280/1440 에서 붕괴하지 않고 11 슬롯이 각각 탭 가능", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  const cap: Captured = { deckPuts: [], applyCalls: 0, presetPuts: 0, kickoffs: 0, kickoffBodies: [] };
  await mockApi(page, cap);
  await openBriefing(page);

  for (const width of [1279, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    const { pitch, slots } = await probeSlots(page);
    const tappable = slots.filter((s) => s.tappable).length;
    const distinct = new Set(slots.map((s) => `${s.cx},${s.cy}`)).size;
    console.log(
      `[smoke] briefing vw=${width} pitch=${pitch.width}x${pitch.height} tappable=${tappable}/11 distinct=${distinct}/11`,
    );
    expect(slots, `vw=${width}: 선발 슬롯 11개`).toHaveLength(11);
    expect(pitch.width, `vw=${width}: 피치 폭 붕괴`).toBeGreaterThanOrEqual(200);
    expect(distinct, `vw=${width}: 슬롯이 서로 다른 좌표에 있어야 한다`).toBe(11);
    expect(tappable, `vw=${width}: 11 슬롯 모두 탭 가능해야 한다`).toBe(11);
    await page.screenshot({ path: `${SMOKE_DIR}r1-briefing-${width}.png`, fullPage: true });
  }

  // 실제로 GK 아닌 선수를 눌러 레일이 그 선수로 바뀌는지(= 선택이 먹히는지) 확인
  await page.getByTestId("board-slot-starter-6").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "player");
  await expect(page.getByTestId("rail-title")).toHaveText("덱선수 7");
});

test("브리핑 편집 → 킥오프가 PUT /api/deck 로 영속(프리셋 경로 미호출)", async ({ page }) => {
  const cap: Captured = { deckPuts: [], applyCalls: 0, presetPuts: 0, kickoffs: 0, kickoffBodies: [] };
  await mockApi(page, cap);
  await page.setViewportSize({ width: 390, height: 844 });
  await openBriefing(page);

  // 1) 매치용 편집: 팀 프롬프트 + 팀 전술 + 선수 프롬프트
  //    #244: 레일이 문서 흐름이라 독을 펼칠 일이 없다 — 프롬프트는 진입 즉시 그 자리에 있다.
  await page.getByTestId("editor-team-prompt").fill("오늘은 수비적으로");
  // 팀 전술 = 5스텝 세그먼트. #244 로 ⚙ 세부조정 뒤에 있다. step 3 = 계약값 0.75.
  await page.getByTestId("team-tune-toggle").click();
  await page.getByTestId("tactics-press-step-3").click();
  await page.getByTestId("board-slot-starter-9").click();
  await page.getByTestId("rail-prompt-input").fill("측면 파고들어라");

  // 1-b) #244: 마지막 블록([킥오프])이 **문서 안에서** 온전히 보인다(구: 접힌 독 클리어런스 계약).
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(150);
  const kickoffBox = await page.evaluate(() => {
    const k = document.querySelector('[data-testid="kickoff-button"]')!.getBoundingClientRect();
    return { top: k.top, bottom: k.bottom, fold: window.innerHeight };
  });
  console.log(`[smoke] briefing kickoff bottom=${kickoffBox.bottom.toFixed(1)} fold=${kickoffBox.fold}`);
  expect(kickoffBox.bottom, "킥오프 버튼이 화면 밖으로 잘리면 안 된다").toBeLessThanOrEqual(kickoffBox.fold);

  // 2) 킥오프 → PUT /api/deck 바디에 그 편집이 반영, 프리셋 저장/적용은 없음
  await page.getByTestId("kickoff-button").click();
  await expect.poll(() => cap.kickoffs).toBe(1);
  expect(cap.deckPuts.length).toBe(1);
  const put = cap.deckPuts[0]!;
  const starters = put.slots.filter((s) => s.role === "starter");
  expect(starters).toHaveLength(11);
  const edited = starters.find((s) => s.slotIndex === 9)!;
  console.log(`[smoke] PUT /api/deck slot9 promptText = ${JSON.stringify(edited.promptText)}`);
  expect(edited.promptText).toContain("측면 파고들어라");
  expect(cap.kickoffBodies[0]!.teamTactics!.press).toBeCloseTo(0.75, 5);
  expect(cap.applyCalls, "브리핑은 활성 덱을 미리 바꾸지 않는다").toBe(0);
  expect(cap.presetPuts, "프리셋 자체도 수정하지 않는다").toBe(0);

  // 3) 390px 가로 오버플로 0
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] briefing 390px horizontal overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);

});
