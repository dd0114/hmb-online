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

/**
 * ⚠️ #244(프롬프트 1급) 이후 — 이 파일에서 **은퇴한 계약**과 그 이유:
 *   · 모바일 하단 독 관련 전부(`rail-dock-toggle` 여닫기, 런웨이 재측정, 접힌 독 클리어런스,
 *     펼친 독 오토스크롤, 독 핸들 44px) → **독 자체가 없어졌다**. 레일은 문서 흐름 블록이다.
 *   · 2단계 탭-투-플레이스(`place-pending-hint`/`place-cancel`, 리스트→슬롯 역방향) →
 *     **보유 선수 시트**가 흡수했다(슬롯 탭 = 그 자리에 넣을 선수 고르기).
 * 되살리려면 계약만 복원하지 말고 그 UI 를 먼저 되살려야 한다. 신규 계약 = p244-prompt-first.spec.ts.
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

test("R1→#244 슬롯 탭 → **보유 선수 시트**(포지션 자동 필터) → 배치 → 그 선수 지시", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, []); // 빈 덱
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  await expect(page.getByTestId("starter-count")).toHaveText("선발 0/11");
  // 본문에 리스트는 없다 — 선택은 시트로만(#244).
  await expect(page.getByTestId("player-pool")).toBeHidden();

  // MF 슬롯(slotIndex 6) 탭 → 시트가 MF 로 열린다
  await page.getByTestId("board-slot-starter-6").click();
  await expect(page.getByTestId("pool-sheet")).toBeVisible();
  await expect(page.getByTestId("picker-filter-MF")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("picker-sort-note")).toContainText("MF");

  // 그 포지션 추천순 1위(MF1=84) → 배치되고 시트가 닫히며 **그 선수 지시**로 이어진다
  await page.getByTestId("pick-MF1").click();
  await expect(page.getByTestId("pool-sheet")).toBeHidden();
  await expect(page.getByTestId("board-slot-starter-6")).toHaveAttribute("data-filled", "true");
  await expect(page.getByTestId("starter-count")).toHaveText("선발 1/11");
  await expect(page.getByTestId("rail-title")).toHaveText("미드하나");

  // 자리 교체 = 레일의 [이 자리 선수 바꾸기] → 같은 시트에서 **이미 배치된 선수**도 고를 수 있다
  await page.getByTestId("board-slot-starter-0").click();
  await page.getByTestId("pick-GK1").click();
  await expect(page.getByTestId("starter-count")).toHaveText("선발 2/11");
  await page.getByTestId("token-MF1").click();
  await page.getByTestId("rail-swap-player").click();
  await expect(page.getByTestId("pool-sheet")).toBeVisible();
  // 자리에서 연 시트는 그 포지션(MF)으로 필터되어 있다 → 전체로 풀고 이미 배치된 GK1 을 고른다.
  await page.getByTestId("picker-filter-ALL").click();
  await page.getByTestId("pick-GK1").click(); // 이미 0번에 있는 선수 → 6번과 자리 교체
  await expect(page.getByTestId("board-slot-starter-6").getByTestId("token-GK1")).toBeVisible();
  await expect(page.getByTestId("board-slot-starter-0").getByTestId("token-MF1")).toBeVisible();
  await expect(page.getByTestId("starter-count")).toHaveText("선발 2/11");

  await page.screenshot({ path: `${SMOKE_DIR}p244-sheet-place-390.png`, fullPage: true });
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
  await page.getByTestId("rail-tune-toggle").click(); // #244: 역할·칩은 ⚙ 뒤
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "player");
  // 아무 지시도 없을 땐 빈 상태
  await expect(page.getByTestId("rail-compose-empty")).toBeVisible();

  // ① 익숙한 포맷: 역할 세그먼트 + 세부 지시 칩
  await page.getByTestId("rail-role-attack").click();
  await expect(page.getByTestId("rail-role-attack")).toHaveAttribute("aria-checked", "true");
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
  await expect(page.getByTestId("rail-role-attack")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("rail-prompt-input")).toHaveValue(own);
  await expect(page.getByTestId("rail-compose-own")).toHaveText(own);
});

test("R2 팀 지시: 5스텝 세그먼트 → 계약값 0/.25/.5/.75/1 로 저장", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  await page.getByTestId("team-tune-toggle").click(); // #244: 전술 다이얼은 ⚙ 뒤(기본 접힘)
  // 슬라이더가 아니다 — 5버튼 세그먼트
  await expect(page.getByTestId("tactics-press").locator("button")).toHaveCount(5);
  await expect(page.getByTestId("tactics-press-step-2")).toHaveAttribute("aria-checked", "true"); // 기본 0.5

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
/*
 * ── m8(R3b): 이 테스트는 이름·주석·본문이 **삼중으로** 실제와 어긋나 있었다 ────────────────
 *   ① 이름이 "배치 직후"인데 픽스처가 `seededDeck()`(선발 11 이미 채워짐)이라 아무것도 배치 안 함.
 *   ② 주석이 "리스트에서 배치 → 그 자리 선수와 교체"인데 실제로는 채워진 슬롯 **선택** 경로다.
 *   ③ 검증한다는 r1 계약("토큰 **재**탭이 해제가 아니라 그 선수 유지")을 실제로는 검증하지
 *      않았다 — `board-slot-starter-6`(=MF2 미드둘)을 탭한 뒤 **다른** 토큰(MF1)을 탭했기 때문에
 *      "다른 선수를 고르면 그 선수가 열린다"만 확인하고 있었다(슬롯 6 이 MF1 이라 착각한 오프바이원).
 * → 이름·주석을 사실에 맞추고, **같은 토큰 재탭**을 실제로 돌려 r1 계약을 박제한다.
 */
