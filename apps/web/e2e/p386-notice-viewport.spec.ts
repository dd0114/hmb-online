import { expect, test, type Page } from "@playwright/test";
import { LIVE_NOTICE, mockNoticeWorld, seedToken } from "./p386-mocks";

/**
 * #386 ② — **폰에서 공지 본문이 읽히는가** (route-mock 전용, 백엔드/데모 8080 무접촉).
 *
 * hero 제보: "오시야스 공지사항 스크롤도 안 돼."
 *
 * W1 실측이 밝힌 것은 **#292 의 회귀가 아니다** — 넘침만 있으면 실터치 스크롤은 정상이다
 * (390×664 에서 이미지 위에서 쓸어올려도 scrollTop 0 → 188). 문제는 **넘침이 안 생긴다**는 것:
 *
 *   `.overlay { position: fixed; inset: 0 }` 의 높이는 **레이아웃 뷰포트**다. 아이폰13 이면 844 —
 *   툴바가 덮고 있는 부분까지 포함한 값이다. 그래서 카드가 808px 까지 자라고 본문 스크롤 여유는
 *   **9px** 밖에 안 남는데(실측), 실제로 보이는 높이는 660~745 라 **카드 아래쪽(본문 꼬리 +
 *   [닫기])이 툴바 밑으로 들어간다**. 잘린 것이 스크롤러 밖에 있으니 아무리 쓸어올려도 안 움직인다.
 *
 * 그래서 수정은 **카드를 '보이는 화면' 안에 가두는 것**이다 — 딤(`inset: 0`)은 그대로 두고 아래
 * 여백으로 툴바 몫(`100lvh − 100svh`)만 비운다. ⚠️ 오버레이 **자체**를 `height: 100svh` 로 줄이면
 * 툴바가 접히는 순간 그 아래 띠에 딤이 없어 **뒤 화면이 눌린다**(그렇게 썼다가 독립검증이 잡았다).
 *
 * ⚠️ **헤드리스 크로미움에는 툴바가 없다** — `lvh == svh == innerHeight` 라 이 파일만으로는
 *    수정의 효과를 직접 증명할 수 없다(CDP `Emulation.setVisibleSize` 는 no-op 임을 실측 확인).
 *    그래서 계약은 두 겹이다: **여기**는 "보이는 높이에서 실제로 읽히는가"(실터치·[닫기] 가시성),
 *    **`src/lobby/notice-viewport.test.ts`** 는 "카드가 레이아웃 뷰포트가 아니라 **보이는 영역**에
 *    묶여 있는가"를 CSS 소스로 박제한다. 한쪽만으로는 회귀를 못 잡는다.
 *
 * ⚠️ 모바일 제스처는 **실터치 이벤트 + 실제 폰 뷰포트**로만 잰다(`page.mouse` 금지 — 프로젝트 규칙).
 */

/** 실제 폰의 **보이는** 높이(툴바 표시 상태의 아이폰13 사파리 실측 근사). */
const VISIBLE = { width: 390, height: 664 };

/**
 * ⚠️ **`viewport:` 키를 빼먹지 마라.** 처음에 `test.use({ ...VISIBLE, hasTouch: true } as never)` 로
 * 썼고 — Playwright 는 최상위 `width`/`height` 를 **조용히 무시한다**. 그래서 이 파일 전체가
 * **1280×720 데스크탑**에서 돌았고(독립검증 실측), 폰 커버리지가 0 인 채 4/4 초록이었다.
 * 이 이슈는 **뷰포트 자체가 결함의 축**이라, 그 상태의 초록은 정확히 아무것도 검증하지 않는다.
 * `as never` 캐스트가 그 타입 에러까지 눌렀다 — 캐스트로 옵션 타입을 이기려 하지 마라.
 */
test.use({ viewport: VISIBLE, hasTouch: true });

