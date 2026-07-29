import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * #276 — 감독시간 **포메이션 + 선발 배치** 변경 (E2E-TDD, 전면 목킹).
 *
 * hero 결정이 #244 의 전제 하나를 뒤집었다: 감독시간에도 **포메이션과 선발 배치(슬롯)를 바꾼다**.
 * 못 바꾸는 것은 **경기 스쿼드 밖에서 선수를 데려오는 것**뿐이다 — 그래서 `placementLocked` 를
 * 통째로 풀지 않고 축을 쪼갰다(`placementLocked` = 스쿼드 밖 차단 / `lineupEditable` = 배치 편집).
 *
 * 이 스펙이 실브라우저에서 재는 것:
 *   ① 감독시간 화면에 포메이션 셀렉트와 [자리] 탭이 있다(덱과 같은 보드 위에서)
 *   ② 포메이션 변경 · 선발끼리 자리 바꾸기 · 교체가 **한 번의** `/halftime` 에 함께 실린다
 *      — `starters` 는 투입 선수를 포함하고 out 선수를 제외한다(서버 ROSTER_MISMATCH 계약)
 *   ③ 아무것도 안 건드려도 전반과 같은 배치를 **그대로** 보낸다(콜0 판정은 서버가 한다 — #215)
 *   ④ 스냅샷 없는 구 매치는 배치를 안 보내고 #244 현행 교체 동작을 유지한다(기능 소실 금지)
 *   ⑤ 만료되면 포메이션 셀렉트·보드가 잠긴다
 *   ⑥ 스쿼드 밖 선수를 데려오는 손잡이는 여전히 없다(#244 계약 유지)
 *
 * ⚠️ 라우트 매칭은 **오리진 앵커**(url.pathname) — 상대 글롭은 vite dev 소스 요청까지 삼켜 흰 화면이 된다.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;
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
  P("DECKONLY", "덱에만있는선수", "FW", "BRONZE", 50),
];

/** 전반에 실제로 쓴 라인업(매치 스냅샷) — 서버가 `starters` 를 대조하는 기준. */
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

/**
 * **현재 덱은 스냅샷과 다르다** — 전반 시작 후 유저가 덱을 고친 상황. 기준을 덱으로 잡으면
 * 서버가 400 ROSTER_MISMATCH 를 낸다(그래서 보드는 스냅샷에서 시작해야 한다).
 */
const deckSlots = [
  ...SNAP_STARTERS.slice(0, 10).map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
  { playerId: "DECKONLY", role: "starter", slotIndex: 10, promptText: null },
  { playerId: "SUB1", role: "bench", slotIndex: 0, promptText: null },
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

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

interface HalftimeBody {
  substitutions: Array<{ out: string; in: string }>;
  teamTactics?: Record<string, number>;
  formation?: string;
  starters?: Array<{ playerId: string; slotIndex: number }>;
}

async function openHalftime(
  page: Page,
  opts: { snapshot?: unknown; remainingMs?: number } = {},
): Promise<HalftimeBody[]> {
  const bodies: HalftimeBody[] = [];
  const match = {
    id: "m276",
    createdAt: "2026-07-29T00:00:00Z",
    state: "HALFTIME",
    scoreH1Home: 1, scoreH1Away: 0, scoreHome: 1, scoreAway: 0,
    conditions: Object.fromEntries(SNAP_STARTERS.map((id, i) => [id, 0.3 + (i % 5) * 0.15])),
    opponent: { name: "역습 봇", analysisText: "빠른 역습.", deck: [] },
    clock: halftimeClock(opts.remainingMs ?? 47_000),
    userDeckSnapshot: "snapshot" in opts ? opts.snapshot : SNAPSHOT,
  };

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })));
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    route.fulfill(json(Object.fromEntries(SNAP_STARTERS.map((id, i) => [id, 0.3 + (i % 5) * 0.15])))));
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json({
    user: { id: "u1", nickname: "테스터", provider: "guest", tutorialDone: true },
    wallet: { points: 1000 }, records: { played: 0, wins: 0, draws: 0, losses: 0 },
  })));
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json({ match: null, locked: false, abandonable: false })));
  await page.route((url) => url.pathname === "/api/deck", (route) =>
    route.fulfill(json({ formation: "4-3-3", slots: deckSlots, teamPrompt: null })));
  await page.route((url) => url.pathname === "/api/matches/m276/halftime", (route) => {
    bodies.push(route.request().postDataJSON() as HalftimeBody);
    return route.fulfill(json({}));
  });
  await page.route((url) => url.pathname === "/api/matches/m276", (route) => route.fulfill(json(match)));

  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/match/m276");
  await expect(page.getByTestId("halftime-panel")).toBeVisible({ timeout: 30_000 });
  return bodies;
}

