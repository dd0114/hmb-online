import { expect, test, type Page } from "@playwright/test";
import { appConfigPayload } from "./app-config-mock";

/**
 * #479 — 첫 진입 스플래시(adboost #475 동결본) → `[게임 시작]` → 현행 로그인 폼.
 *
 * ⚠️ 라우트는 **pathname** 으로 잡는다(오리진 없는 글롭은 vite 에셋까지 삼켜 흰 화면 — 모듈 CLAUDE.md).
 * ⚠️ 백엔드는 안 띄운다 — `/api/*` 를 전면 목킹한다. 안 하면 `:8080` 라이브 데모에 붙고(모듈 규율)
 *    `/api/config` 가 실패하면 `MaintenanceGate`(#477)가 라우터를 대체해 스플래시가 아예 안 뜬다.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mockApi(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/config") return route.fulfill(json(appConfigPayload()));
      return route.fulfill(json({}));
    },
  );
}

/**
 * 스플래시 소재 요청을 관측한다 — 경로 해석이 라우트마다 깨지는 부류(#479 F3)를 잡는 유일한 축.
 *
 * ⚠️ **`startsWith` 여야 한다.** `includes("/splash/")` 로 잡으면 vite dev 가 서브하는 소스 모듈
 * (`/src/splash/SplashScreen.tsx` 등 5건)까지 소재로 세서 개수 단언이 137 → 142 로 어긋난다.
 * 같은 실수를 `page.route` 쪽에서 하면 더 나쁘다 — **컴포넌트의 JS 자체가 차단돼** 스플래시가
 * 아예 렌더되지 않는다(이 스펙을 쓰면서 실제로 두 건이 그렇게 깨졌다).
 */
function isSplashAsset(pathname: string) {
  return pathname.startsWith("/splash/");
}

function watchSplashAssets(page: Page) {
  const ok = new Set<string>();
  const bad: string[] = [];
  page.on("response", (res) => {
    const p = new URL(res.url()).pathname;
    if (!isSplashAsset(p)) return;
    if (res.status() >= 400) bad.push(`${res.status()} ${p}`);
    else ok.add(p);
  });
  return { ok, bad };
}

/** 무대 안 base 이미지의 현재 src(= 지금 화면에 있는 프레임). */
function currentFrame(page: Page) {
  return page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>('[data-testid="splash-stage"] .hmb-pane img');
    return img?.getAttribute("src") ?? null;
  });
}