async function openNotice(page: Page) {
  await seedToken(page);
  await mockNoticeWorld(page, { tutorialDone: true });
  await page.goto("/home");
  await expect(page.getByTestId("notice-popup")).toBeVisible();
  // 히어로 이미지는 **늦게 온다** — 로드 전 높이로 재면 접힘 자체가 안 만들어진다(#292).
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="notice-body"] img') as HTMLImageElement | null;
    return !!img && img.complete && img.naturalHeight > 0;
  });
  await page.waitForTimeout(200);
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const q = (t: string) => document.querySelector(`[data-testid="${t}"]`) as HTMLElement;
    const body = q("notice-body");
    const card = q("notice-card");
    const close = q("notice-close");
    const rect = (el: HTMLElement) => {
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) };
    };
    return {
      visibleHeight: Math.round(window.visualViewport?.height ?? window.innerHeight),
      body: { ...rect(body), scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, scrollTop: Math.round(body.scrollTop) },
      card: rect(card),
      close: rect(close),
      more: q("notice-body-area").getAttribute("data-more"),
    };
  });
}

/** 손가락으로 위로 쓸어올리기 = 아래를 읽어 내려가는 제스처(CDP 실터치 — page.mouse 아님). */
async function swipeUp(page: Page, x: number, y: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (px: number, py: number) => [{ x: px, y: py, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(x, y) });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(x, y - (dy * i) / 12) });
    await page.waitForTimeout(14);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
  await cdp.detach();
}

