import { expect, test } from "@playwright/test";
import { hitAt, openDeck, wheelUntilHit } from "./deck-mock";

/**
 * #455 A2 — **선수 토큰 탭 → 4항목 메뉴 시트**(메가에픽2-A, 덱셋팅 화면 전면 개편).
 *
 * ── 이 계약의 출처 ────────────────────────────────────────────────────────────
 * A-0 정적 목업(`docs/plan-v5/mock/455-decka/index.html`)을 hero 가 만져 보고 확정한 계약
 * (#455 comment 5196070445) 중 **①·④**:
 *
 *   ① 선수 탭 메뉴 = **A안** `[자리 옮기기] [한마디 쓰기] [선수 정보] [닫기]`
 *      · 원문의 '위치 이동'·'선수 이동'은 같은 동작이라 **합쳤고**, 그 자리에 [선수 정보]
 *        (강화 진입점)가 들어갔다. 되돌리지 마라.
 *   ④ 뜨는 방식 = **시트**(아래에서 올라옴). 모달 경로는 코드에 남겨 둔다(폭 기준 분기 여지).
 *
 * ⚠️ **이 메뉴는 드래그를 대체하지 않는다** — 꾹 누름 → 드래그 스왑(#439 `drag-gesture.ts`
 *    150ms/8px)은 그대로다. 탭 메뉴는 그 **위에 더하는 것**이고, 그 무회귀는
 *    `deck-list-dnd-touch.spec.ts`(폰 실터치 롱프레스 드래그)가 지킨다.
 *
 * ── 스코프: **폰 덱셋팅뿐**이다 ───────────────────────────────────────────────
 * `DeckEditor` 는 덱셋팅(`DeckPage`)·경기전(`BriefingPanel`)·감독시간(`HalftimePanel`) **셋이
 * 공유**한다. 확정 계약이 **폰 덱셋팅 화면 개편**이라 A1 이 `layout="tabs"` 를 폭 ≤899 에만
 * 준 것과 같은 이유로, 메뉴도 그 화면에만 준다(`playerMenu` prop = 명시 축).
 *   · 경기전·감독시간의 토큰 탭 무회귀 = `p439-phone-deck-ux.spec.ts`(경기전 `vacateSlot`/
 *     `promptOf` 가 토큰 탭 → 레일을 직접 탄다) · `p276-halftime-shape.spec.ts` ·
 *     `p294-halftime-failure.spec.ts` 가 소유한다. "메뉴를 모든 화면에 켠다"는 변이는 거기서 죽는다.
 *   · 데스크탑 덱(stack)은 이 파일 ⑨ 가 직접 잰다(레일이 상시 옆에 서 있어 메뉴가 한 단계를
 *     더할 뿐인 자리 — A1 이 탭을 폰에만 준 것과 같은 판단).
 *
 * ⚠️ **측정은 추론하지 않는다**(루트 §2-2). "보이나"는 `toBeVisible()` 이 아니라
 *    `elementFromPoint` 히트/유저 휠(`wheelUntilHit`)로 판정한다 — 뷰포트 밖도 `toBeVisible()` 은
 *    통과한다(apps/web/CLAUDE.md "초록으로 거짓말하는 방식" ③).
 * ⚠️ 라벨은 **리터럴**로 박는다(앱 상수를 import 하면 라벨 변이가 통과한다 — 같은 표 ②).
 * ⚠️ 자기 전제 단언: `test.use` 에서 `viewport` 키가 빠지면 Playwright 는 조용히 데스크탑으로
 *    돌리고 **그래도 초록**이다(#386 실적). 그래서 매 테스트가 뷰포트를 먼저 단언한다.
 * ⚠️ 실행: 전체 e2e 금지(:8080 데모 충돌) — 스펙 지정 + 빈 포트.
 *    `CI=1 WEB_E2E_PORT=5811 npx playwright test e2e/p455-a2-player-menu.spec.ts`
 */

const PHONE = { width: 390, height: 844 };

