import { expect, test, type Page } from "@playwright/test";
import { openDeck } from "./deck-mock";

/**
 * #455 **A2-2 — 강화 가능(선택 대기) 표시**.
 *
 * ── 이 계약의 출처 ────────────────────────────────────────────────────────────
 * 확정 계약(#455 comment 5196070445)의 **조정 포인트** *"강화 `↑` 뱃지 노출"* 이 열어 둔 자리다.
 * 이번 웨이브의 문장은 하나다 — **선택 대기가 있는 선수를 덱 화면에서 알아볼 수 있게 한다.**
 *   · 신호의 출처 = `GET /api/growth/choices`(`usePendingChoices`, 전체 목록 **1회**)
 *   · 표시 자리 = ⓐ 보드·벤치 토큰 `↑` ⓑ 선수 메뉴 `[선수 정보]` 항목
 *
 * ⚠️ **성(★) 승급 표시는 이 스코프가 아니다** — 서버 계약이 없다(#455 본문). 여기에 그 단언을
 *    적지 마라: 지금 참이 아닌 것을 계약에 적으면 다음 사람이 그 문장을 근거로 오스코핑한다.
 *
 * ── 이 파일이 지키는 "초록으로 거짓말" 방어 ───────────────────────────────────
 * ⚠️ **음성 표본이 필수다.** "뱃지가 없다"만 재면 뱃지를 **상수 false** 로 만드는 변이가 살고,
 *    "뱃지가 있다"만 재면 **상수 true**(전원 표시) 변이가 산다. 그래서 매 자리에서 양성(대기 있는
 *    선수)과 음성(없는 선수)을 **같이** 태운다.
 * ⚠️ **`toBeVisible()` 을 "화면에 있다"의 근거로 쓰지 않는다** — 뷰포트 밖도 통과한다
 *    (apps/web/CLAUDE.md "초록으로 거짓말하는 방식" ③). 아래 `badgeState` 가 ① 뷰포트 안 ②
 *    그 지점의 히트테스트가 **그 토큰 안**으로 떨어짐(= 다른 토큰·시트·네비가 안 덮음) ③ 계산된
 *    `opacity`/`visibility` 를 **같이** 잰다. #439 `.tokenDragging{opacity:.4}` 가 홀드 링을
 *    눌렀던 것이 바로 ③ 의 사각이었다(DOM 은 불투명도를 말하지 않는다).
 * ⚠️ 뱃지 자체는 `pointer-events:none` 이다(제스처를 먹으면 드래그가 죽는다 — 같은 파일의
 *    `.holdRing` 주석). 그래서 히트테스트가 돌려주는 것은 뱃지가 아니라 **그 아래 토큰**이고,
 *    판정도 그렇게 쓴다("뱃지 사각형 위의 최상단 요소가 이 토큰이다").
 * ⚠️ **그래서 못 잡는 것이 하나 있다 — 정직하게 적는다.** 디스크 안 형제(`.condRing`·얼굴·번호)가
 *    전부 `pointer-events:none` 이라, **같은 토큰 안에서** 뱃지가 가려지는 회귀는 이 자로
 *    구분되지 않는다(`z-index` 를 지우는 변이 M-8 이 **생존**했다 — 다만 그 변이는 실캡처가
 *    대조군과 **바이트 동일**이라 결함이 아니었다). 이 축을 재려면 뱃지를 `pointer-events:auto`
 *    로 바꿔야 하는데 그건 롱프레스 드래그를 위협한다(#439) — **실캡처로 확인하는 자리**다.
 * ⚠️ testid 접두: `token-`·`pick-`·`pool-assign-`·`pmenu-` 는 각각 스캐너/헬퍼의 네임스페이스다
 *    (#442·#455 A1 이 실제로 밟았다). 이 웨이브는 **`growup-`** 을 쓴다.
 *
 * ⚠️ 실행: 전체 e2e 금지(:8080 데모 충돌) — 스펙 지정 + 빈 포트.
 *    `CI=1 WEB_E2E_PORT=5921 npx playwright test e2e/p455-a22-growth-badge.spec.ts --timeout=25000`
 */

const PHONE = { width: 390, height: 844 };

/** 선택 대기 표본 — **선발 1명(MF1) + 벤치 1명(FW3)**. 나머지 12명이 음성 표본이다. */
const READY = ["MF1", "FW3"];

/**
 * "이 뱃지가 실제로 화면에서 읽히나" — DOM 존재가 아니라 **그 사각형이 보이는 자리에 있나**.
 * 실패 메시지가 숫자를 싣도록 상태를 통째로 돌려준다(좌표 추론 금지, 루트 §2-2).
 */
