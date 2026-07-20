import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * 팀 시트 재편 R1 (이슈 #106) route-mock 스모크 — 백엔드 없이 vite dev + page.route 로 /api 를
 * 목킹해 브라우저에서 새 골격의 계약을 박제한다:
 *   1) 시트 바 3지표(선발 n/11 · 벤치 n/7 · 지시 n/11) + 포메이션 + 전력 게이지
 *   2) 벤치 스트립이 **보드 카드 안**에 있다(별도 블록 금지)
 *   3) 선수 탭 → **선수정보 시트가 아니라 레일**이 그 선수 지시로 바뀐다 (PlayerSheet 부재)
 *   4) 프리셋 진입점 부재(슬롯 칩/요약/새 프리셋/프롬프트 프리셋)
 *   5) 탭-투-플레이스: 슬롯 탭 → 리스트 자동 필터 → 선수 탭 → 배치 (역방향도)
 *   6) 390 / 1024 / 1280px 가로 오버플로 0
 * 스크린샷 = apps/web/.smoke/.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

const P = (id: string, name: string, position: string, grade: string, overall: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(overall), personality: "CALM",
});

const PLAYERS = [
  P("GK1", "골리원", "GK", "GOLD", 70),
  P("GK2", "골리투", "GK", "SILVER", 62),
  P("DF1", "수비하나", "DF", "GOLD", 76),
  P("DF2", "수비둘", "DF", "SILVER", 68),
  P("DF3", "수비셋", "DF", "SILVER", 64),
  P("DF4", "수비넷", "DF", "BRONZE", 55),
  P("MF1", "미드하나", "MF", "DIA", 84),
  P("MF2", "미드둘", "MF", "GOLD", 74),
  P("MF3", "미드셋", "MF", "SILVER", 66),
  P("MF4", "미드넷", "MF", "SILVER", 61),
  P("FW1", "공격하나", "FW", "LEGEND", 90),
  P("FW2", "공격둘", "FW", "GOLD", 72),
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * 상태형 목. ⚠️ 라우트 매칭은 **오리진 앵커**(url.pathname 비교)로 한다 — 상대 글롭("**\/api/...")은
 * vite dev 의 다른 오리진 요청까지 삼켜 흰 화면이 된다(실적 있음).
 */
interface DeckPut {
  formation: string;
  slots: Array<{ playerId: string; role: string; slotIndex: number; promptText: string | null }>;
}

async function mockApi(page: Page, deckSlots: unknown[] = [], puts: DeckPut[] = []) {
  const state = { deck: { formation: "4-4-2", slots: deckSlots } };
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    route.fulfill(json({ GK1: 0.9, MF1: 0.5, FW1: 0.2 })),
  );
  await page.route((url) => url.pathname === "/api/deck", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      state.deck = { formation: body.formation, slots: body.slots };
      puts.push(body as DeckPut);
    }
    return route.fulfill(json(state.deck));
  });
}

/** 선발 11 + 벤치 2 (지시 2명) — 지표/레일 검수용 시드 덱. */
function seededDeck() {
  const ids = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1", "FW2"];
  return [
    ...ids.map((playerId, i) => ({
      playerId,
      role: "starter",
      slotIndex: i,
      promptText: playerId === "MF1" ? "안쪽으로 파고들어라" : playerId === "FW1" ? "과감하게 슛" : null,
    })),
    { playerId: "GK2", role: "bench", slotIndex: 0, promptText: null },
  ];
}

async function openDeck(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
}

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("R1 팀 시트 골격: 시트 바 3지표 · 벤치 in 보드카드 · 프리셋 진입점 부재", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  // 1) 시트 바 3지표
  await expect(page.getByTestId("starter-count")).toHaveText("선발 11/11");
  await expect(page.getByTestId("bench-count")).toHaveText("벤치 1/7");
  await expect(page.getByTestId("directive-count")).toContainText("지시 2/11");
  await expect(page.getByTestId("formation-select")).toHaveValue("4-4-2");
  await expect(page.getByTestId("sheet-power")).toBeVisible();

  // 2) 벤치가 보드 카드 안 (DOM 포함 관계 실측)
  const benchInsideCard = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="board-card"]')!;
    const bench = document.querySelector('[data-testid="board-bench-section"]')!;
    return card.contains(bench);
  });
  expect(benchInsideCard, "벤치는 보드 카드 안에 있어야 한다(#106)").toBe(true);

  // 3) 프리셋 진입점 부재
  for (const id of ["slot-selector", "slot-chip-1", "slot-new-button", "preset-summary", "preset-create"]) {
    await expect(page.getByTestId(id), `${id} 는 화면에 없어야 한다`).toHaveCount(0);
  }

  await page.screenshot({ path: `${SMOKE_DIR}r1-teamsheet-390.png`, fullPage: true });
});