test("R2 r1: 토큰을 **다시** 탭해도 해제되지 않고 그 선수 지시가 유지된다(정상 덱 · 390)", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck()); // 선발 11/벤치 1 = 실사용 상태
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  // 채워진 슬롯(slotIndex 6 = MF2 "미드둘")을 탭 → 배치가 아니라 **선택** 경로 → 독이 펼쳐진다.
  await page.getByTestId("board-slot-starter-6").click();
  await expect(page.getByTestId("rail-title")).toHaveText("미드둘");
  await page.getByTestId("rail-close").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "team");

  // 다른 토큰(MF1)을 1탭 → 그 선수 지시가 열린다
  await page.getByTestId("token-MF1").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "player");
  await expect(page.getByTestId("rail-title")).toHaveText("미드하나");
  await expect(page.getByTestId("rail-prompt-input")).toBeVisible();

  // r1 계약 본체: **같은** 토큰을 다시 탭해도 팀 지시로 튕기지 않는다(재탭 = 해제 아님).
  await page.getByTestId("token-MF1").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "player");
  await expect(page.getByTestId("rail-title")).toHaveText("미드하나");

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
  await page.getByTestId("rail-tune-toggle").click(); // #244: 역할·칩은 ⚙ 뒤
  await page.getByTestId("rail-prompt-input").fill(typed);
  await expect(page.getByTestId("rail-compose-own")).toHaveText(typed);
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();
  expect(puts[0]!.slots.find((s) => s.playerId === "FW2")!.promptText).toBe(typed);

  // 재진입(새로고침) — 문자열만 보고는 구별 불가라 압박 칩이 켜진 채 복원된다(불가피).
  await page.reload();
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await page.getByTestId("token-FW2").click();
  await page.getByTestId("rail-tune-toggle").click(); // 리로드로 서랍 상태가 초기화된다
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
  await page.getByTestId("rail-tune-toggle").click(); // #244: 역할·칩은 ⚙ 뒤
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
/**
 * R3a m6/m7 — 펼친 독의 문서 런웨이를 60vh 고정치에서 **실측치**로 바꾼 효과.
 * (착수 시점 실측: 최대 스크롤 죽은 띠 175px / 접힘 점프 507px.)
 */
