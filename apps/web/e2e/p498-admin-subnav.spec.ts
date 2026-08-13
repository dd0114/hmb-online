import { expect, test, type Page } from "@playwright/test";

/**
 * #498 — admin 하단탭 7칸 + 운영 화면 서브탭 (안 A).
 *
 * ⚠️ **이 스펙이 막는 것은 "화면이 깨진다"가 아니다.** 8칸이던 시절에도 가로 오버플로는 0 이었고
 * (실측 `document.scrollWidth == clientWidth`, 320/360/390 전부), 라벨 여유도 8.3px 남아 있었다.
 * 실제 결함은 **칸 폭 40.0px** 로 iOS HIG 44pt · Material 48dp 를 밑돈 것과, 그래서 다음 운영
 * 화면(9칸 35.6px)에서 확장 헤드룸이 0 이었던 것이다. 그래서 계약도 **폭 하한**으로 건다.
 *
 * ⚠️ 폭은 뷰포트/칸수라 계산으로도 나온다 — 그런데 **`flex:1 1 0` 이 실제로 균등분할하고 있나**와
 * **패딩·gap 이 없나**는 계산이 모른다. 실측으로 재는 이유다(라벨이 길어져 `nowrap` 으로 칸을
 * 밀어내는 회귀도 여기서 죽는다).
 */

const PHONE_WIDTHS = [320, 360, 390] as const;
/** iOS HIG 44pt. Material 48dp 는 더 크지만 하한은 둘 중 낮은 쪽으로 잡는다. */
const MIN_TAP_PX = 44;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mockApi(page: Page, isAdmin: boolean) {
  // ⚠️ catch-all 을 **먼저** 등록한다(Playwright 는 나중 핸들러가 이긴다).
  // ⚠️ glob 이 아니라 pathname 술어 — `**\/api\/**` 는 vite 소스 `/src/api/*.ts` 까지 잡아
  //    모듈 로딩을 깨고 흰 화면이 된다.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          // isAdmin 은 additive — 비admin 은 **필드 자체가 없다**(부재 = 비admin).
          user: isAdmin
            ? { id: "u9", nickname: "관리자", isAdmin: true }
            : { id: "u2", nickname: "심사위원B" },
          wallet: { points: 100 },
          records: { wins: 0, draws: 0, losses: 0 },
        }),
      ),
  );
}

async function seedToken(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
}

/** 하단탭 각 칸의 실측 폭. 사이드바(≥1024px)는 별개 표현이라 세지 않는다. */
async function tabWidths(page: Page): Promise<number[]> {
  const nav = page.getByTestId("nav-bottom");
  const buttons = nav.locator("button");
  const n = await buttons.count();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const box = await buttons.nth(i).boundingBox();
    // 하단탭은 폰 폭에서 항상 보인다 — 박스가 없으면 그 자체가 결함이다.
    expect(box, `탭 ${i} 의 박스를 못 잰다`).not.toBeNull();
    out.push(box!.width);
  }
  return out;
}

test.describe("#498 admin 네비 (route-mock)", () => {
  test("(a) admin 하단탭은 7칸이고 320px 에서도 44pt 를 지킨다", async ({ page }) => {
    await mockApi(page, true);
    await seedToken(page);

    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/admin");
      await expect(page.getByTestId("admin-page")).toBeVisible();

      const widths = await tabWidths(page);
      expect(widths, `${width}px — 칸 수`).toHaveLength(7);
      for (const w of widths) {
        // 8칸이던 시절 320px 에서 40.0px 였다. 이 하한이 그 상태를 되돌리는 변경을 죽인다.
        expect(w, `${width}px — 칸 폭 ${w.toFixed(1)}px`).toBeGreaterThanOrEqual(MIN_TAP_PX);
      }

      // AC4 — 가로 오버플로 0. (8칸에서도 참이었으므로 이것만으로는 회귀를 못 잡는다.
      //        위 폭 하한과 **짝**으로만 의미가 있다.)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px — 가로 넘침`).toBeLessThanOrEqual(0);
    }
  });

  test("(b) 비admin 은 6칸 그대로 — 운영·이벤트 진입점이 DOM 에 없다", async ({ page }) => {
    await mockApi(page, false);
    await seedToken(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/home");
    // 홈은 자기가 내비라 하단탭을 안 그린다(#286) — 탭이 뜨는 화면으로 간다.
    await page.goto("/me");
    await expect(page.getByTestId("nav-bottom")).toBeVisible();

    expect(await tabWidths(page)).toHaveLength(6);
    await expect(page.getByTestId("nav-admin")).toHaveCount(0);
    await expect(page.getByTestId("nav-events")).toHaveCount(0);
    await expect(page.getByTestId("admin-subnav")).toHaveCount(0);
  });

  test("(c) 서브탭이 두 운영 화면을 오간다 — 하단탭 활성은 [운영] 에 남는다", async ({ page }) => {
    await mockApi(page, true);
    await seedToken(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/admin");
    await expect(page.getByTestId("admin-subnav-admin")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("nav-admin").first()).toHaveAttribute("aria-current", "page");

    // 이벤트 보드로 — 하단탭에 그 칸이 없으므로 **이 서브탭이 유일한 진입 경로**다.
    await page.getByTestId("admin-subnav-events").click();
    await page.waitForURL("**/event-board");
    await expect(page.getByTestId("event-board-page")).toBeVisible();
    await expect(page.getByTestId("admin-subnav-events")).toHaveAttribute("aria-current", "page");
    // 활성 탭이 [운영] 에 남는다 — 안 그러면 어느 탭도 안 켜져 "어디에 있는지"가 사라진다.
    await expect(page.getByTestId("nav-admin").first()).toHaveAttribute("aria-current", "page");

    // 되돌아가기.
    await page.getByTestId("admin-subnav-admin").click();
    await page.waitForURL("**/admin");
    await expect(page.getByTestId("admin-page")).toBeVisible();
  });

  test("(d) `/event-board` 직접 진입(북마크)도 그대로 열린다 — 라우트를 없애지 않았다", async ({
    page,
  }) => {
    await mockApi(page, true);
    await seedToken(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/event-board");
    await expect(page.getByTestId("event-board-page")).toBeVisible();
    await expect(page.getByTestId("admin-subnav")).toBeVisible();
  });
});