test("R1 선수 탭 → 선수정보 시트가 아니라 지시 레일이 바뀐다", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);

  // 선택 없음 → 팀 지시
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "team");
  await expect(page.getByTestId("rail-title")).toHaveText("팀 지시");
  await expect(page.getByTestId("editor-team-prompt")).toBeVisible();

  // MF1 토큰 탭 → 레일이 그 선수로
  await page.getByTestId("token-MF1").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "player");
  await expect(page.getByTestId("rail-title")).toHaveText("미드하나");
  await expect(page.getByTestId("rail-subtitle")).toContainText("MF");
  await expect(page.getByTestId("rail-prompt-input")).toHaveValue("안쪽으로 파고들어라");
  // 구 선수정보 시트는 뜨지 않는다
  await expect(page.getByTestId("player-sheet")).toHaveCount(0);
  await expect(page.getByTestId("sheet-prompt-input")).toHaveCount(0);
  // 보드는 그대로 보인다(맥락 유지)
  await expect(page.getByTestId("tactics-board")).toBeVisible();
  await page.screenshot({ path: `${SMOKE_DIR}r1-rail-player-1280.png`, fullPage: true });

  // 닫기 → 팀 지시 복귀
  await page.getByTestId("rail-close").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "team");
});

test("R1 탭-투-플레이스: 슬롯 탭 → 자동 필터 → 선수 탭 → 배치 (역방향 포함)", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, []); // 빈 덱
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  await expect(page.getByTestId("starter-count")).toHaveText("선발 0/11");

  // 정방향: MF 슬롯(slotIndex 6) 탭 → 리스트가 MF 로 자동 필터
  await page.getByTestId("board-slot-starter-6").click();
  await expect(page.getByTestId("picker-filter-MF")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("picker-sort-note")).toContainText("MF");
  // 그 포지션 추천순 1위(MF1=84) 탭 → 배치
  await page.getByTestId("pick-MF1").click();
  await expect(page.getByTestId("board-slot-starter-6")).toHaveAttribute("data-filled", "true");
  await expect(page.getByTestId("starter-count")).toHaveText("선발 1/11");
  await expect(page.getByTestId("rail-title")).toHaveText("미드하나");

  // 배치 대기는 보드 바의 명시적 [취소]로 되돌릴 수 있다(모바일 독이 접혀 있어도 취소 가능)
  await page.getByTestId("picker-filter-FW").click();
  await page.getByTestId("pick-FW2").click();
  await expect(page.getByTestId("place-pending-hint")).toContainText("공격둘");
  await page.getByTestId("place-cancel").click();
  await expect(page.getByTestId("place-cancel")).toHaveCount(0);
  await expect(page.getByTestId("pick-FW2")).toHaveAttribute("data-pending", "false");

  // 역방향: 선수 먼저 탭 → 슬롯 탭
  await page.getByTestId("picker-filter-GK").click();
  await page.getByTestId("pick-GK1").click();
  await expect(page.getByTestId("pick-GK1")).toHaveAttribute("data-pending", "true");
  await expect(page.getByTestId("starter-count")).toHaveText("선발 1/11"); // 아직 배치 전
  await page.getByTestId("board-slot-starter-0").click();
  await expect(page.getByTestId("starter-count")).toHaveText("선발 2/11");
  await expect(page.getByTestId("board-slot-starter-0")).toHaveAttribute("data-filled", "true");

  // 토큰↔토큰 = 자리 교체 (직전 배치로 남아있는 선택은 레일 닫기로 비운다)
  await page.getByTestId("rail-close").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "team");
  await page.getByTestId("token-MF1").click();
  await page.getByTestId("board-slot-starter-0").click();
  await expect(page.getByTestId("board-slot-starter-0").getByTestId("token-MF1")).toBeVisible();
  await expect(page.getByTestId("board-slot-starter-6").getByTestId("token-GK1")).toBeVisible();
  await expect(page.getByTestId("starter-count")).toHaveText("선발 2/11");

  await page.screenshot({ path: `${SMOKE_DIR}r1-tap-place-390.png`, fullPage: true });
});