test.describe("폰 덱셋팅 — 선수 메뉴", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    expect(page.viewportSize(), "이 계약은 실제 폰 뷰포트에서만 유효하다").toEqual(PHONE);
  });

  // ── ① 메뉴 = A안 4항목 (순서까지) ──────────────────────────────────────────
  /**
   * hero 확정 ①. **순서가 곧 위계다** — 목업 A안의 배열 그대로.
   * 라벨을 리터럴로 박는 이유 = 앱의 `PLAYER_MENU` 를 import 하면 "라벨을 전부 바꾸는" 변이가
   * 통과한다(apps/web/CLAUDE.md "초록으로 거짓말" ②).
   */
  test("① 선수 토큰을 탭하면 4항목 메뉴가 뜬다 — 자리 옮기기 · 한마디 쓰기 · 선수 정보 · 닫기", async ({ page }) => {
    await openDeck(page);
    await expect(page.getByTestId("player-menu"), "탭 전에는 메뉴가 없다").toHaveCount(0);

    await page.getByTestId("token-MF1").tap();

    const menu = page.getByTestId("player-menu");
    await expect(menu).toHaveCount(1);
    // 제목이 **누구의 메뉴인지** 말한다(시트가 보드 아래쪽을 덮으므로 이름이 유일한 식별자다).
    await expect(page.getByTestId("player-menu-title")).toContainText("미드하나");

    const labels = await menu.locator("[data-testid^='pmenu-']").allInnerTexts();
    const flat = labels.map((t) => t.replace(/\s+/g, " ").trim());
    console.log(`[#455-A2-①] 메뉴 항목 = ${JSON.stringify(flat)}`);
    expect(flat.length, "A안은 4항목이다").toBe(4);
    expect(flat[0]).toContain("자리 옮기기");
    expect(flat[1]).toContain("한마디 쓰기");
    expect(flat[2]).toContain("선수 정보");
    expect(flat[3]).toContain("닫기");

    // 네 항목 모두 **실제로 눌리는 자리**에 있어야 한다(시트가 화면 밖으로 나가면 손잡이가 없다).
    for (const id of ["pmenu-move", "pmenu-say", "pmenu-info", "pmenu-close"]) {
      const b = (await page.getByTestId(id).boundingBox())!;
      const hit = await hitAt(page, b.x + b.width / 2, b.y + b.height / 2, id);
      expect(hit, `[${id}] 가 화면에서 눌리지 않는다 (y=${Math.round(b.y)})`).toBe(true);
    }
  });

  // ── ② 메뉴가 탭 동작 **앞에** 선다 ─────────────────────────────────────────
  /**
   * A2 의 실질이 이 한 줄이다 — 구 동작은 토큰 탭이 곧 "그 선수 지시"였고, 이제 그 사이에
   * 메뉴가 들어온다. 이 계약이 없으면 "메뉴를 그려만 두고 탭은 예전대로"가 통과한다.
   */
  test("② 토큰 탭이 곧바로 지시 칸을 열지 않는다 — 메뉴가 그 앞에 선다", async ({ page }) => {
    await openDeck(page);
    await expect(page.getByTestId("rail-prompt-input"), "선택 전에는 선수 지시 칸이 없다").toHaveCount(0);

    await page.getByTestId("token-MF1").tap();

    await expect(page.getByTestId("player-menu")).toHaveCount(1);
    await expect(
      page.getByTestId("rail-prompt-input"),
      "메뉴를 거치지 않고 지시 칸이 열렸다 — 탭이 가로채이지 않았다",
    ).toHaveCount(0);
  });

  // ── ③ 확정 ④ = **시트**(아래에서 올라온다) ────────────────────────────────
  /**
   * hero 확정 ④. 목업이 **시트와 모달을 둘 다** 만들어 놓고 시트를 골랐다(모달은 위아래 각
   * 192px 를 남겨 경기장이 계속 보이는 대신 엄지가 멀다).
   * 그래서 이 계약의 판별식은 **바닥에 붙었나**다 — 모달로 되돌리면(`align-items:center`)
   * 상자 바닥이 화면 바닥에서 떨어지므로 여기서 죽는다.
   */
  test("③ 메뉴는 시트다 — 화면 **바닥에 붙어** 올라오고, 화면을 다 덮지 않는다", async ({ page }) => {
    await openDeck(page);
    await page.getByTestId("token-MF1").tap();

    const box = (await page.getByTestId("player-menu").boundingBox())!;
    const bottomGap = PHONE.height - (box.y + box.height);
    console.log(
      `[#455-A2-③] 메뉴 상자 y=${Math.round(box.y)} h=${Math.round(box.height)} 바닥여유=${bottomGap.toFixed(1)}`,
    );
    expect(bottomGap, `시트는 화면 바닥에 붙는다 — 실측 여유 ${bottomGap.toFixed(1)}px`).toBeLessThanOrEqual(2);
    expect(box.height, "4항목 시트가 화면을 다 덮으면 그건 시트가 아니라 페이지다").toBeLessThan(
      PHONE.height * 0.6,
    );
    // 시트 위쪽으로 화면이 남는다 = 경기장이 그 위에 있다(모달과 달리 **한쪽만** 덮는다).
    expect(box.y, "시트 위로 화면이 남아야 한다").toBeGreaterThan(PHONE.height * 0.4);
  });

  // ── ④ [한마디 쓰기] → 그 선수 지시 칸 ─────────────────────────────────────
  /**
   * 구 토큰 탭이 하던 일이 이 항목으로 들어왔다(#244 A′ "선수를 고르면 그 입력창까지 화면이
   * 따라온다"는 그대로 성립해야 한다 — 탭 레이아웃에서는 [📣 전체 지시] 탭으로 넘어간다).
   * ⚠️ 도달 판정은 **유저 휠**이다(`wheelUntilHit`) — `scrollIntoView` 류는 `overflow:hidden`
   *    을 뚫어 유저가 못 하는 일을 "닿는다"로 판정한다(A1 2R blocker-A).
   */
  test("④ [한마디 쓰기] → 그 선수 지시 칸이 열리고 유저 스크롤로 닿는다", async ({ page }) => {
    await openDeck(page);
    await page.getByTestId("token-MF1").tap();
    await page.getByTestId("pmenu-say").tap();

    await expect(page.getByTestId("player-menu"), "고르면 메뉴는 닫힌다").toHaveCount(0);
    await expect(page.getByTestId("rail-title"), "그 선수의 지시 칸이어야 한다").toContainText("미드하나");

    const reach = await wheelUntilHit(page, "rail-prompt-input");
    console.log(`[#455-A2-④] 지시 칸 도달 = ${JSON.stringify(reach)}`);
    expect(reach.hit, "한마디를 쓰라고 해놓고 입력칸에 닿을 수 없다").toBe(true);

    // 실제로 쓸 수 있다(읽기 전용·비활성으로 바뀌면 여기서 죽는다).
    await page.getByTestId("rail-prompt-input").fill("측면을 넓게 벌려라");
    await expect(page.getByTestId("rail-prompt-input")).toHaveValue("측면을 넓게 벌려라");
  });

  // ── ⑤ [자리 옮기기] → 자리 지정 대기 → 맞바꾸기 ───────────────────────────
  /**
   * #442 R1 이 만든 **엔트리 대기**(`assign-bar` → 슬롯 탭 → `movePlayerToSlot`)를 그대로 탄다 —
   * 새 상태기계를 만들지 않는다. 보드 위 선수끼리는 **맞바꾸기**다(#442 R4-B: 밀려남은 풀 선수가
   * 찬 자리로 올 때뿐).
   */
  test("⑤ [자리 옮기기] → 자리를 고르라고 하고, 찬 자리를 누르면 **맞바꾼다**", async ({ page }) => {
    await openDeck(page);
    await page.getByTestId("token-MF1").tap();
    await page.getByTestId("pmenu-move").tap();

    await expect(page.getByTestId("player-menu"), "고르면 메뉴는 닫힌다").toHaveCount(0);
    const bar = page.getByTestId("assign-bar");
    await expect(bar, "어디로 보낼지 물어야 한다").toBeVisible();
    /**
     * ⚠️ **이 갈래는 [엔트리]와 말이 달라야 한다** — 여기 오는 선수는 **이미 명단 안**이라
     * #442 R3-A 문구("명단에서 바꿀 선수를 선택하세요")를 그대로 쓰면 명단에 있는 사람을 명단에
     * 넣으라는 말이 된다. 반대쪽(경기전 [엔트리] = 벤치 선수)은 `p442` ①⑥ 이 그 문구를 지킨다 —
     * 두 단언이 **양방향**이라, 갈래를 draft 상태로 되추론하는 구현은 둘 중 하나에서 반드시 죽는다
     * (실제로 그렇게 짰다가 p442 ①⑥ 이 red 였다).
     */
    await expect(bar, "누구를 옮기는 중인지 말해야 한다").toContainText("미드하나");
    await expect(bar).toContainText("자리 옮기기");
    expect(await bar.innerText(), "엔트리 갈래의 문구가 여기 오면 안 된다").not.toContain(
      "명단에서 바꿀 선수를 선택하세요",
    );

    // MF1 = 선발 5 · FW2 = 선발 10 (deck-mock ELEVEN 순서).
    await expect(page.getByTestId("board-slot-starter-5").getByTestId("token-MF1")).toBeVisible();
    await page.getByTestId("board-slot-starter-10").tap();

    await expect(page.getByTestId("board-slot-starter-10").getByTestId("token-MF1")).toBeVisible();
    await expect(
      page.getByTestId("board-slot-starter-5").getByTestId("token-FW2"),
      "맞바꾸기다 — 밀려난 선수는 그 자리로 온다",
    ).toBeVisible();
    await expect(page.getByTestId("starter-count"), "선발 수가 줄면 그건 맞바꾸기가 아니다").toHaveText(/11\/11/);
  });

  // ── ⑥ [선수 정보] → 강화 시트 ─────────────────────────────────────────────
  /**
   * 확정 ① 이 '위치 이동'·'선수 이동'을 합치고 그 자리에 넣은 항목이다(= **강화 진입점**).
   * 새 화면을 만들지 않는다 — 레일의 [선수 강화](`rail-growth-open`)가 여는 것과 **같은 컴포넌트**
   * 라야 hero 가 말한 "덱과 싱크"가 배선이 아니라 구조로 보장된다(#286 W3).
   */
  test("⑥ [선수 정보] → 레일이 여는 것과 **같은** 강화 시트가 뜬다", async ({ page }) => {
    await openDeck(page);
    await page.getByTestId("token-MF1").tap();
    await page.getByTestId("pmenu-info").tap();

    const sheet = page.getByTestId("growth-detail");
    await expect(sheet, "강화 시트가 열려야 한다").toHaveCount(1);
    await expect(sheet, "덱에서 연 것임을 계약이 구분할 수 있어야 한다").toHaveAttribute(
      "data-growth-source",
      "deck",
    );
  });

  // ── ⑦ [닫기] → 메뉴만 닫힌다 ──────────────────────────────────────────────
  /**
   * ⚠️ **아무 것도 안 바뀌는 것**이 이 항목의 전부다. 메뉴를 여는 순간 선택까지 같이 만들면
   * [한마디 쓰기]가 사실상 no-op 이 되고, 그 항목을 지우는 변이가 살아남는다.
   */
  test("⑦ [닫기] → 메뉴만 닫히고 선택도 배치 대기도 생기지 않는다", async ({ page }) => {
    await openDeck(page);
    await page.getByTestId("token-MF1").tap();
    await page.getByTestId("pmenu-close").tap();

    await expect(page.getByTestId("player-menu")).toHaveCount(0);
    await expect(page.getByTestId("rail-prompt-input"), "닫기가 선택을 만들면 안 된다").toHaveCount(0);
    await expect(page.getByTestId("assign-bar"), "닫기가 배치 대기를 만들면 안 된다").toHaveCount(0);
  });

  // ── ⑧ 엔트리 대기 중에는 메뉴가 끼어들지 않는다 ───────────────────────────
  /**
   * #442 R1 동선 보존 — 목록에서 [엔트리]를 누른 뒤 슬롯을 탭하는 것은 **자리 지정**이다.
   * 거기에 메뉴가 끼면 그 동선이 통째로 죽는다(찬 자리를 영영 못 고른다).
   */
  test("⑧ 엔트리 대기 중 토큰 탭은 **자리 지정**이다 — 메뉴가 끼어들지 않는다", async ({ page }) => {
    await openDeck(page);
    // FW4 = 스쿼드 밖(미배치) — #442 의 그 갈래 입구.
    await page.getByTestId("deck-tab-sub").tap();
    await page.getByTestId("pool-sheet-open").tap();
    await expect(page.getByTestId("player-pool")).toBeVisible();
    await page.getByTestId("pool-assign-FW4").tap();
    await expect(page.getByTestId("assign-bar")).toBeVisible();

    await page.getByTestId("board-slot-starter-5").tap();

    await expect(page.getByTestId("player-menu"), "자리 지정 중에 메뉴가 뜨면 동선이 죽는다").toHaveCount(0);
    await expect(page.getByTestId("board-slot-starter-5").getByTestId("token-FW4")).toBeVisible();
  });
});