async function badgeState(page: Page, testId: string, ownerTokenTestId: string) {
  const loc = page.getByTestId(testId);
  if ((await loc.count()) === 0) return { exists: false as const };
  const box = await loc.boundingBox();
  if (!box || box.width === 0 || box.height === 0) return { exists: true as const, box, onScreen: false, hit: false, opacity: "0" };
  const vp = page.viewportSize()!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const onScreen = cx > 0 && cy > 0 && cx < vp.width && cy < vp.height;
  const probe = await page.evaluate(
    ({ x, y, sel, owner }) => {
      const el = document.elementFromPoint(x, y);
      const self = document.querySelector(`[data-testid="${sel}"]`) as HTMLElement | null;
      const cs = self ? getComputedStyle(self) : null;
      return {
        hit: !!el?.closest(`[data-testid="${owner}"]`),
        topmost: el ? (el.getAttribute("data-testid") ?? el.className.toString().slice(0, 40)) : null,
        opacity: cs?.opacity ?? "0",
        visibility: cs?.visibility ?? "hidden",
      };
    },
    { x: cx, y: cy, sel: testId, owner: ownerTokenTestId },
  );
  return {
    exists: true as const,
    onScreen,
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: Math.round(box.width),
    h: Math.round(box.height),
    ...probe,
  };
}

async function expectBadgeReadable(page: Page, playerId: string) {
  const s = await badgeState(page, `growup-token-${playerId}`, `token-${playerId}`);
  console.log(`[#455-A2-2] ${playerId} 뱃지 = ${JSON.stringify(s)}`);
  expect(s.exists, `[${playerId}] 는 선택 대기가 있는데 뱃지가 DOM 에 없다`).toBe(true);
  expect(s, `[${playerId}] 뱃지가 화면 밖이다`).toMatchObject({ onScreen: true });
  expect(s, `[${playerId}] 뱃지 자리가 다른 것에 덮였다 (최상단=${"topmost" in s ? s.topmost : "?"})`).toMatchObject({
    hit: true,
  });
  expect(Number("opacity" in s ? s.opacity : 0), `[${playerId}] 뱃지가 투명하다`).toBeGreaterThan(0.9);
  expect("visibility" in s ? s.visibility : "hidden").toBe("visible");
}