/**
 * R2 A안의 핵심 계약: `AI에 전달될 지시문` 미리보기 두 줄을 이어붙인 것이 **서버로 실제 PUT 되는
 * promptText 와 글자 단위로 같다**. 여기서 어긋나면 "기존 포맷 위에 프롬프트가 extend" 라는 화면의
 * 주장이 거짓이 된다 → 브라우저 실물로 박제한다.
 */
test("R2 지시 레일 A안: 역할·칩·한마디 → 미리보기 = 실제 저장 문자열", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  const puts: DeckPut[] = [];
  await mockApi(page, seededDeck(), puts);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);

  await page.getByTestId("token-FW2").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "player");
  // 아무 지시도 없을 땐 빈 상태
  await expect(page.getByTestId("rail-compose-empty")).toBeVisible();

  // ① 익숙한 포맷: 역할 세그먼트 + 세부 지시 칩
  await page.getByTestId("rail-role-attack").click();
  await expect(page.getByTestId("rail-role-attack")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("rail-chip-overlap").click();
  await page.getByTestId("rail-chip-runbehind").click();
  // ② 그 위에 얹는 자유 문장
  const own = "오넬이 벌려주면 너는 안쪽으로 파고들어라. 상대 오른쪽 풀백이 느리다";
  await page.getByTestId("rail-prompt-input").fill(own);

  // ③ 미리보기는 두 출처를 **구분해서** 보여준다
  const directiveLine = (await page.getByTestId("rail-compose-directive").textContent())!;
  const ownLine = (await page.getByTestId("rail-compose-own").textContent())!;
  expect(directiveLine).toContain("공격 가담");
  expect(directiveLine).toContain("오버랩");
  expect(directiveLine, "합성문에 내 문장이 섞이면 레이어 구분이 무너진다").not.toContain("풀백");
  expect(ownLine).toBe(own);
  // 라벨로도 출처가 읽힌다(단색 스킨이라 색 대신 라벨/구분선으로 가른다)
  await expect(page.getByTestId("rail-compose")).toContainText("선택지에서");
  await expect(page.getByTestId("rail-compose")).toContainText("내가 쓴 문장");
  await page.screenshot({ path: `${SMOKE_DIR}r2-rail-compose-1280.png`, fullPage: true });

  // ④ 저장 → PUT 바디의 promptText 가 미리보기 두 줄과 동일
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();
  expect(puts.length).toBe(1);
  const sent = puts[0]!.slots.find((s) => s.playerId === "FW2")!.promptText;
  console.log(`[smoke] PUT promptText = ${JSON.stringify(sent)}`);
  expect(sent).toBe(`${directiveLine}\n${ownLine}`);

  // ⑤ 재진입(다른 선수 갔다 오기) 후에도 레이어가 복원되고 문자열이 그대로다
  await page.getByTestId("rail-close").click();
  await page.getByTestId("token-FW2").click();
  await expect(page.getByTestId("rail-chip-overlap")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("rail-role-attack")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("rail-prompt-input")).toHaveValue(own);
  await expect(page.getByTestId("rail-compose-own")).toHaveText(own);
});

test("R2 팀 지시: 5스텝 세그먼트 → 계약값 0/.25/.5/.75/1 로 저장", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  await page.getByTestId("rail-dock-toggle").click(); // 모바일 독 펼치기
  // 슬라이더가 아니다 — 5버튼 세그먼트
  await expect(page.getByTestId("tactics-press").locator("button")).toHaveCount(5);
  await expect(page.getByTestId("tactics-press-step-2")).toHaveAttribute("aria-pressed", "true"); // 기본 0.5

  await page.getByTestId("tactics-press-step-4").click();
  await expect(page.getByTestId("tactics-press")).toHaveAttribute("data-value", "1");
  await page.getByTestId("tactics-line-step-1").click();
  await expect(page.getByTestId("tactics-line")).toHaveAttribute("data-value", "0.25");
  await expect(page.getByTestId("tactics-tempo")).toHaveAttribute("data-value", "0.5"); // 나머지는 그대로

  await page.screenshot({ path: `${SMOKE_DIR}r2-team-steps-390.png`, fullPage: true });
});