/** 자리 바꾸기 = [자리] 탭 → 선발 두 명 탭(교체와 **같은 두 번 탭** 제스처). */
async function swap(page: Page, aId: string, bId: string) {
  await page.getByTestId("halftime-mode-move").click();
  await page.getByTestId(`token-${aId}`).click();
  await page.getByTestId(`token-${bId}`).click();
}

const slotOf = (b: HalftimeBody, playerId: string) =>
  b.starters?.find((s) => s.playerId === playerId)?.slotIndex;

test.describe("#276 감독시간 포메이션·선발 배치", () => {
  test.use({ viewport: PHONE });
  test.beforeAll(() => mkdirSync(SMOKE_DIR, { recursive: true }));

  test("AC1 보드 위에 포메이션 셀렉트와 [자리] 탭이 있다 (기준 = 매치 스냅샷)", async ({ page }) => {
    await openHalftime(page);
    await expect(page.getByTestId("deck-editor")).toBeVisible();
    await expect(page.getByTestId("formation-select")).toBeVisible();
    await expect(page.getByTestId("formation-select")).toHaveValue("4-4-2"); // 덱(4-3-3)이 아니다
    await expect(page.getByTestId("halftime-mode-move")).toBeVisible();
    // 덱에만 있는 선수는 보드에 없다 — 라인업은 그 경기에 쓴 스냅샷이다.
    await expect(page.getByTestId("token-DECKONLY")).toHaveCount(0);
    await expect(page.getByTestId("token-FW2")).toBeVisible();
    await page.screenshot({ path: `${SMOKE_DIR}p276-halftime-board.png` });
  });

  test("AC2 포메이션 + 자리 바꾸기 + 교체가 한 번의 /halftime 에 함께 실린다", async ({ page }) => {
    const bodies = await openHalftime(page);

    await page.getByTestId("formation-select").selectOption("4-3-3");
    await page.screenshot({ path: `${SMOKE_DIR}p276-halftime-formation-433.png` });

    await swap(page, "FW1", "FW2"); // 9번 ↔ 10번
    await page.screenshot({ path: `${SMOKE_DIR}p276-halftime-move.png` });

    // 교체 — #244 제스처 그대로(보드에서 뺄 선수 → 벤치에서 넣을 선수)
    await page.getByTestId("halftime-mode-sub").click();
    await page.getByTestId("token-MF1").click();
    await page.getByTestId("token-SUB1").click();
    await expect(page.getByTestId("sub-chip-0")).toBeVisible();
    await expect(page.getByTestId("token-out-MF1")).toBeVisible();
    await page.screenshot({ path: `${SMOKE_DIR}p276-halftime-after-sub.png` });

    await page.getByTestId("resume-button").click();
    await expect.poll(() => bodies.length).toBe(1); // 세 필드가 **한 번의** 호출에

    const b = bodies[0]!;
    expect(b.substitutions).toEqual([{ out: "MF1", in: "SUB1" }]);
    expect(b.formation).toBe("4-3-3");
    expect(b.starters).toHaveLength(11);
    // 집합 불변식 = 전반 선발 − outs + ins (서버 ROSTER_MISMATCH 와 같은 식)
    const expected = new Set(SNAP_STARTERS.filter((id) => id !== "MF1").concat("SUB1"));
    expect(new Set(b.starters!.map((s) => s.playerId))).toEqual(expected);
    // 투입 선수는 나간 선수가 서 있던 슬롯을, 자리 바꾸기는 그대로 살아 있다
    expect(slotOf(b, "SUB1")).toBe(5);
    expect(slotOf(b, "FW1")).toBe(10);
    expect(slotOf(b, "FW2")).toBe(9);
  });

  /**
   * 📌 `#215` 콜0 의 본질은 "필드를 안 보낸다"가 아니라 "**AI 콜이 0이다**"이고, 그 판정은 서버가
   * 한다(`secondHalfShapeChanged`). 웹이 조건부로 빼면 1R blocker 2건(재제출 400 고착 · 취소한
   * 배치가 조용히 반영)이 그대로 돌아온다.
   */
  test("AC3 아무것도 안 건드려도 전반과 같은 배치를 그대로 보낸다", async ({ page }) => {
    const bodies = await openHalftime(page);
    await page.getByTestId("resume-button").click();
    await expect.poll(() => bodies.length).toBe(1);

    const b = bodies[0]!;
    expect(b.substitutions).toEqual([]);
    expect(b.formation).toBe("4-4-2");
    expect(b.starters).toHaveLength(11);
    expect(slotOf(b, "GK1")).toBe(0);
    expect(slotOf(b, "FW2")).toBe(10);
  });

  test("AC4 스냅샷 없는 구 매치 — 배치 미전송 + #244 현행 교체 동작 유지", async ({ page }) => {
    const bodies = await openHalftime(page, { snapshot: null });
    // 보낼 데가 없는 손잡이는 만들지 않는다.
    await expect(page.getByTestId("formation-select")).toHaveCount(0);
    await expect(page.getByTestId("halftime-mode-move")).toHaveCount(0);
    // 보드는 덱에서 파생된다(#244 현행)
    await expect(page.getByTestId("token-DECKONLY")).toBeVisible();
    await page.screenshot({ path: `${SMOKE_DIR}p276-halftime-fallback.png` });

    await page.getByTestId("halftime-mode-sub").click();
    await page.getByTestId("token-MF1").click();
    await page.getByTestId("token-SUB1").click();
    await expect(page.getByTestId("sub-chip-0")).toBeVisible();
    await page.getByTestId("resume-button").click();
    await expect.poll(() => bodies.length).toBe(1);

    const b = bodies[0]!;
    expect(b.substitutions).toEqual([{ out: "MF1", in: "SUB1" }]);
    expect(b.formation).toBeUndefined();
    expect(b.starters).toBeUndefined();
  });

  test("AC5 만료되면 포메이션 셀렉트·보드가 잠긴다", async ({ page }) => {
    await openHalftime(page, { remainingMs: -1_000 });
    await expect(page.getByTestId("halftime-countdown")).toContainText("감독시간 종료");
    await expect(page.getByTestId("formation-select")).toBeDisabled();
    await expect(page.getByTestId("halftime-mode-move")).toBeDisabled();
    await expect(page.getByTestId("resume-button")).toBeDisabled();
    await page.screenshot({ path: `${SMOKE_DIR}p276-halftime-expired.png` });

    // 탭 자체도 배치를 바꾸지 않는다(잠금은 한 겹이 아니다).
    await page.getByTestId("token-FW1").click();
    await page.getByTestId("token-FW2").click();
    await expect(page.getByTestId("board-slot-starter-9")).toContainText("공격하나");
  });

  test("AC6 배치가 열려도 스쿼드 밖 선수는 데려올 수 없다 (#244 계약 유지)", async ({ page }) => {
    await openHalftime(page);
    for (const id of ["pool-sheet-open", "auto-fill", "auto-fill-top", "board-reset", "board-empty-auto"]) {
      await expect(page.getByTestId(id), `${id} 는 감독시간에 없어야 한다`).toHaveCount(0);
    }
    // 자리 바꾸기 모드에서도 벤치 줄은 펴지지 않는다(선발끼리만 — 벤치는 교체 소관)
    await page.getByTestId("halftime-mode-move").click();
    await expect(page.getByTestId("board-bench-section")).toHaveCount(0);
    // 선수를 골라도 [이 자리 선수 바꾸기](= 보유 선수 시트)는 없다
    await page.getByTestId("halftime-mode-say").click();
    await page.getByTestId("token-MF1").click();
    await expect(page.getByTestId("rail-swap-player")).toHaveCount(0);
    await expect(page.getByTestId("pool-sheet")).toHaveCount(0);
  });
});