test.describe("폰 덱셋팅 — 강화 가능(선택 대기) 표시", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    expect(page.viewportSize(), "이 계약은 실제 폰 뷰포트에서만 유효하다").toEqual(PHONE);
  });

  // ── ① 보드 토큰: 양성 · 음성 · 벤치 ────────────────────────────────────────
  /**
   * 이 웨이브의 문장 그대로다 — **화면을 훑어 알아본다**. 그래서 판정 대상은 메뉴 안이 아니라
   * 보드 위이고, 벤치 선수도 같은 토큰이라 같이 붙는다(그리는 코드가 하나다 — A1 포털).
   */
  test("① 선택 대기가 있는 선수의 토큰에만 ↑ 가 붙는다 — 선발·벤치 양성 2 · 나머지 음성", async ({ page }) => {
    await openDeck(page, null, { growthReady: READY });

    await expectBadgeReadable(page, "MF1"); // 선발 5
    await page.getByTestId("deck-tab-sub").tap(); // 벤치는 [후보] 탭 안(#455 A1)
    await expect(page.getByTestId("token-FW3")).toHaveCount(1);
    await expectBadgeReadable(page, "FW3");

    // 음성 — 대기가 없는 선수에는 안 붙는다(상수 true 변이가 여기서 죽는다).
    for (const id of ["FW2", "GK1", "DF1", "GK2"]) {
      await expect(
        page.getByTestId(`growup-token-${id}`),
        `[${id}] 는 선택 대기가 없는데 뱃지가 붙었다`,
      ).toHaveCount(0);
    }

    const total = await page.locator("[data-testid^='growup-token-']").count();
    console.log(`[#455-A2-2-①] 뱃지 총 개수 = ${total} (기대 ${READY.length})`);
    expect(total, "덱에 놓인 선수 중 선택 대기가 있는 사람만큼이어야 한다").toBe(READY.length);
  });

  // ── ② 아무도 대기가 없으면 아무 데도 안 뜬다 ───────────────────────────────
  /**
   * ⚠️ 이 단언은 **혼자 두면 공허하다**(`toHaveCount(0)` 은 "아직 안 그려짐"도 통과 — 같은 표 ⑥).
   * 그래서 같은 테스트가 **화면이 다 그려졌다는 양성 앵커**(토큰 14개)를 먼저 세운다.
   */
  test("② 대기가 하나도 없는 덱에는 ↑ 가 하나도 없다", async ({ page }) => {
    await openDeck(page); // growthReady 기본값 = []
    await page.getByTestId("deck-tab-sub").tap();
    await expect(page.getByTestId("token-FW3"), "앵커 — 보드·벤치가 다 그려졌다").toHaveCount(1);
    await expect(page.getByTestId("token-MF1")).toHaveCount(1);
    await expect(page.locator("[data-testid^='growup-token-']")).toHaveCount(0);
  });

  // ── ③ 값을 얻는 비용: 전체 목록 **1회**, 선수별 호출 0 ─────────────────────
  /**
   * 브리프가 **설계로 금지**한 것을 계약으로 박는다: *"선수 11명에 대해 카드 조회를 각각
   * 때리는 설계면 그건 답이 아니다."* 그 설계는 화면상으로는 **똑같이 동작**하므로
   * (목이 `?playerId=` 분기를 실물대로 흉내 낸다) DOM 계약으로는 **원리적으로 못 잡는다** —
   * 요청을 직접 세는 이 계약만이 그것을 죽인다.
   */
  test("③ 신호를 얻는 데 전체 목록 1회만 쓴다 — 선수별 왕복 0", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname === "/api/growth/choices") calls.push(u.search || "(전체)");
    });

    await openDeck(page, null, { growthReady: READY });
    await expectBadgeReadable(page, "MF1"); // 뱃지가 실제로 떴다 = 신호가 도착했다
    await page.waitForTimeout(400); // 뒤늦은 팬아웃까지 잡는다

    console.log(`[#455-A2-2-③] /api/growth/choices 호출 = ${JSON.stringify(calls)}`);
    expect(
      calls.filter((s) => s.includes("playerId")),
      "선수별로 나눠 부르면 안 된다 — 서버는 전체 목록을 한 번에 준다",
    ).toEqual([]);
    expect(calls.length, "전체 목록 1회면 충분하다").toBe(1);
  });

  // ── ④ 선수 메뉴 [선수 정보] 항목 — 양성/음성 ───────────────────────────────
  /**
   * 확정 계약이 뱃지 자리로 열어 둔 곳(`PLAYER_MENU` 의 `info` = 강화 진입점). 토큰의 `↑` 를
   * 보고 누른 사람이 **어느 항목으로 가야 하는지**를 그 자리에서 잇는다.
   *
   * ⚠️ 뱃지 testid 가 `pmenu-` 로 시작하면 A2 ① 의 *"메뉴는 4항목"*(`[data-testid^='pmenu-']`
   * 개수)이 **5가 되어 깨진다** — #455 A1 의 `token-name-*` 접두 침범과 같은 부류라 여기서
   * 같이 잰다(그 계약이 다른 파일에 있어 이 파일만 돌리면 안 보이기 때문).
   */
  test("④ [선수 정보] 항목에 ↑ 가 붙는다 — 대기 없는 선수의 메뉴에는 없다", async ({ page }) => {
    await openDeck(page, null, { growthReady: READY });

    await page.getByTestId("token-MF1").tap();
    await expect(page.getByTestId("player-menu")).toHaveCount(1);
    await expect(page.getByTestId("growup-menu"), "대기가 있는 선수인데 메뉴에 표시가 없다").toHaveCount(1);
    const inMenu = await badgeState(page, "growup-menu", "pmenu-info");
    console.log(`[#455-A2-2-④] 메뉴 뱃지 = ${JSON.stringify(inMenu)}`);
    expect(inMenu, "메뉴 뱃지가 화면 밖이거나 덮였다").toMatchObject({ onScreen: true, hit: true });
    // 접두 침범 가드 — 메뉴는 여전히 4항목이다.
    await expect(
      page.locator("[data-testid^='pmenu-']"),
      "뱃지가 `pmenu-` 접두를 침범하면 A2 ① 이 깨진다",
    ).toHaveCount(4);

    await page.getByTestId("pmenu-close").tap();
    await page.getByTestId("token-FW2").tap();
    await expect(page.getByTestId("player-menu")).toHaveCount(1);
    await expect(
      page.getByTestId("growup-menu"),
      "대기가 없는 선수의 메뉴에 표시가 뜨면 그건 상수다",
    ).toHaveCount(0);
  });

  // ── ⑤ 고르고 나면 사라진다 ────────────────────────────────────────────────
  /**
   * 뱃지의 **의미**가 여기서 정해진다 — "예전에 대기가 있었다"가 아니라 **"지금 남아 있다"**.
   * 그래서 신호의 출처가 봉투 스냅샷(`pendingChoices`)이 아니라 `GET /api/growth/choices` 여야
   * 하고(`growth-hooks.ts:92`), 무효화는 `useApplyChoice` 가 이미 한다(`["growthChoices"]`).
   * 여기서는 그 배선이 **덱 화면까지 닿는지**만 잰다 — 서버가 목록을 비우면 뱃지가 사라진다.
   */
  test("⑤ 선택이 소진되면 ↑ 가 사라진다 — 뱃지는 '지금 남은 것'이다", async ({ page }) => {
    await openDeck(page, null, { growthReady: READY });
    await expectBadgeReadable(page, "MF1");

    // 서버 상태가 바뀐 것처럼 목을 갈아끼우고, 앱이 그 목록을 다시 받게 한다.
    await page.route(
      (url) => url.pathname === "/api/growth/choices",
      (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [] }) }),
    );
    await page.reload();
    await expect(page.getByTestId("token-MF1")).toHaveCount(1);
    await expect(page.locator("[data-testid^='growup-token-']")).toHaveCount(0);
  });

  // ── ⑥ 신호가 안 오면 조용히 안 그린다 ─────────────────────────────────────
  /**
   * `usePendingChoices` 는 `retry:false` 다 — 구 서버·조회 실패에서 데이터가 **`undefined`** 로
   * 남는다. 이 앱은 그 상태를 '없음'으로 읽어 사고를 낸 전력이 있고(`deckMissing(undefined)`),
   * 반대 방향(모른다 → 전원 표시)도 똑같이 사고다. 여기서는 **fail-closed** 가 옳다:
   * 화면은 멀쩡하고 뱃지만 안 뜬다. (양성 앵커를 같이 세워 ⑥ 이 공허해지지 않게 한다.)
   */
  test("⑥ /api/growth/choices 가 500 이어도 덱은 멀쩡하고, 뱃지만 안 뜬다", async ({ page }) => {
    await openDeck(page, null, { growthReady: READY });
    await expectBadgeReadable(page, "MF1"); // 대조군 — 목이 살아 있을 땐 분명히 뜬다

    /* ⚠️ 500 목은 `openDeck` **뒤에** 걸어야 한다 — Playwright 는 **나중에 등록된** 라우트를
       쓰므로, 앞에 걸면 `bootstrap` 의 200 목이 그대로 이긴다(초판이 그래서 red 였다).
       그 상태에서도 이 테스트는 "뱃지 0" 만 요구했으면 통과했을 것이다 = 위 대조군이 그 구멍을 막는다. */
    await page.route((url) => url.pathname === "/api/growth/choices", (r) => r.fulfill({ status: 500, body: "boom" }));
    await page.reload();

    await expect(page.getByTestId("token-MF1"), "앵커 — 화면은 살아 있다").toHaveCount(1);
    await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
    await expect(page.locator("[data-testid^='growup-token-']")).toHaveCount(0);
  });
});