/**
 * ⚠️ 픽스처는 **선발 11 이 채워진 정상 상태**여야 한다(R2 검증 blocker-1).
 * 빈 덱(`mockApi(page, [])`)은 문서가 길어 스크롤 여유(312px)가 생기는 **비현실 상태**라, 펼친 독에
 * 가려 사람이 절대 못 누르는 버튼도 Playwright 자동 스크롤로 green 이 났다 —
 * "E2E 는 통과하는데 사람은 못 함"(#106 을 열게 만든 실패 유형)의 재발.
 */
test("R2 r1: 배치 직후 토큰을 **한 번** 탭하면 그 선수 지시가 열린다(정상 덱 · 390)", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck()); // 선발 11/벤치 1 = 실사용 상태
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  // 리스트에서 배치 → 그 자리에 있던 선수와 교체되며 선택이 남는다(독은 접힌 채)
  await page.getByTestId("board-slot-starter-6").click();
  await expect(page.getByTestId("rail-dock")).toHaveAttribute("data-open", "true");
  await page.getByTestId("rail-close").click();

  // 방금 만진 토큰을 1탭 → 팀 지시로 튕기지 않고 그 선수 지시가 열린다
  await page.getByTestId("token-MF1").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "player");
  await expect(page.getByTestId("rail-title")).toHaveText("미드하나");
  await expect(page.getByTestId("rail-dock")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("rail-prompt-input")).toBeVisible();

  // 독이 펼쳐진 상태에서도 보드 하단 바 버튼이 **실제로** 눌려야 한다(가려지면 안 된다).
  // hit-test 로 먼저 못박는다 — Playwright 자동 스크롤이 가림을 숨기지 못하도록,
  // 스크롤 후 그 좌표의 최상단 엘리먼트가 그 버튼 자신인지 본다.
  for (const id of ["board-reset", "select-clear"]) {
    // 사람이 하는 것과 같은 동작: 그 버튼이 보이도록 페이지를 스크롤한다.
    // (`scrollIntoViewIfNeeded` 는 "뷰포트 안"이면 아무것도 안 해서 가림을 못 드러낸다 — 실제로
    //  이 버튼들은 뷰포트 안이면서 독 **아래**에 깔려 있었다. block:"start" 로 독 위까지 올린다.)
    await page.evaluate((testId) => {
      document.querySelector(`[data-testid="${testId}"]`)!.scrollIntoView({ block: "start" });
      // sticky 시트 바(상단)와 독(하단) 사이의 빈 띠로 내린다 — 실사용의 "조금 스크롤해서 누른다".
      window.scrollBy(0, -200);
    }, id);
    await page.waitForTimeout(120);
    const top = await page.evaluate((testId) => {
      const b = document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { tag: hit?.tagName ?? "none", isSelf: hit?.closest(`[data-testid="${testId}"]`) != null };
    }, id);
    console.log(`[smoke] ${id} hit-test → ${top.tag} isSelf=${top.isSelf}`);
    expect(top.isSelf, `${id} 가 하단 독에 가려 눌리지 않는다`).toBe(true);
    await page.screenshot({ path: `${SMOKE_DIR}r2-blocker1-${id}-390.png` }); // 뷰포트 실화면(증적)
  }

  // 해제는 보드 바 [선택 해제] 로 (독 안의 레일 × 와 동치)
  await page.getByTestId("select-clear").click({ timeout: 8000 });
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "team");
});