test.describe("#479 첫 진입 스플래시", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("① 첫 진입은 스플래시다 — 로그인 폼은 아직 DOM 에 없다", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/login");

    await expect(page.getByTestId("splash")).toBeVisible();
    await expect(page.getByTestId("splash-start")).toBeVisible();
    // ⚠️ 오버레이로 덮는 것이 아니라 **대체**다 — 폼이 뒤에 살아 있으면 탭 순서·스크린리더가
    //    두 화면을 동시에 읽고, 오버레이 뒤에서 눌리는 자리가 생긴다.
    await expect(page.getByTestId("provider-choose")).toHaveCount(0);
  });

  test("② 소재 137건이 전부 200 이고 404 가 0 이다", async ({ page }) => {
    const seen = watchSplashAssets(page);
    await page.setViewportSize(PHONE);
    await page.goto("/login");

    // preload 는 전량이 끝나야 재생이 시작된다 → 진행 표시가 사라지는 것이 완료 신호다.
    await expect(page.getByTestId("splash-progress")).toHaveText("", { timeout: 60_000 });

    expect(seen.bad, `실패한 소재 요청: ${seen.bad.join(", ")}`).toEqual([]);
    // ⚠️ 절대 수치다 — `import-splash-assets.mjs` 반입물(137장)과 쇼 참조가 맞물린 결과이고,
    //    경로 해석이 틀리면 여기서 0 에 가깝게 떨어진다(그때 위 `bad` 도 같이 찬다).
    expect(seen.ok.size).toBe(137);
    for (const p of seen.ok) expect(p.endsWith(".webp")).toBe(true);
  });

  test("③ 연출이 실제로 흐른다 — 시간이 지나면 프레임이 바뀐다", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/login");
    await expect(page.getByTestId("splash-progress")).toHaveText("", { timeout: 60_000 });

    // 컷 ①(steal 65~71, 0~1.6s) → 컷 ③(steal 14~70) 사이면 프레임이 반드시 다르다.
    const first = await currentFrame(page);
    expect(first, "재생 시작 시점에 프레임이 붙어 있지 않다").toMatch(/\/splash\/seq\//);
    await page.waitForTimeout(2500);
    const later = await currentFrame(page);
    expect(later).toMatch(/\/splash\/seq\//);
    // ⚠️ rAF 루프가 죽어 첫 프레임에 굳는 회귀를 이 한 줄이 문다(정지 화면은 `toBeVisible` 을 통과한다).
    expect(later).not.toBe(first);
  });

  test("④ [게임 시작] → 현행 로그인 폼 4개가 그대로 나온다", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/login");
    await page.getByTestId("splash-start").click();

    await expect(page.getByTestId("splash")).toHaveCount(0);
    await expect(page.getByTestId("provider-choose")).toBeVisible();
    for (const id of ["provider-mock:google", "provider-mock:apple", "provider-local", "provider-guest"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  /**
   * ⚠️ #479 D4 — 버튼은 **preload 완료를 기다리지 않는다**. 4.19MB 를 다 받기 전에 아무도 갇히지
   * 않아야 한다. 소재 응답을 지연시켜 "아직 로딩 중" 상태를 실제로 만든 뒤 누른다.
   * (이 계약이 없으면 "로드 완료 후에만 활성" 로 되돌리는 변이가 전 스펙을 통과한다 — 로컬은
   * 너무 빨라서 그 차이가 안 보인다.)
   */
  test("⑤ 소재 로딩 중에도 [게임 시작] 이 동작한다", async ({ page }) => {
    // ⚠️ 지연은 **expect/click 타임아웃보다 훨씬 길어야 한다.** 처음 30s 로 잡았더니
    //    `disabled={progress !== null}` 변이가 **살아남았다** — playwright 의 `click()` 이 "활성이
    //    될 때까지" 자동 대기하면서 30s 를 그냥 기다렸고, 지연이 끝나 로드가 완료되자 버튼이
    //    풀려 통과했다(34.3s). 즉 그 계약은 "로딩 중"이 아니라 "언젠가 눌린다"를 재고 있었다
    //    (모듈 §계약이 초록으로 거짓말하는 방식). 이제 자동 대기로 넘길 수 없다.
    await page.route(
      (url) => isSplashAsset(url.pathname),
      async (route) => {
        await new Promise((r) => setTimeout(r, 120_000));
        await route.abort();
      },
    );
    await page.setViewportSize(PHONE);
    await page.goto("/login");

    // 아직 로딩 중이라는 것을 화면에서 확인한다(진행 표시가 남아 있다).
    await expect(page.getByTestId("splash-progress")).toHaveText(/불러오는 중/);
    // 그 상태에서 **지금** 활성이어야 한다 — 대기로 넘기지 않는다.
    await expect(page.getByTestId("splash-start")).toBeEnabled({ timeout: 2_000 });
    await page.getByTestId("splash-start").click({ timeout: 5_000 });
    await expect(page.getByTestId("provider-choose")).toBeVisible();
  });

  test("⑥ 세션당 1회 — 다시 /login 으로 와도 스플래시가 없다", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/login");
    await page.getByTestId("splash-start").click();
    await expect(page.getByTestId("provider-choose")).toBeVisible();

    await page.goto("/login");
    await expect(page.getByTestId("provider-choose")).toBeVisible();
    await expect(page.getByTestId("splash")).toHaveCount(0);
  });

  /** 공유 딥링크(#298)로 온 사람의 방문 목적은 그 링크의 목적지다 — 광고를 앞에 세우지 않는다. */
  test("⑦ ?returnTo= 로 들어오면 스플래시를 건너뛴다", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/login?returnTo=%2Fshare%2Fnotice%2Fabc");
    await expect(page.getByTestId("provider-choose")).toBeVisible();
    await expect(page.getByTestId("splash")).toHaveCount(0);
  });

  /**
   * ⚠️ 무대는 **contain(레터박스)** 이다. cover 로 깔면 폰에서 좌우 각 96 무대단위가 잘리는데
   * 이 광고의 인과 배지(`pill`)는 좌우 여백이 40단위뿐이라 hero 가 리뷰한 배지 양끝이 잘린다.
   * 그래서 9:16 비율과 "뷰포트를 넘지 않는다"를 같이 잰다.
   */
  for (const [label, vp] of [
    ["폰 390×844", PHONE],
    ["데스크탑 1280×800", DESKTOP],
  ] as const) {
    test(`⑧ 무대가 9:16 을 지키고 뷰포트를 넘지 않는다 — ${label}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto("/login");
      await expect(page.getByTestId("splash")).toBeVisible();

      const box = await page.locator('[data-testid="splash-stage"] .hmb-stage').boundingBox();
      expect(box, "무대가 없다").not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(vp.width + 1);
      expect(box!.height).toBeLessThanOrEqual(vp.height + 1);
      expect(box!.height / box!.width).toBeCloseTo(1920 / 1080, 1);

      // 문서 가로 스크롤 0 (모듈 규율: 넘치면 스크롤이 아니라 부모가 늘어난다)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  /**
   * ⚠️ `toBeVisible()` 은 **뷰포트 밖도 통과한다**(모듈 CLAUDE.md §계약이 초록으로 거짓말하는
   * 방식 #3). 스플래시의 유일한 조작점이라 좌표 + 자기 히트테스트로 잰다.
   */
  for (const [label, vp] of [
    ["폰 390×844", PHONE],
    ["데스크탑 1280×800", DESKTOP],
  ] as const) {
    test(`⑨ [게임 시작] 이 화면 안에서 실제로 눌린다 — ${label}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto("/login");
      const btn = page.getByTestId("splash-start");
      await expect(btn).toBeVisible();

      const box = (await btn.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('[data-testid="splash-start"]') !== null;
      }, [box.x + box.width / 2, box.y + box.height / 2] as const);
      expect(hit, "버튼 중앙이 다른 요소에 가려져 있다").toBe(true);
    });
  }
});
