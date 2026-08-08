import { expect, test, type Page } from "@playwright/test";
import { appConfigPayload } from "./app-config-mock";
import { skipSplash } from "./splash-mock";

/**
 * #477 — **백엔드가 죽어도 web(CF Pages)은 뜬다.** 그때 유저가 보는 것이 빈 화면·정체불명 에러가
 * 아니라 "점검 중 + 연락처" 여야 한다.
 *
 * 두 가지 죽는 방식을 모두 태운다 — 실제 운영에서 둘 다 겪는다:
 *  a. **터널 사망** → 응답 자체가 없다(fetch reject = playbook §4 의 "Failed to fetch").
 *  b. **터널은 살고 도커만 사망** → Cloudflare 가 502/503 을 준다(fetch 는 성공한다).
 *
 * 그리고 **오탐 가드**가 같은 무게로 중요하다 — 백엔드가 멀쩡하면 이 화면은 절대 뜨면 안 된다.
 *
 * ⚠️ 라우트는 **pathname** 으로 잡는다(오리진 없는 글롭은 vite 에셋까지 삼켜 흰 화면 — CLAUDE.md).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const isApi = (url: URL) => url.pathname.startsWith("/api/");

/** 백엔드가 정상일 때의 최소 응답(로그인 화면이 뜨는 데 필요한 만큼). */
async function serveHealthy(page: Page) {
  await page.route(
    (url) => isApi(url),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/config") return route.fulfill(json(appConfigPayload()));
      return route.fulfill(json({}));
    },
  );
}