test("R2 r3: 모바일 최대 스크롤에서 죽은 공간 없음 + 접힌 독이 리스트를 가리지 않는다", async ({ page }) => {
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  // 적대적으로: **선수 컨텍스트**(성격 배지·신뢰 게이지로 헤드가 더 두꺼운 상태)에서 독을 접고 잰다.
  await page.getByTestId("token-MF1").click();
  await page.getByTestId("rail-dock-toggle").click(); // 접기 = 클리어런스 계약 상태
  await expect(page.getByTestId("rail-dock")).toHaveAttribute("data-open", "false");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(150);
  const m = await page.evaluate(() => {
    const dock = document.querySelector('[data-testid="rail-dock"]')!.getBoundingClientRect();
    const pool = document.querySelector('[data-testid="player-pool"]')!.getBoundingClientRect();
    return {
      dockTop: dock.top,
      dockHeight: dock.height,
      poolBottom: pool.bottom,
      gap: dock.top - pool.bottom,
    };
  });
  console.log(`[smoke] r3 dockH=${m.dockHeight.toFixed(1)} gap(pool→dock)=${m.gap.toFixed(1)}`);
  expect(m.gap, "리스트 카드가 접힌 독에 가려지면 안 된다").toBeGreaterThanOrEqual(0);
  // 132px(poolCol) + 140px(notes) 이중 여백이던 시절 실측 ~160px → 클리어런스 한 곳으로 정리.
  // 상한은 "죽은 공간 없음", 하한은 "가림 여유 있음"(m4 계열 취약점 방지) 둘 다 건다.
  expect(m.gap, "최대 스크롤에서 죽은 공간(리스트↔독)이 과하면 안 된다").toBeLessThanOrEqual(48);
  expect(m.gap, "클리어런스가 0에 붙어 있으면 헤드가 조금만 커져도 다시 가려진다").toBeGreaterThanOrEqual(12);
});