/** m1 안내는 **폰에서도 보여야** 한다(데이터는 이미 안전하지만, 무슨 일이 있었는지 알려야 한다). */
test("R3a m1 × 모바일: 390 에서 문장이 한마디로 옮겨지고 안내가 독 안에 보인다", async ({ page }) => {
  const seeded = seededDeck().map((s) =>
    s.playerId === "MF1" ? { ...s, promptText: "높은 위치에서 강하게 압박한다." } : s,
  );
  await mockApi(page, seeded);
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  await page.getByTestId("token-MF1").click();
  await page.getByTestId("rail-tune-toggle").click(); // #244: 역할·칩은 ⚙ 뒤
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
  await page.getByTestId("rail-tune-toggle").click(); // #244: 역할·칩은 ⚙ 뒤
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

/* ══ R3b (#106) — 빈 상태 · 색각 · a11y · 데드코드 실측 ══════════════════════════════════ */

/**
 * R3b A — 빈 상태. **11 슬롯 전수 hit-test**가 계약이다.
 *
 * ⚠️ 이 테스트의 1차 버전은 `board-slot-starter-0`(GK, 피치 최하단) 하나만 눌러보고 "슬롯 탭이
 * 살아 있다"고 단언했다. GK 슬롯은 중앙 오버레이에 **구조적으로 절대 안 덮이는** 자리라, 실제로
 * 막혀 있던 선발 2·3 을 잡아낼 수 없었다 — m8 에서 지적한 오프바이원과 **동일 계열의 헛단언**을
 * 새로 만든 것이다(독립 검증 blocker-1). 가림을 검증하는 테스트는 반드시 **가려질 수 있는
 * 위치 전부**를 훑어야 한다 → 특정 슬롯 고르기 금지, 11 슬롯 전수 스캔.
 */
async function scanStarterSlots(page: Page): Promise<Array<{ i: number; blockedBy: string | null }>> {
  return page.evaluate(() =>
    Array.from({ length: 11 }, (_, i) => {
      const el = document.querySelector(`[data-testid="board-slot-starter-${i}"]`);
      if (!el) return { i, blockedBy: "missing" };
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (hit?.closest(`[data-testid="board-slot-starter-${i}"]`)) return { i, blockedBy: null };
      const owner = hit?.closest("[data-testid]")?.getAttribute("data-testid");
      return { i, blockedBy: owner ?? hit?.tagName ?? "unknown" };
    }),
  );
}

/**
 * 보유 12명 = Auto 활성 · 6명 = 활성(있는 만큼 채운다, #439) · **0명 = 비활성 + 안내 오버레이**.
 *
 * ⚠️ **0명 갈래는 #442 R2-ⓑ 로 되살린 것이다.** 이 테스트의 블로커 내용은 CTA 상태가 아니라
 * 아래 `blocked` 히트테스트("빈 상태 안내가 선발 슬롯을 가리지 않는다")인데, `c8fb4ae` 가
 * 두 갈래를 모두 CTA 활성으로 재작성하면서 겨누던 오버레이(`board-empty-note`)가 **표본에서
 * 통째로 빠졌다** — 두 갈래 다 `toHaveCount(0)` 이 되어 **한 번도 렌더된 적 없는 오버레이를
 * 상대로 히트테스트가 돌았다 = 무조건 통과**. note 는 이제 `autoDisabled && autoHint` 에서만
 * 뜨므로 **보유 0명**이 그 유일한 도달 경로다. 그 상태를 표본에 다시 넣어 계약을 복원한다.
 */
const SIX = PLAYERS.slice(0, 6);

for (const width of [390, 1280]) {
  for (const owned of [12, 6, 0] as const) {
    test(`R3b A: 빈 상태에서 선발 11 슬롯이 전부 눌린다 (${width} · 보유 ${owned}명)`, async ({ page }) => {
      mkdirSync(SMOKE_DIR, { recursive: true });
      await mockApi(page, []); // 진짜 첫 진입 = 빈 덱(여기서는 이게 **실사용 상태**다)
      // ⚠️ Playwright 라우트는 **나중에 등록한 것이 이긴다** → 보유 선수 오버라이드는 mockApi 뒤에.
      await page.route((url) => url.pathname === "/api/players", (route) =>
        route.fulfill(json(owned === 12 ? PLAYERS : owned === 6 ? SIX : [])),
      );
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await openDeck(page);

      await expect(page.getByTestId("board-empty-hint")).toBeVisible();
      await expect(page.getByTestId("team-sheet-bar")).toHaveAttribute("data-empty", "true");
      // 보유<11 이면 CTA 는 비활성이고, 안내가 "슬롯을 눌러 직접 배치"라고 **지시**한다 —
      // 그렇게 지시하는 화면에서 슬롯이 죽어 있으면 막다른 길이다(이게 blocker 였던 이유).
      /**
       * ⚠️ **#439 로 이 분기의 의미가 바뀌었다.** 구 계약은 *"보유<11 → CTA 비활성 + '직접 배치'
       * 안내"* 였고, 그때의 Auto 는 전원에서 11명을 새로 짜는 것이라 11명이 없으면 정말 할 일이
       * 없었다. 지금 Auto 는 **빈 자리 채우기**(hero Q1=ⓑ)라 보유 6명이면 6칸을 채운다 —
       * 비활성으로 두면 할 수 있는 일을 막는 거짓 잠금이다. 그래서 두 폭·두 보유 수 모두 **활성**.
       *
       * ⚠️ 이 테스트의 **블로커 내용은 CTA 상태가 아니다** — 아래 `blocked` 히트테스트("안내가
       * 선발 슬롯을 가리지 않는다")가 그것이고, 그건 손대지 않았다. 안내 문구는 CTA 가 살아 있는
       * 지금 "막다른 길"이 아니므로 대상이 사라진 것이지 검증을 뺀 것이 아니다.
       */
      /**
       * ⚠️ **보유 0명은 다른 갈래다** (#442 R2-ⓑ). 채울 후보가 하나도 없으므로 CTA 는 비활성이고
       * 그때만 안내 오버레이(`board-empty-note`)가 뜬다 — *"…슬롯을 눌러 직접 배치할 수
       * 있습니다"*. **그렇게 지시하는 화면에서 그 오버레이가 슬롯을 가리면 막다른 길**이고,
       * 그게 이 테스트가 원래 겨누던 블로커다. 이 갈래가 있어야 아래 히트테스트가 실물을 상대한다.
       */
      if (owned === 0) {
        await expect(page.getByTestId("board-empty-auto")).toBeDisabled();
        await expect(
          page.getByTestId("board-empty-note"),
          "히트테스트가 겨누는 오버레이가 실제로 렌더돼 있어야 한다",
        ).toBeVisible();
      } else {
        await expect(page.getByTestId("board-empty-auto")).toBeEnabled();
        await expect(page.getByTestId("board-empty-note")).toHaveCount(0);
      }

      const scan = await scanStarterSlots(page);
      const blocked = scan.filter((s) => s.blockedBy !== null);
      console.log(
        `[smoke] ${width}/${owned}명 slot hit-test = ${11 - blocked.length}/11` +
          (blocked.length ? ` 막힘: ${blocked.map((b) => `${b.i}←${b.blockedBy}`).join(", ")}` : ""),
      );
      expect(blocked, `빈 상태 안내가 선발 슬롯을 가린다: ${JSON.stringify(blocked)}`).toEqual([]);

      // hit-test 뿐 아니라 **실제 클릭**도 통한다(가장 덮이기 쉬운 중앙 슬롯들로 확인).
      // #244: 슬롯 탭 = 보유 선수 시트가 열린다 → 다음 슬롯을 누르려면 시트를 닫아야 한다.
      for (const i of [2, 3]) {
        await page.getByTestId(`board-slot-starter-${i}`).click({ timeout: 3000 });
        await expect(page.getByTestId("player-pool")).toBeVisible();
        await page.getByTestId("pool-sheet-close").click();
        await expect(page.getByTestId("pool-sheet")).toBeHidden();
      }
      await page.screenshot({ path: `${SMOKE_DIR}r3b-empty-${width}-${owned}.png`, fullPage: true });
    });
  }
}

test("R3b A: 빈 상태 CTA 를 누르면 선발이 채워지고 안내가 사라진다", async ({ page }) => {
  await mockApi(page, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  const cta = page.getByTestId("board-empty-auto");
  await expect(cta).toBeEnabled();
  await cta.click();
  await expect(page.getByTestId("starter-count")).toHaveText("선발 11/11");
  await expect(page.getByTestId("board-empty")).toHaveCount(0);
  await expect(page.getByTestId("board-empty-auto")).toHaveCount(0);
});

test("R3b A: 빈 상태에서도 슬롯 배치가 끝까지 동작한다(안내 → 배치 → 안내 사라짐)", async ({ page }) => {
  await mockApi(page, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);
  await expect(page.getByTestId("board-empty")).toBeVisible();

  // 중앙(가장 덮이기 쉬운) 슬롯으로 탭-투-플레이스를 완주한다.
  await page.getByTestId("board-slot-starter-3").click();
  await page.getByTestId("pick-DF1").click();
  await expect(page.getByTestId("starter-count")).toHaveText("선발 1/11");
  await expect(page.getByTestId("board-empty")).toHaveCount(0);
});

test("R3b B: 컨디션 3단계가 색 **외** 축으로도 구분된다(등급 속성 · 파선 · 글자)", async ({ page }) => {
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);
  await page.getByTestId("pool-sheet-open").click(); // #244: 보유 선수는 시트 뒤

  // 목 컨디션: GK1 0.9(high) / MF1 0.5(mid) / FW1 0.2(low)
  const tiers = { GK1: "high", MF1: "mid", FW1: "low" } as const;
  for (const [id, tier] of Object.entries(tiers)) {
    await expect(page.getByTestId(`pick-cond-${id}`)).toHaveAttribute("data-condition-tier", tier);
  }
  // 글자 축(리스트 행) — 색을 전혀 못 봐도 등급이 읽힌다.
  await expect(page.getByTestId("pick-cond-tier-GK1")).toHaveText("최상");
  await expect(page.getByTestId("pick-cond-tier-MF1")).toHaveText("보통");
  await expect(page.getByTestId("pick-cond-tier-FW1")).toHaveText("저조");

  // 링 파선 패턴이 등급마다 **실제로 다르다**(계산된 스타일 실측 — 색 없이 형태로 구분).
  const dashes = await page.evaluate(() =>
    ["GK1", "MF1", "FW1"].map((id) => {
      const c = document.querySelector(`[data-testid="pick-cond-${id}"] svg circle`)!;
      return getComputedStyle(c).strokeDasharray || "none";
    }),
  );
  console.log(`[smoke] condition ring dasharray = ${JSON.stringify(dashes)}`);
  expect(new Set(dashes).size, "세 등급의 링 패턴이 서로 달라야 한다").toBe(3);
});

test("R3b C: a11y — 역할·5스텝은 radiogroup, 칩은 토글, 근사값은 checked 아님", async ({ page }) => {
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);
  await page.getByTestId("team-tune-toggle").click(); // #244: 전술 다이얼은 ⚙ 뒤

  // 팀 컨텍스트: 5스텝 = 배타 선택
  await expect(page.getByTestId("tactics-press")).toHaveAttribute("role", "radiogroup");
  await expect(page.getByTestId("tactics-press-step-2")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("tactics-press-step-4").click();
  await expect(page.getByTestId("tactics-press-step-4")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("tactics-press-step-2")).toHaveAttribute("aria-checked", "false");

  // 선수 컨텍스트: 역할 = radiogroup / 세부 지시 칩 = 다중 토글(aria-pressed 유지)
  await page.getByTestId("token-MF1").click();
  await page.getByTestId("rail-tune-toggle").click(); // #244: 역할·칩은 ⚙ 뒤
  await expect(page.getByTestId("rail-role")).toHaveAttribute("role", "radiogroup");
  await expect(page.getByTestId("rail-role-balanced")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("rail-chip-press").click();
  await expect(page.getByTestId("rail-chip-press")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("rail-chip-marking").click();
  // 칩은 서로 배타가 아니다 — 둘 다 켜진다(radio 로 바꾸면 안 되는 이유).
  await expect(page.getByTestId("rail-chip-press")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("rail-chip-marking")).toHaveAttribute("aria-pressed", "true");
});

test("R3b C: radiogroup APG — 방향키로 이동/선택 + 탭스톱은 그룹당 1개", async ({ page }) => {
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);
  await page.getByTestId("team-tune-toggle").click(); // #244: 전술 다이얼은 ⚙ 뒤

  // 팀 5스텝: 방향키가 실제로 값을 옮긴다(선택이 포커스를 따라간다).
  await page.getByTestId("tactics-press-step-2").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("tactics-press")).toHaveAttribute("data-value", "0.75");
  await expect(page.getByTestId("tactics-press-step-3")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("tactics-press")).toHaveAttribute("data-value", "0.5");
  await page.keyboard.press("End");
  await expect(page.getByTestId("tactics-press")).toHaveAttribute("data-value", "1");
  await page.keyboard.press("Home");
  await expect(page.getByTestId("tactics-press")).toHaveAttribute("data-value", "0");

  // roving tabindex — 그룹 5버튼 중 tabindex=0 은 정확히 하나.
  const tabStops = await page.getByTestId("tactics-press").evaluate((el) =>
    Array.from(el.querySelectorAll('[role="radio"]')).map((r) => r.getAttribute("tabindex")),
  );
  console.log(`[smoke] tactics-press tabindex = ${JSON.stringify(tabStops)}`);
  expect(tabStops.filter((t) => t === "0")).toHaveLength(1);

  // 역할 세그먼트도 같은 규약.
  await page.getByTestId("token-MF1").click();
  await page.getByTestId("rail-tune-toggle").click(); // #244: 역할·칩은 ⚙ 뒤
  await page.getByTestId("rail-role-balanced").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("rail-role-attack")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("rail-role-attack")).toBeFocused();
  const roleStops = await page.getByTestId("rail-role").evaluate((el) =>
    Array.from(el.querySelectorAll('[role="radio"]')).map((r) => r.getAttribute("tabindex")),
  );
  expect(roleStops.filter((t) => t === "0")).toHaveLength(1);
});

test("R3b C: 문장 이동 알림이 라이브 리전으로 전달된다(리전은 내용보다 먼저 존재)", async ({ page }) => {
  const saved = "높은 위치에서 강하게 압박한다.";
  await mockApi(page, seededDeck().map((s) => (s.playerId === "MF1" ? { ...s, promptText: saved } : s)));
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);

  await page.getByTestId("token-MF1").click();
  await page.getByTestId("rail-tune-toggle").click(); // #244: 역할·칩은 ⚙ 뒤
  const live = page.getByTestId("rail-moved-live");
  // 리전이 **먼저** 비어 있는 채로 존재해야 SR 이 이후 변경을 읽는다.
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toHaveText("");

  await page.getByTestId("rail-chip-press").click(); // 추론 항목 끄기 → 문장 이동
  await expect(live).toContainText("감독의 한마디로 옮겼습니다");
  await expect(page.getByTestId("rail-moved")).toBeVisible();
});

test("R3b C: 모바일 44px 탭 타깃 — 스텝·칩·역할·세부조정 토글", async ({ page }) => {
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);
  await page.getByTestId("token-MF1").click();
  await page.getByTestId("rail-tune-toggle").click(); // #244: 역할·칩은 ⚙ 뒤

  const ids = ["rail-tune-toggle", "rail-role-attack", "rail-chip-press"];
  for (const id of ids) {
    const h = await page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().height);
    console.log(`[smoke] tap target ${id} = ${h.toFixed(1)}px`);
    expect(h, `${id} 탭 타깃이 44px 미만`).toBeGreaterThanOrEqual(44);
  }
  // 5스텝은 한 줄에 5개가 붙어 있어 특히 위험 — 팀 컨텍스트로 돌아가 잰다.
  await page.getByTestId("rail-close").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "team");
  await page.getByTestId("team-tune-toggle").click();
  const stepH = await page.getByTestId("tactics-press-step-2").evaluate((el) => el.getBoundingClientRect().height);
  console.log(`[smoke] tap target tactics-press-step-2 = ${stepH.toFixed(1)}px`);
  expect(stepH).toBeGreaterThanOrEqual(44);
});