// ── ⑨ 데스크탑 덱(stack)은 그대로 ───────────────────────────────────────────
/**
 * A1 이 탭을 폭 ≤899 에만 준 것과 **같은 스코프 판단**이다: 확정 계약은 폰 덱셋팅 개편이고,
 * 데스크탑은 지시 레일이 보드 **옆에 상시** 서 있어 메뉴가 한 단계를 더할 뿐이다
 * (자리 옮기기 = 포인터 드래그 + 레일 [이 자리 선수 바꾸기] · 선수 정보 = 레일 [선수 강화]).
 *
 * ⚠️ **이 하나는 구현 전에도 green 이다 — red 계약이 아니라 스코프 계약이다.**
 *    "메뉴를 폭 무관하게 켠다"는 변이가 여기서 죽는다.
 */
test.describe("데스크탑 덱 — 무회귀", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("⑨ 데스크탑(1280)에서는 토큰 탭이 예전 그대로 — 메뉴 없이 지시 칸이 열린다", async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 1280, height: 800 });
    await openDeck(page);
    await page.getByTestId("token-MF1").click();

    await expect(page.getByTestId("player-menu"), "데스크탑에는 메뉴가 없다").toHaveCount(0);
    await expect(page.getByTestId("rail-title")).toContainText("미드하나");
    await expect(page.getByTestId("rail-prompt-input")).toHaveCount(1);
  });
});