test("터널 사망(응답 없음) → 점검 안내 + 연락처가 뜬다", async ({ page }) => {
  await page.route((url) => isApi(url), (route) => route.abort("connectionrefused"));

  await skipSplash(page);
  await page.goto("/login");

  const screen = page.getByTestId("maintenance-screen");
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("maintenance-contact")).toHaveAttribute(
    "href",
    /open\.kakao\.com\//,
  );
  await expect(page.getByTestId("maintenance-retry")).toBeVisible();

  // ⚠️ QR 은 **백엔드가 죽어 있는 지금** 떠야 의미가 있다(PC 유저의 유일한 연락 수단).
  // `toBeVisible()` 은 깨진 이미지도 통과하므로 실제로 픽셀이 왔는지(`naturalWidth`)를 본다 —
  // 경로를 `/api/...` 로 옮기는 변이가 여기서 죽는다(이 테스트의 목은 /api/ 를 전부 끊는다).
  const qr = page.getByTestId("maintenance-contact-qr");
  await expect(qr).toBeVisible();
  await expect
    .poll(() => qr.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test("백엔드만 사망(502) → 같은 점검 안내가 뜬다", async ({ page }) => {
  await page.route(
    (url) => isApi(url),
    (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }),
  );

  await skipSplash(page);
  await page.goto("/login");

  await expect(page.getByTestId("maintenance-screen")).toBeVisible({ timeout: 30_000 });
});

test("복구: 백엔드가 살아난 뒤 [다시 시도] 를 누르면 점검 화면이 사라진다", async ({ page }) => {
  let alive = false;
  await page.route(
    (url) => isApi(url),
    (route) => {
      if (!alive) return route.abort("connectionrefused");
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/config") return route.fulfill(json(appConfigPayload()));
      return route.fulfill(json({}));
    },
  );

  await skipSplash(page);
  await page.goto("/login");
  await expect(page.getByTestId("maintenance-screen")).toBeVisible({ timeout: 30_000 });

  alive = true; // 워치독이 터널을 되살렸다
  await page.getByTestId("maintenance-retry").click();

  await expect(page.getByTestId("maintenance-screen")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("provider-choose")).toBeVisible({ timeout: 30_000 });
});

/**
 * 로그인 **후** 경로에서 죽는 경우 (2R · 패널 S2 반박).
 *
 * 위 세 건은 `/login` 만 봤다. 게이트가 라우터 바깥이라 구조상 같은 경로라고 **주장**할 수는
 * 있지만, 주장과 검정은 다르다 — 실제로 유저가 장애를 만나는 자리는 거의 항상 로그인 뒤다.
 */
test("로그인 후 화면(/home)에서 백엔드가 죽어도 같은 점검 안내가 뜬다", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.route((url) => isApi(url), (route) => route.abort("connectionrefused"));

  await page.goto("/home");

  await expect(page.getByTestId("maintenance-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("maintenance-contact")).toBeVisible();
});

/**
 * **로그인 도중에 죽는 경우** (3R · 패널 S2 소수의견).
 *
 * 앞선 케이스들은 부팅 시점(`GET /api/config`)에 이미 죽어 있는 상태였다. 여기서는 앱이 정상
 * 부팅한 뒤 **유저가 버튼을 누른 그 순간** 백엔드가 사라진다 — 터널이 유휴 중 죽는 실제 패턴과
 * 같은 모양이고, 토큰을 얻기 전이라 "로그인 후 경로"에도 속하지 않는 사각이다.
 */
test("로그인 요청 도중 백엔드가 죽으면 점검 안내로 넘어간다", async ({ page }) => {
  let alive = true;
  await page.route(
    (url) => isApi(url),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (!alive) return route.abort("connectionrefused");
      if (p === "/api/config") return route.fulfill(json(appConfigPayload()));
      if (p.startsWith("/api/auth/")) {
        alive = false; // 이 요청을 마지막으로 터널이 사라진다
        return route.abort("connectionrefused");
      }
      return route.fulfill(json({}));
    },
  );

  await skipSplash(page);
  await page.goto("/login");
  await expect(page.getByTestId("provider-choose")).toBeVisible({ timeout: 30_000 });

  // 게스트도 닉네임 단계를 거쳐야 실제 요청(POST /api/auth/login)이 나간다 —
  // 버튼만 누르면 화면 전환뿐이라 백엔드에 닿지 않는다(초판이 여기서 틀렸다).
  await page.getByTestId("provider-guest").click();
  await page.getByLabel("닉네임").fill("점검테스터");
  await page.getByRole("button", { name: "계속" }).click();

  await expect(page.getByTestId("maintenance-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("maintenance-contact")).toBeVisible();
});

/**
 * **앱 에러는 점검이 아니다** (3R · 패널 S2 가 남긴 경계).
 *
 * 500 은 백엔드가 살아서 응답한 것이다(요청을 받고 처리하다 실패했다). 그걸 "점검 중"으로
 * 덮으면 ①원인을 숨기고 ②멀쩡한 다른 화면까지 못 쓰게 만든다. 게이트웨이 5xx(502/503/504)와
 * 애플리케이션 5xx(500)를 가르는 것이 이 기능의 판별선이고, 그 선을 여기에 박는다.
 */
test("앱 자체 에러(500)는 점검으로 오인하지 않는다", async ({ page }) => {
  await page.route(
    (url) => isApi(url),
    (route) => route.fulfill(json({ code: "INTERNAL_ERROR", message: "boom" }, 500)),
  );

  await skipSplash(page);
  await page.goto("/login");

  await expect(page.getByTestId("provider-choose")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(7_000); // 확인 프로브 창(≈4s)을 넘겨서도
  await expect(page.getByTestId("maintenance-screen")).toHaveCount(0);
});

/** 401 은 인증 문제다 — 로그인으로 보내야지 점검 화면으로 덮을 일이 아니다. */
test("인증 실패(401)는 점검으로 오인하지 않는다", async ({ page }) => {
  await page.route(
    (url) => isApi(url),
    (route) => route.fulfill(json({ code: "UNAUTHORIZED", message: "no" }, 401)),
  );

  await skipSplash(page);
  await page.goto("/login");

  await expect(page.getByTestId("provider-choose")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(7_000);
  await expect(page.getByTestId("maintenance-screen")).toHaveCount(0);
});

test("오탐 가드: 백엔드가 정상이면 점검 화면이 뜨지 않는다", async ({ page }) => {
  await serveHealthy(page);

  await skipSplash(page);
  await page.goto("/login");
  await expect(page.getByTestId("provider-choose")).toBeVisible({ timeout: 30_000 });
  // 확인 프로브 창(2회 × 2s ≈ 4s)보다 넉넉히 기다린 뒤에도 뜨면 안 된다.
  //
  // ⚠️ 이 대기는 **거짓 green 쪽으로 틀릴 수 없다**(패널 S1 지적에 대한 답). 점검 화면은
  // 프로브가 실패해야만 뜨는데 이 테스트의 목은 전부 200 을 돌려준다 — 느린 머신이라고
  // 200 이 실패로 바뀌지 않는다. 머신이 느리면 이 테스트는 **더 늦게 통과**할 뿐이고,
  // 실제로 회귀(정상인데 뜬다)가 생기면 그 원인은 지연이 아니라 판정이라 7초 뒤에도 떠 있다.
  await page.waitForTimeout(7_000);
  await expect(page.getByTestId("maintenance-screen")).toHaveCount(0);
});