test.describe("#386 ② 오시야스 공지 — 폰에서 읽힌다", () => {
  /**
   * **이 파일이 폰에서 돌고 있다는 것부터 확인한다.**
   *
   * `test.use` 의 `viewport:` 키를 빠뜨리면 Playwright 는 조용히 데스크탑(1280×720)으로 돌리고,
   * 그래도 전부 초록이다(넓은 창에서는 본문이 알아서 넘치니까) — 실제로 그 상태로 4/4 통과했고
   * 독립검증이 잡았다. 뷰포트가 이 이슈의 **결함 축**이므로, 전제부터 단언한다.
   */
  test.beforeEach(async ({ page }) => {
    expect(page.viewportSize(), "폰 뷰포트에서 돌아야 의미가 있다").toEqual(VISIBLE);
  });

  /**
   * **카드가 보이는 화면을 넘지 않는다.** 이 성질이 깨지면(=카드가 레이아웃 뷰포트만큼 자라면)
   * 넘어간 부분은 스크롤러 밖이라 어떤 제스처로도 못 본다 — hero 제보의 실체가 정확히 이것이다.
   */
  test("카드 전체와 [닫기]가 보이는 화면 안에 있다", async ({ page }) => {
    await openNotice(page);
    const m = await metrics(page);
    expect(m.card.top, "카드 위 끝").toBeGreaterThanOrEqual(0);
    expect(m.card.bottom, `카드 아래 끝 ≤ 보이는 높이(${m.visibleHeight})`).toBeLessThanOrEqual(m.visibleHeight);
    expect(m.close.bottom, "[닫기]가 첫 화면에 있다").toBeLessThanOrEqual(m.visibleHeight);
    await expect(page.getByTestId("notice-close")).toBeInViewport();
  });

  /**
   * **접혔으면 접혔다고 보이고, 실제로 끝까지 내려간다.** 이미지 위에서 시작하는 스와이프도
   * 같이 잰다 — 실제 유저는 팝업의 대부분을 차지하는 히어로 이미지에 손가락을 올린다.
   */
  for (const start of ["image", "text"] as const) {
    test(`실터치 스와이프(${start} 위에서 시작)로 본문이 끝까지 내려간다`, async ({ page }) => {
      await openNotice(page);
      const before = await metrics(page);
      expect(before.body.scrollHeight, "본문이 실제로 넘친다").toBeGreaterThan(before.body.clientHeight + 1);
      expect(before.more, "넘쳤으면 '더 있다' 신호가 켜져 있다").toBe("true");
      expect(before.body.scrollTop).toBe(0);

      const target =
        start === "image"
          ? (await page.locator('[data-testid="notice-body"] img').boundingBox())!
          : (await page.getByTestId("notice-body").boundingBox())!;
      const overflow = before.body.scrollHeight - before.body.clientHeight;
      await swipeUp(
        page,
        Math.round(target.x + target.width / 2),
        Math.round(target.y + target.height * (start === "image" ? 0.5 : 0.85)),
        overflow + 120,
      );

      const after = await metrics(page);
      // "조금 움직였다"로는 부족하다 — hero 가 본 상태는 9px 이 움직이는 상태였다.
      expect(after.body.scrollTop, "스와이프 한 번으로 본문 끝까지").toBeGreaterThanOrEqual(overflow - 2);
      expect(after.more, "끝에 닿으면 신호가 꺼진다").toBe("false");
      // 마지막 문장이 실제로 화면에 들어온다.
      await expect(page.getByText("지금 상점에서 만나보세요.")).toBeInViewport();
    });
  }

  /**
   * **[공지 다시 보기] 목록도 같은 규칙을 받는다.** 팝업만 고치면 "팝업에선 읽히는데 다시 보기에선
   * 안 읽히는" 상태가 된다 — 같은 본문을 같은 렌더러로 그리는 화면이라 갈라지면 안 된다.
   * (소스 스캔은 두 파일을 다 보지만, 실측 층이 팝업만 덮고 있었다 — 독립검증 지적.)
   */
  test("[공지 다시 보기] 목록도 보이는 화면 안에서 스크롤된다", async ({ page }) => {
    // ⚠️ 활성 공지 **1건**으로는 목록이 안 넘쳐(실측 505/505) 스크롤 단언이 공허해진다.
    //    실제 운영도 여러 건이 쌓이는 화면이므로, 넘치는 상태를 만들어 두고 잰다.
    await seedToken(page);
    const many = {
      notices: [0, 1, 2, 3].map((i) => ({
        ...LIVE_NOTICE.notices[0]!,
        id: `${LIVE_NOTICE.notices[0]!.id}-${i}`,
        title: `${LIVE_NOTICE.notices[0]!.title} ${i}`,
      })),
    };
    await mockNoticeWorld(page, { tutorialDone: true, notices: many });
    await page.goto("/home");
    // 팝업 스택을 모두 닫고 나서야 헤더의 [공지 다시 보기]를 누를 수 있다.
    await expect(page.getByTestId("notice-popup")).toBeVisible();
    for (let i = 0; i < many.notices.length; i += 1) {
      if ((await page.getByTestId("notice-popup").count()) === 0) break;
      await page.getByTestId("notice-close").click();
    }
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    await page.getByTestId("notice-center-open").click();
    const panel = page.getByTestId("notice-center-list");
    await expect(panel).toBeVisible();
    // 본문을 펼친다 — 목록은 접힌 채로 열리므로 펼쳐야 실제 높이가 나온다.
    await page.getByTestId("notice-center-item-toggle").first().click();
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-testid="notice-center-list"] img') as HTMLImageElement | null;
      return !img || (img.complete && img.naturalHeight > 0);
    });
    await page.waitForTimeout(200);

    const m = await page.evaluate(() => {
      const q = (t: string) => document.querySelector(`[data-testid="${t}"]`) as HTMLElement;
      const list = q("notice-center-list");
      const close = q("notice-center-close").getBoundingClientRect();
      const panelRect = q("notice-center-close").closest("[role=dialog]")!.getBoundingClientRect();
      const opened = document.querySelector('[data-testid="notice-center-item"]') as HTMLElement;
      const img = list.querySelector("img") as HTMLImageElement | null;
      return {
        visibleHeight: Math.round(window.visualViewport?.height ?? window.innerHeight),
        panelBottom: Math.round(panelRect.bottom),
        closeBottom: Math.round(close.bottom),
        list: { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight },
        // `.item` 은 `overflow: hidden` 이라 눌리면 **소리 없이 잘린다** — 그 사실을 여기서 잰다.
        opened: { scrollHeight: opened.scrollHeight, clientHeight: opened.clientHeight },
        imgHeight: img ? Math.round(img.getBoundingClientRect().height) : 0,
      };
    });
    expect(m.panelBottom, "패널이 보이는 화면 안").toBeLessThanOrEqual(m.visibleHeight);
    expect(m.closeBottom, "[닫기]가 보이는 화면 안").toBeLessThanOrEqual(m.visibleHeight);
    await expect(page.getByTestId("notice-center-close")).toBeInViewport();

    /**
     * ⚠️ **변이체 킬 대상** — `.item` 의 `flex: 0 0 auto` 를 빼면 여기가 죽는다.
     *
     * 세로 플렉스 자식의 기본 `flex-shrink: 1` 때문에 넘치는 목록이 **스크롤되는 대신 항목을
     * 눌렀고**, `overflow: hidden` 이 눌린 만큼을 잘랐다(실측: 펼친 항목 **641 → 368**,
     * 히어로 이미지 321 아래 글 전부 소실 · `scrollHeight === clientHeight`(505/505) 라 스크롤도 불가).
     */
    // ⚠️ `soft` 인 이유: 둘 다 이 변이를 죽여야 하는데, 첫 단언이 즉시 던지면 **두 번째가 정말
    // 문지기인지 확인할 길이 없다**(실제로 그 상태에서 40px 여유가 눌린 값을 통과시키고 있었다).
    expect.soft(m.opened.scrollHeight, "펼친 항목이 눌려서 잘리지 않는다").toBeLessThanOrEqual(
      m.opened.clientHeight + 1,
    );
    /**
     * 두 번째 축 — **글이 실제로 남아 있는가**. 여유는 실측 기반이다: 히어로 이미지(321) 아래
     * 본문이 약 320px 이므로 정상은 641, 눌린 상태는 368 이다. 여유를 40 으로 잡으면 임계가 361 이라
     * **눌린 368 이 통과해 버린다**(독립검증 MIN-6 실측) — 그 여유로는 검사하는 척만 한다.
     * 200 은 "이미지 말고도 최소 200px 의 글이 남아 있다" = 눌림(47px 잔여)과 확실히 갈린다.
     */
    expect.soft(m.opened.clientHeight, "이미지 아래 글이 남아 있다").toBeGreaterThan(m.imgHeight + 200);

    // 넘친 몫은 **목록 스크롤**이 받는다 — 실터치로 실제로 내려간다(문서는 스크롤되지 않는다).
    expect(m.list.scrollHeight, "목록이 실제로 넘친다").toBeGreaterThan(m.list.clientHeight + 1);
    const box = (await page.getByTestId("notice-center-list").boundingBox())!;
    await swipeUp(page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height * 0.8), 240);
    const scrolled = await page.evaluate(
      () => (document.querySelector('[data-testid="notice-center-list"]') as HTMLElement).scrollTop,
    );
    expect(scrolled, "목록 실터치 스크롤").toBeGreaterThan(0);
    await expect(page.getByText("지금 상점에서 만나보세요.").first()).toBeInViewport();
  });

  /** 데스크탑 무회귀 — 넓은 창에서는 예전과 똑같이 동작한다(수정이 데스크탑을 건드리지 않는다). */
  test("데스크탑 1280×800 — 카드가 화면 안에 있고 [닫기]가 보인다", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openNotice(page);
    const m = await metrics(page);
    expect(m.card.bottom).toBeLessThanOrEqual(m.visibleHeight);
    await expect(page.getByTestId("notice-close")).toBeInViewport();
  });
});
