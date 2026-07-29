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

/* ── 감독시간 뷰포트 스윕 계약 (2R blocker-1 회귀 방지) ────────────────────────────────────
 *
 * **왜 여기 있나**: #244 AC13 뷰포트 스윕은 **덱·브리핑만** 본다. 감독시간은 어느 스펙도
 * 뷰포트별로 재지 않아서, #276 이 포메이션 셀렉트를 압축 바에 얹으며 바 높이를 36→67px 로
 * 키웠을 때 **360×740 기본 모드에서 팀 프롬프트 하단 7px 이 [후반 시작] 밑으로 잘린** 것을
 * 리포 테스트 어느 것도 잡지 못했다(2R 독립검증이 대조군 실측으로 잡음). 같은 결함 클래스는
 * 이미 #244 에서 한 번 FAIL 받아 고쳤던 것이다 — 계약이 없으면 다시 돌아온다.
 *
 * 재는 것(모드 3개 × 지원 뷰포트 3개):
 *   ① 팀 프롬프트 하단이 [후반 시작] 상단을 **넘지 않는다**(겹침 ≤ 0)
 *   ② `elementFromPoint` 4점(중심 + 하단 좌·중·우)이 **자기 자신**을 반환한다(버튼이 덮지 않는다)
 *   ③ 가로 오버플로 0
 * ⚠️ 좌표만 보지 않는 이유는 p244 와 같다 — top<fold 만 보면 절반이 잘려도 통과한다.
 */
const PHONES = [
  { width: 360, height: 740, name: "360x740(갤럭시)" },
  { width: 390, height: 844, name: "390x844(iPhone)" },
  { width: 412, height: 915, name: "412x915(안드 대형)" },
];
const MODES = ["say", "sub", "move"] as const;
/** 기본 모드에서 프롬프트 아래에 남아야 할 최소 여유 — 0 으로 두면 1px 짜리 수정도 통과한다. */
const MIN_FOLD_MARGIN = 12;

/** 팀 프롬프트 vs 바닥 CTA 실측 — 좌표 + 히트테스트 + 바 높이(회귀 원인을 수치로 남긴다). */
async function promptVsCta(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="editor-team-prompt"]');
    const cta = document.querySelector('[data-testid="resume-button"]');
    const bar = document.querySelector('[data-testid="team-sheet-bar"]');
    if (!el || !cta) return { found: false } as const;
    const r = el.getBoundingClientRect();
    const c = cta.getBoundingClientRect();
    const probes = [
      { at: "center", x: r.left + r.width / 2, y: r.top + r.height / 2 },
      { at: "bottomL", x: r.left + 8, y: r.bottom - 4 },
      { at: "bottomC", x: r.left + r.width / 2, y: r.bottom - 4 },
      { at: "bottomR", x: r.right - 8, y: r.bottom - 4 },
    ];
    const hits = probes.map((p) => {
      if (p.y < 0 || p.y > window.innerHeight - 1) return { at: p.at, by: "OUT_OF_FOLD" };
      const hit = document.elementFromPoint(p.x, p.y);
      if (hit && el.contains(hit)) return { at: p.at, by: "self" };
      return {
        at: p.at,
        by: hit ? (hit.closest("[data-testid]")?.getAttribute("data-testid") ?? hit.tagName) : "null",
      };
    });
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
    return {
      found: true as const,
      barH: bar ? Math.round(bar.getBoundingClientRect().height) : -1,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : 0,
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      ctaTop: Math.round(c.top),
      /** >0 이면 프롬프트가 CTA 아래로 밀려 잘렸다(= blocker-1). */
      overlap: Math.round(r.bottom - c.top),
      hits,
      blocked: hits.filter((h) => h.by !== "self"),
      hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

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

/**
 * #276 감독시간 **뷰포트 스윕** — 프롬프트는 어느 폰·어느 모드에서도 CTA 에 잘리지 않는다.
 *
 * 2R 독립검증 blocker-1 의 계약. 실측 재현(픽스 전, 360x740 / say 모드):
 *   barH 67 · prompt bottom 624 · CTA top 617 · 겹침 **7px** · 하단 히트 `BUTTON`
 * 폴백(구 매치 = #244 골격)은 같은 화면에서 barH 36 · bottom 593 · 겹침 0 이었다 —
 * 즉 회귀의 원인은 **압축 바가 한 줄 늘어난 것**이고, 이 스펙은 그 줄이 다시 늘면 red 가 된다.
 */
test.describe("#276 감독시간 뷰포트 스윕 — 프롬프트가 CTA 에 잘리지 않는다", () => {
  for (const vp of PHONES) {
    test(`AC7 ${vp.name}: say/sub/move 세 모드에서 팀 프롬프트가 가림 없이 보인다`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openHalftime(page);
      await expect(page.getByTestId("editor-team-prompt")).toBeVisible();

      const rows: Array<{ mode: string; box: Awaited<ReturnType<typeof promptVsCta>> }> = [];
      for (const mode of MODES) {
        if (mode !== "say") await page.getByTestId(`halftime-mode-${mode}`).click();
        else await page.getByTestId("halftime-mode-say").click();
        // 모드 전환에는 오토스크롤(#244 A')이 걸린다 — 멈춘 뒤에 잰다.
        await page.waitForTimeout(700);
        const box = await promptVsCta(page);
        rows.push({ mode, box });
        console.log(`[p276-sweep] ${vp.name} ${mode}`, JSON.stringify(box));
        await page.screenshot({ path: `${SMOKE_DIR}p276-sweep-${vp.width}x${vp.height}-${mode}.png` });
      }

      for (const { mode, box } of rows) {
        const label = `${vp.name} ${mode}`;
        expect(box.found, `${label}: 팀 프롬프트가 DOM 에 없다`).toBe(true);
        if (!box.found) continue;
        expect(
          box.overlap,
          `${label}: 프롬프트 하단(${box.bottom})이 [후반 시작] 상단(${box.ctaTop})을 ${box.overlap}px 넘었다 — 시트 바 ${box.barH}px`,
        ).toBeLessThanOrEqual(0);
        expect(
          box.blocked,
          `${label}: 프롬프트가 가려 실제로는 안 보인다 — ${JSON.stringify(box.hits)}`,
        ).toEqual([]);
        expect(box.hOverflow, `${label}: 가로 오버플로`).toBe(0);
        /*
         * **기본 모드(say)는 스크롤 0 에서 여유까지 본다.** blocker 는 정확히 이 상태에서 났고,
         * 겹침 0 만 재면 여유 1px 짜리 수정도 green 이라 다음 한 줄에 그대로 다시 깨진다
         * (#244 가 `MIN_MARGIN` 을 둔 이유와 같다). sub/move 는 모드 전환 오토스크롤(#244 A')이
         * 프롬프트를 스크롤 바닥에 정렬시키므로 여유가 0 인 게 정상이다 — 겹침만 본다.
         */
        if (mode === "say") {
          expect(box.scrollTop, `${label}: 기본 모드는 스크롤 없이 판정한다`).toBe(0);
          expect(
            -box.overlap,
            `${label}: 프롬프트 아래 여유가 ${-box.overlap}px 뿐이다(최소 ${MIN_FOLD_MARGIN}px) — 시트 바 ${box.barH}px`,
          ).toBeGreaterThanOrEqual(MIN_FOLD_MARGIN);
        }
      }
    });
  }
});

