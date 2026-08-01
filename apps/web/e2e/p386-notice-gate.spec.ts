import { expect, test, type Page } from "@playwright/test";
import { mockNoticeWorld, registerNewUser, seedToken } from "./p386-mocks";

/**
 * #386 ① — **신규 유저가 공지를 본다** (route-mock 전용, 백엔드/데모 8080 무접촉).
 *
 * hero 제보: "처음 가입 유저도 공지사항을 볼 수 있는 상태야? 튜토리얼 끝나면 … 보여줘야 할 것 같은데."
 *
 * W1 재현으로 확인한 실체는 **두 겹**이다.
 *  ⓐ 홈 마지막 스텝에서 [덱 구성] 타일을 안 누르고 [다음]을 누르면 온보딩이 **완료로 저장되지
 *     않아**(`seen` 이 덱 스텝 2개를 영영 못 채운다) 접속할 때마다 코치마크가 처음부터 다시 돈다.
 *  ⓑ 코치마크가 도는 방문은 공지를 미루는데(#248b), ⓐ 때문에 **그 "다음 진입"이 영영 안 온다**.
 *     매 세션 첫 홈이 곧 튜토리얼 방문이라 항상 미뤄지고, 홈에서 바로 경기하러 가는 유저는
 *     한 번도 못 본다.
 *
 * hero 확정(2026-08-01): **코치마크가 끝나면 그 자리에서 바로 띄운다**(#248b 의 "완료 직후 같은
 * 화면엔 안 띄운다"를 뒤집는다 — 그 계약도 이 이슈에서 같이 고쳐 쓴다) + **유저가 직접 끝낸
 * 온보딩은 완료로 저장한다**(건너뛰기와 같은 규칙).
 *
 * ⚠️ 이 파일은 **가입부터** 재현한다. `tutorialDone:false` 만 목킹해 홈으로 바로 들어가면
 *    스타터팩·`isNew` 신호가 빠져 실제 신규 유저 동선이 아니다.
 */

const NOTICE_TITLE = "오시야스 합류!";

/** 지금 화면에 보이는 코치마크를 [다음]으로 끝까지 넘긴다(= 유저가 안내를 다 읽고 끝낸 것). */
async function clickThroughCoachmarks(page: Page): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    const bubble = page.getByTestId("tutorial-bubble");
    if ((await bubble.count()) === 0) break;
    seen.push((await bubble.getAttribute("data-step-id")) ?? "?");
    await page.getByTestId("tutorial-next").click();
    await page.waitForTimeout(150);
  }
  return seen;
}

test.describe("#386 ① 신규 유저 — 코치마크가 끝나면 공지가 뜬다", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("코치마크가 도는 동안은 공지가 안 뜬다 (무회귀 — 온보딩 우선)", async ({ page }) => {
    await mockNoticeWorld(page);
    await registerNewUser(page);

    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);
    // 화면을 덮는 다이얼로그는 코치마크 하나뿐이다.
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);

    // **미룸이지 삼킴이 아니다** — 아직 아무것도 소진되지 않았다.
    expect(await page.evaluate(() => window.sessionStorage.getItem("hmb.notice.closed.v1"))).toBeNull();
    expect(await page.evaluate(() => window.localStorage.getItem("hmb.notice.dismissed.v1"))).toBeNull();
  });

  /**
   * ⚠️ **변이체 킬 대상 ①** — `HomePage` 의 "이번 방문 동안 한 번이라도 튜토리얼이 돌았으면 계속
   * 미룬다"는 래치(`tutorialHeldThisVisit`)를 되살리면 여기가 죽는다. 그 래치가 ⓐ와 겹쳐
   * "영영 안 뜸"을 만들던 축이다.
   */
  test("홈에서 안내를 다 넘기면 **같은 화면에서** 공지가 뜬다", async ({ page }) => {
    await mockNoticeWorld(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();

    const steps = await clickThroughCoachmarks(page);
    expect(steps.length, "홈 코치마크를 실제로 넘겼다").toBeGreaterThan(0);

    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("notice-title")).toHaveText(NOTICE_TITLE);
    // 코치마크와 공지가 겹쳐 뜨지 않는다(둘 다 화면을 덮는다).
    await expect(page.getByTestId("tutorial-bubble")).toHaveCount(0);
  });

  /**
   * ⚠️ **변이체 킬 대상 ②** — `advanceOrEnd` 가 유저 클릭 종료에도 완료를 저장하지 않던 동작으로
   * 되돌리면 여기가 죽는다(완료 호출 0 · 리로드하면 코치마크가 처음부터 또 돈다).
   *
   * 완료 저장은 서버에서 **덱 지급**(#209)의 트리거이기도 하다 — 이게 안 걸리면 신규 유저는
   * 덱 없이 남는다.
   */
  test("유저가 직접 끝낸 온보딩은 **완료로 저장된다** — 리로드해도 다시 안 돌고 공지가 뜬다", async ({
    page,
  }) => {
    const st = await mockNoticeWorld(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();
    await clickThroughCoachmarks(page);
    await expect(page.getByTestId("notice-popup")).toBeVisible();

    expect(st.completeCalls, "POST /api/me/tutorial-complete 호출 수").toBe(1);

    // 리로드 = 새 세션(코치마크 진행 상태는 메모리에만 산다). 서버 플래그가 섰으므로 다시 돌지 않는다.
    await page.reload();
    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("tutorial-bubble")).toHaveCount(0);
  });

  test("골든 패스 무회귀 — [덱 구성] 타일 → 덱 스텝 완료 → 홈 복귀 시 공지", async ({ page }) => {
    const st = await mockNoticeWorld(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();

    // 마지막 홈 스텝(덱 CTA)까지 넘긴 뒤 **하이라이트된 타일을 누른다**(코치마크는 비-모달).
    for (let i = 0; i < 12; i++) {
      const id = await page.getByTestId("tutorial-bubble").getAttribute("data-step-id");
      if (id === "deck") break;
      await page.getByTestId("tutorial-next").click();
      await page.waitForTimeout(150);
    }
    await page.getByTestId("home-tile-deck").click();
    await expect(page).toHaveURL(/\/deck$/);
    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();
    await clickThroughCoachmarks(page);
    expect(st.completeCalls, "덱 스텝까지 마친 완료 저장").toBe(1);

    await page.locator('[data-testid="nav-home"]:visible').first().click();
    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByTestId("notice-popup")).toBeVisible();
  });

  test("무회귀 — 온보딩을 마친 유저는 진입 즉시 공지를 본다", async ({ page }) => {
    await seedToken(page);
    await mockNoticeWorld(page, { tutorialDone: true });
    await page.goto("/home");
    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("tutorial-bubble")).toHaveCount(0);
  });

  test("무회귀 — 코치마크 중에도 [공지 다시 보기] 진입점은 살아 있다", async ({ page }) => {
    await mockNoticeWorld(page);
    await registerNewUser(page);
    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();
    await expect(page.getByTestId("notice-center-open")).toBeVisible();
  });
});