// ── ⑦ 데스크탑 덱에도 붙는다 ────────────────────────────────────────────────
/**
 * ⚠️ **A1/A2 와 스코프 판단이 다르고, 그건 의도다.** 탭 레이아웃(A1)과 선수 메뉴(A2)는 *폰 화면
 * 개편*이라 폭으로 갈렸지만, 이건 **정보**다 — 같은 덱셋팅 화면에서 폭에 따라 "누가 강화 가능한지"가
 * 사라질 이유가 없다. 그래서 `DeckPage` 가 `layout` 과 **무관하게** 넘기고, 이 계약이 그 사실을
 * 박제한다(폰 전용으로 좁히는 변이가 여기서 죽는다).
 * 메뉴 뱃지(④)는 데스크탑에 메뉴 자체가 없으므로 여기 없다 — 그게 A2 ⑨ 와 정합이다.
 */
test.describe("데스크탑 덱 — 같은 신호", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("⑦ 데스크탑(1280)에서도 대기 있는 선수에만 ↑ 가 붙는다", async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 1280, height: 800 });
    await openDeck(page, null, { growthReady: READY });

    await expectBadgeReadable(page, "MF1");
    await expect(page.getByTestId("growup-token-FW2")).toHaveCount(0);
    await expect(page.locator("[data-testid^='growup-token-']")).toHaveCount(READY.length);
  });
});