/**
 * #276 감독시간 **드래그** — [자리] 탭에서 살아 있고, 잠금 규칙은 계약으로 박제한다.
 *
 * 2R 독립검증 두 건을 한 곳에서 수습한다:
 *   · minor-2 **어포던스 역전** — `boardMode` 가 있으면 무조건 드래그를 끄던 탓에 [감독의 한마디]
 *     탭에서는 드래그로 자리가 바뀌는데 **[자리] 탭에서만** 안 바뀌었다. 덱은 "탭이 1급, 드래그는
 *     보조"(#106)이므로 자리 전용 탭에서 보조 제스처가 죽으면 안 된다.
 *   · minor-1 **계약 없는 잠금** — `DeckEditor` 의 잠금 블록을 통째로 지워도 리포 테스트 458개 중
 *     0개가 죽었다(검증자 MV-D). 지금 안전한 건 `hideBench` 와의 **결합** 덕이라, 그 결합이 깨지면
 *     아무도 못 잡는다. 아래 세 계약이 그 블록(과 교체 모드 가드)을 직접 겨눈다.
 *
 * ⚠️ 뷰포트가 세로로 넉넉해야 보드 전체가 한 화면에 들어와 마우스 드래그가 성립한다
 * (deck-list-dnd.spec.ts 와 같은 인공 조건 — 여기서 재는 것은 **포인터 경로의 규칙**이지
 *  폰 레이아웃이 아니다. 폰 레이아웃은 위 AC7 스윕이 본다).
 */
const DRAG_VIEWPORT = { width: 390, height: 1400 };

/** @dnd-kit MouseSensor(distance:6) 드래그 — 눌러서 6px 넘긴 뒤 타깃 중심으로 활공. */
async function pointerDrag(page: Page, sourceTestId: string, targetTestId: string) {
  const src = await page.getByTestId(sourceTestId).boundingBox();
  const dst = await page.getByTestId(targetTestId).boundingBox();
  if (!src || !dst) throw new Error(`missing box: ${sourceTestId} / ${targetTestId}`);
  const sx = src.x + src.width / 2, sy = src.y + src.height / 2;
  const dx = dst.x + dst.width / 2, dy = dst.y + dst.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 10, sy + 10);
  await page.mouse.move(dx, dy, { steps: 14 });
  await page.mouse.move(dx, dy);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