test("R1 반응형: 390 / 1024 / 1280px 가로 오버플로 0", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck());
  await openDeck(page);

  for (const width of [390, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(180);
    const overflow = await overflowPx(page);
    console.log(`[smoke] ${width}px horizontal overflow px = ${overflow}`);
    expect(overflow, `${width}px 가로 오버플로`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SMOKE_DIR}r1-teamsheet-${width}.png`, fullPage: true });
  }

  // 데스크탑에서는 레일이 우측 고정 컬럼(보드 오른쪽)에 있다.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(180);
  const geom = await page.evaluate(() => {
    const board = document.querySelector('[data-testid="board-card"]')!.getBoundingClientRect();
    const rail = document.querySelector('[data-testid="directive-rail"]')!.getBoundingClientRect();
    return { boardRight: board.right, railLeft: rail.left };
  });
  expect(geom.railLeft).toBeGreaterThanOrEqual(geom.boardRight - 1);
});

/**
 * ── R3a m1 (데이터 손실) ───────────────────────────────────────────────────────────────────
 * 감독의 한마디에 **카탈로그와 똑같은 문장**을 쓰면(우연 일치) 재진입 때 칩으로 인식된다 —
 * 저장 포맷이 단일 문자열(서버 계약)이라 문자열만으로는 구별이 불가능해서 이건 못 없앤다.
 * 계약은 그래서 "칩을 꺼도 **유저 문장이 소리 없이 사라지지 않는다**": 사라진 문장을 보여주고
 * 한 번에 되돌릴 수 있어야 하며, 되돌리면 저장 문자열이 **글자 단위로** 원복돼야 한다.
 */
test("R3a m1: 우연히 카탈로그와 같은 한마디 → 재진입 → 칩 끄기 → 문장이 사라지지 않는다", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  const puts: DeckPut[] = [];
  await mockApi(page, seededDeck(), puts);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);

  const typed = "높은 위치에서 강하게 압박한다.";
  await page.getByTestId("token-FW2").click();
  await page.getByTestId("rail-prompt-input").fill(typed);
  await expect(page.getByTestId("rail-compose-own")).toHaveText(typed);
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();
  expect(puts[0]!.slots.find((s) => s.playerId === "FW2")!.promptText).toBe(typed);

  // 재진입(새로고침) — 문자열만 보고는 구별 불가라 압박 칩이 켜진 채 복원된다(불가피).
  await page.reload();
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await page.getByTestId("token-FW2").click();
  await expect(page.getByTestId("rail-chip-press")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("rail-prompt-input")).toHaveValue("");

  // 칩을 끄면 → 그 문장이 **즉시 감독의 한마디로 이동**한다(사후 복구 버튼 없음 = 놓칠 경로 없음)
  await page.getByTestId("rail-chip-press").click();
  await expect(page.getByTestId("rail-moved")).toBeVisible();
  await expect(page.getByTestId("rail-moved-phrase")).toContainText("높은 위치에서 강하게 압박한다");
  await page.screenshot({ path: `${SMOKE_DIR}r3a-m1-dropped-1280.png`, fullPage: true });

  await expect(page.getByTestId("rail-prompt-input")).toHaveValue(typed);
  await expect(page.getByTestId("rail-compose-own")).toHaveText(typed);
  await expect(page.getByTestId("rail-chip-press")).toHaveAttribute("aria-pressed", "false");

  // 저장 문자열이 글자 단위로 원복된다(왕복 무손실)
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();
  const sent = puts[puts.length - 1]!.slots.find((s) => s.playerId === "FW2")!.promptText;
  console.log(`[smoke] m1 restored promptText = ${JSON.stringify(sent)}`);
  expect(sent).toBe(typed);
});

test("R3a m1: 이번 세션에 직접 켠 칩을 끄는 건 안내를 띄우지 않는다(잡음 금지)", async ({ page }) => {
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);

  await page.getByTestId("token-FW2").click();
  await page.getByTestId("rail-chip-press").click();
  await expect(page.getByTestId("rail-compose-directive")).toContainText("압박");
  await page.getByTestId("rail-chip-press").click();
  await expect(page.getByTestId("rail-moved")).toHaveCount(0);
  await expect(page.getByTestId("rail-compose-empty")).toBeVisible();
});

/**
 * ── R3a r2/m5 (모바일 마감) ───────────────────────────────────────────────────────────────
 * 390 에서 펼친 독은 화면 절반을 덮는다. **판정 기준 두 가지**를 브라우저 실물로 박제한다:
 *   ① 지시를 쓰는 동안 "지금 누구에게 쓰는지" 를 알 수 있다 — 레일 헤드 신원 + 보드의 그 토큰이
 *      실제로 **가려지지 않는다**(독을 펼칠 때 가시 띠로 오토스크롤).
 *   ② A안의 핵심 전달물 `AI에 전달될 지시문` 두 줄에 **추가 스크롤 없이** 도달한다
 *      (독 스크롤러 바닥 sticky).
 * 가림 여부는 좌표가 아니라 `elementFromPoint` 히트테스트로 본다(자동 스크롤이 가림을 숨기지 못하게).
 */
test("R3a r2/m5: 390 펼친 독 — 대상 식별 + `AI에 전달될 지시문` 도달(스크롤 없이)", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  const hit = (testId: string) =>
    page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return { found: false, isSelf: false, top: 0, bottom: 0 };
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { found: true, isSelf: at?.closest(`[data-testid="${id}"]`) != null, top: r.top, bottom: r.bottom };
    }, testId);

  for (const [playerId, name] of [["GK1", "골리원"], ["MF1", "미드하나"], ["FW1", "공격하나"]] as const) {
    await page.getByTestId(`token-${playerId}`).click();
    await expect(page.getByTestId("rail-dock")).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("rail-title")).toHaveText(name);
    await page.waitForTimeout(150);

    // ① 누구에게 쓰는지: 레일 헤드(위)뿐 아니라 보드의 그 토큰이 실제로 보인다
    const token = await hit(`token-${playerId}`);
    console.log(`[smoke] ${playerId} token visible=${token.isSelf} top=${token.top.toFixed(0)}`);
    expect(token.isSelf, `${playerId} 토큰이 펼친 독/시트 바에 가려 대상이 안 보인다`).toBe(true);

    // ② 미리보기 도달: 두 줄이 있는 상태로 만들고 히트테스트(독 안 추가 스크롤 없이)
    await page.getByTestId("rail-chip-press").click();
    await page.getByTestId("rail-prompt-input").fill("오늘 너만 믿는다");
    const cap = await hit("rail-compose");
    const own = await hit("rail-compose-own");
    console.log(`[smoke] ${playerId} compose visible=${cap.isSelf} own=${own.isSelf} top=${cap.top.toFixed(0)}`);
    expect(cap.isSelf, "`AI에 전달될 지시문` 블록이 독 fold 아래에 묻혔다").toBe(true);
    expect(own.isSelf, "내가 쓴 문장 줄에 스크롤 없이 도달하지 못한다").toBe(true);

    await page.getByTestId("rail-close").click(); // 다음 선수로 (토큰↔토큰 탭은 자리 교체라 해제 먼저)
  }
  // 접고 → 리스트까지 스크롤 → 다시 펼치는 실사용 경로에서도 대상 토큰을 되찾아온다
  await page.getByTestId("token-MF1").click();
  await page.getByTestId("rail-dock-toggle").click(); // 접기
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(150);
  const hidden = await hit("token-MF1");
  console.log(`[smoke] 스크롤 후(접힘) MF1 보임=${hidden.isSelf} top=${hidden.top.toFixed(0)}`);
  await page.getByTestId("rail-dock-toggle").click(); // 다시 펼치기 → 오토스크롤
  await page.waitForTimeout(200);
  const regained = await hit("token-MF1");
  console.log(`[smoke] 재펼침 후 MF1 보임=${regained.isSelf} top=${regained.top.toFixed(0)}`);
  expect(regained.isSelf, "독을 다시 펼쳤을 때 대상 토큰이 화면에 없다").toBe(true);
  await page.screenshot({ path: `${SMOKE_DIR}r3a-dock-390.png` });
});

/**
 * R3a m6/m7 — 펼친 독의 문서 런웨이를 60vh 고정치에서 **실측치**로 바꾼 효과.
 * (착수 시점 실측: 최대 스크롤 죽은 띠 175px / 접힘 점프 507px.)
 */
test("R3a m6/m7: 펼친 독 최대 스크롤 죽은 띠 축소 + 접힘 점프 축소", async ({ page }) => {
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  await page.getByTestId("token-MF1").click();
  await expect(page.getByTestId("rail-dock")).toHaveAttribute("data-open", "true");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);

  const gap = await page.evaluate(() => {
    const dock = document.querySelector('[data-testid="rail-dock"]')!.getBoundingClientRect();
    const pool = document.querySelector('[data-testid="player-pool"]')!.getBoundingClientRect();
    return dock.top - pool.bottom;
  });
  console.log(`[smoke] m6 펼친 독 최대 스크롤 죽은 띠 = ${gap.toFixed(1)}px (착수 시점 175.4)`);
  expect(gap, "리스트가 펼친 독에 가려지면 안 된다").toBeGreaterThanOrEqual(0);
  expect(gap, "펼친 독 최대 스크롤의 죽은 띠").toBeLessThanOrEqual(24);

  const before = await page.evaluate(() => window.scrollY);
  await page.getByTestId("rail-dock-toggle").click();
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => window.scrollY);
  console.log(`[smoke] m7 접힘 점프 = ${before - after}px (착수 시점 507)`);
  expect(before - after, "접을 때 스크롤 점프").toBeLessThan(400);
});

/** m1 안내는 **폰에서도 보여야** 한다(데이터는 이미 안전하지만, 무슨 일이 있었는지 알려야 한다). */
test("R3a m1 × 모바일: 390 에서 문장이 한마디로 옮겨지고 안내가 독 안에 보인다", async ({ page }) => {
  const seeded = seededDeck().map((s) =>
    s.playerId === "MF1" ? { ...s, promptText: "높은 위치에서 강하게 압박한다." } : s,
  );
  await mockApi(page, seeded);
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  await page.getByTestId("token-MF1").click();
  await expect(page.getByTestId("rail-chip-press")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("rail-chip-press").click();
  await page.waitForTimeout(200);

  const hit = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="rail-moved"]')!.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { isSelf: at?.closest('[data-testid="rail-moved"]') != null, top: r.top };
  });
  console.log(`[smoke] m1 모바일 안내 보임=${hit.isSelf} top=${hit.top.toFixed(0)}`);
  expect(hit.isSelf, "안내가 독 fold 아래에 묻혔다").toBe(true);
  await page.screenshot({ path: `${SMOKE_DIR}r3a-m1-dropped-390.png` });

  await expect(page.getByTestId("rail-prompt-input")).toHaveValue("높은 위치에서 강하게 압박한다.");
  await expect(page.getByTestId("rail-compose-own")).toHaveText("높은 위치에서 강하게 압박한다.");
});

/**
 * ── R3a 재검증 blocker-1 재현 (브라우저 실물) ──────────────────────────────────────────────
 * 검증자 실측: 저장값 `"공격 가담을 늘려 전진한다. 수비에 집중해 위치를 지킨다."` 로 재진입해
 * 한마디에 한 글자만 쳐도 PUT 이 `"수비에 집중해 위치를 지킨다.\nㅇ"` 이 됐다 — 첫 문장이
 * **파싱 시점에** 사라져 안내 경로조차 타지 않았다. 왕복 검증 파싱으로 구조적으로 막았다.
 */
test("R3a blocker-1: 재구성 불가한 저장 문자열도 편집 후 PUT 에 원문이 전부 남는다", async ({ page }) => {
  const CASES = [
    { id: "MF1", saved: "공격 가담을 늘려 전진한다. 수비에 집중해 위치를 지킨다." }, // 역할 2개
    { id: "FW1", saved: "높은 위치에서 강하게 압박한다. 높은 위치에서 강하게 압박한다." }, // 중복 문구
  ];
  const puts: DeckPut[] = [];
  await mockApi(
    page,
    seededDeck().map((s) => {
      const hit = CASES.find((c) => c.id === s.playerId);
      return hit ? { ...s, promptText: hit.saved } : s;
    }),
    puts,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);

  for (const c of CASES) {
    await page.getByTestId(`token-${c.id}`).click();
    // 미리보기가 이미 저장값과 같아야 한다(파싱이 문장을 삼키면 여기서부터 어긋난다)
    await expect(page.getByTestId("rail-compose-own")).toHaveText(c.saved);
    await expect(page.getByTestId("rail-prompt-input")).toHaveValue(c.saved);
    await page.getByTestId("rail-prompt-input").fill(`${c.saved}\nㅇ`);
    await page.getByTestId("rail-close").click();
  }
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();

  for (const c of CASES) {
    const sent = puts[puts.length - 1]!.slots.find((s) => s.playerId === c.id)!.promptText!;
    console.log(`[smoke] blocker-1 ${c.id} PUT = ${JSON.stringify(sent)}`);
    expect(sent, `${c.id}: 저장 문장이 소실됐다`).toBe(`${c.saved}\nㅇ`);
  }
});

/**
 * ── R3a 재검증 blocker-2 재현 (브라우저 실물) ──────────────────────────────────────────────
 * 연속 해제(안내 덮어쓰기) + 안내 미소비 이탈(레일 닫고 복귀) 두 경로 모두에서 문장이 남아야 한다.
 */
test("R3a blocker-2: 연속 해제 + 안내 미소비 이탈에도 두 문장이 모두 남는다", async ({ page }) => {
  const saved = "상대 핵심 선수를 밀착 마크한다. 높은 위치에서 강하게 압박한다.";
  const puts: DeckPut[] = [];
  await mockApi(
    page,
    seededDeck().map((s) => (s.playerId === "MF1" ? { ...s, promptText: saved } : s)),
    puts,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);

  await page.getByTestId("token-MF1").click();
  await expect(page.getByTestId("rail-chip-marking")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("rail-chip-press")).toHaveAttribute("aria-pressed", "true");

  // 칩 2개 연달아 끄기 — 안내를 소비하지 않는다
  await page.getByTestId("rail-chip-marking").click();
  await page.getByTestId("rail-chip-press").click();
  // 안내 소비 없이 이탈 후 복귀
  await page.getByTestId("rail-close").click();
  await page.getByTestId("token-MF1").click();

  // 복귀하면 저장 문자열을 다시 두 레이어로 가른다(왕복 검증을 통과하는 형태면 칩으로 되돌아갈 수
  // 있다 — **손실이 아니다**). 판정은 "화면에 보이는 전문 = 저장값에 두 문장이 다 있는가"로 한다.
  const composed = (await page.getByTestId("rail-compose").textContent())!;
  const value = await page.getByTestId("rail-prompt-input").inputValue();
  console.log(`[smoke] blocker-2 한마디=${JSON.stringify(value)} 미리보기=${JSON.stringify(composed)}`);
  expect(composed).toContain("상대 핵심 선수를 밀착 마크한다");
  expect(composed).toContain("높은 위치에서 강하게 압박한다");

  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();
  const sent = puts[puts.length - 1]!.slots.find((s) => s.playerId === "MF1")!.promptText!;
  console.log(`[smoke] blocker-2 PUT = ${JSON.stringify(sent)}`);
  expect(sent).toContain("상대 핵심 선수를 밀착 마크한다");
  expect(sent).toContain("높은 위치에서 강하게 압박한다");
});