test.describe("#276 감독시간 드래그 — [자리] 탭 어포던스 + 잠금 계약", () => {
  test.use({ viewport: DRAG_VIEWPORT });

  test("AC8 [자리] 탭에서 선발↔선발 드래그로 자리가 바뀌고 그대로 전송된다 (어포던스 역전 금지)", async ({ page }) => {
    const bodies = await openHalftime(page);
    await page.getByTestId("halftime-mode-move").click();
    await expect(page.getByTestId("board-slot-starter-9")).toContainText("공격하나"); // FW1
    await expect(page.getByTestId("board-slot-starter-10")).toContainText("공격둘"); // FW2

    await pointerDrag(page, "token-FW1", "board-slot-starter-10");

    await expect(page.getByTestId("board-slot-starter-10")).toContainText("공격하나");
    await expect(page.getByTestId("board-slot-starter-9")).toContainText("공격둘");
    await page.screenshot({ path: `${SMOKE_DIR}p276-drag-move-tab.png` });

    await page.getByTestId("resume-button").click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(slotOf(bodies[0]!, "FW1")).toBe(10);
    expect(slotOf(bodies[0]!, "FW2")).toBe(9);
  });

  /**
   * 교체 탭에서는 드래그가 **아예 들지 않는다**. 두 축이 각각 이유가 있다:
   *   · 벤치 → 선발 = **교체**이고 교체는 규칙(≤3 · GK≥1)을 가진 명시 목록(`subs`)이 소유한다.
   *     드래그가 그 일을 하면 규칙을 우회하는 두 번째 손잡이가 된다.
   *   · 선발 ↔ 선발 = 자리 바꾸기인데, 교체 탭의 탭 제스처는 "뺄 선수 지정"이다. 같은 보드에서
   *     탭과 드래그가 서로 다른 일을 하면 모드 자체가 흐려진다 — 자리는 [자리] 탭이 소유한다.
   */
  test("AC8-b 교체 탭에서는 드래그가 들지 않는다 (벤치→선발 · 선발↔선발 둘 다)", async ({ page }) => {
    const bodies = await openHalftime(page);
    await page.getByTestId("halftime-mode-sub").click();
    await expect(page.getByTestId("board-bench-section")).toBeVisible();

    await pointerDrag(page, "token-SUB1", "board-slot-starter-0");

    // 선발 0 번은 그대로 골키퍼, 교체 칩도 생기지 않는다(드래그는 교체를 만들지 않는다).
    await expect(page.getByTestId("board-slot-starter-0")).toContainText("골리원");
    await expect(page.getByTestId("sub-chip-0")).toHaveCount(0);

    // 선발끼리도 마찬가지 — 자리는 [자리] 탭이 소유한다.
    await pointerDrag(page, "token-FW1", "board-slot-starter-10");
    await expect(page.getByTestId("board-slot-starter-9")).toContainText("공격하나");
    await expect(page.getByTestId("board-slot-starter-10")).toContainText("공격둘");

    await page.getByTestId("resume-button").click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]!.substitutions).toEqual([]);
    expect(slotOf(bodies[0]!, "GK1")).toBe(0);
    expect(slotOf(bodies[0]!, "FW1")).toBe(9);
    expect(bodies[0]!.starters!.some((s) => s.playerId === "SUB1")).toBe(false);
  });

  test("AC8-c 만료되면 드래그도 배치를 바꾸지 않는다(잠금은 한 겹이 아니다)", async ({ page }) => {
    await openHalftime(page, { remainingMs: -1_000 });
    await expect(page.getByTestId("halftime-countdown")).toContainText("감독시간 종료");

    await pointerDrag(page, "token-FW1", "board-slot-starter-10");

    await expect(page.getByTestId("board-slot-starter-9")).toContainText("공격하나");
    await expect(page.getByTestId("board-slot-starter-10")).toContainText("공격둘");
  });

  /**
   * 스냅샷 없는 구 매치는 배치를 **보낼 데가 없다**(`lineupEditable=false`). 화면에서 자리가
   * 움직이면 유저는 바뀐 줄 알지만 서버로는 아무것도 안 간다 — 화면이 거짓말을 한다.
   */
  test("AC8-d 폴백(구 매치)에서는 드래그가 배치를 바꾸지 않는다", async ({ page }) => {
    const bodies = await openHalftime(page, { snapshot: null });
    await expect(page.getByTestId("halftime-mode-move")).toHaveCount(0);
    const before = await page.getByTestId("board-slot-starter-9").textContent();

    await pointerDrag(page, "token-FW1", "board-slot-starter-10");

    await expect(page.getByTestId("board-slot-starter-9")).toHaveText(before ?? "");
    await page.getByTestId("resume-button").click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]!.starters).toBeUndefined();
  });
});
