import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 자체 로그인(id/비번) 브라우저 E2E — PRD-v4 §A (AC-A1, AC-A2), P3-D2.
 *
 * server-java Phase3 웨이브가 아직 /api/auth/register 를 안 냈으므로 **route-mock 전용**이다
 * (백엔드/데모 8080 무접촉 — vite dev 만 뜨면 실행된다). 라이브 왕복은 통합 게이트에서 별도.
 *
 * ⚠️ 라우트 매칭은 glob('**\/api/**')이 아니라 **pathname 술어**로 한다 —
 *    glob 은 vite 소스(/src/api/*.ts)까지 잡아 모듈 로딩을 깨고 흰 화면이 된다(w3-trade-mock 선례).
 */

const PASSWORD = "sup3rs3cret";
const LOGIN_ID = "tester01";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const ME_RESPONSE = {
  user: { id: "u1", nickname: "테스터" },
  wallet: { points: 3000 },
  records: { wins: 0, draws: 0, losses: 0 },
};

interface AuthMocks {
  register?: (route: Route) => void;
  login?: (route: Route) => void;
}

/** 로비 진입까지 필요한 최소 /api 목킹 + auth 엔드포인트. 요청 body 를 수집해 돌려준다. */
async function mockApi(page: Page, mocks: AuthMocks = {}) {
  const requests: { path: string; body: unknown }[] = [];

  // catch-all 먼저 — Playwright 는 나중에 등록한 핸들러가 우선한다.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) => route.fulfill(json(ME_RESPONSE)),
  );
  await page.route(
    (url) => url.pathname === "/api/auth/register",
    (route) => {
      requests.push({ path: "/api/auth/register", body: route.request().postDataJSON() });
      if (mocks.register) return mocks.register(route);
      return route.fulfill(json({ token: "tok_new", user: { id: "u1", nickname: "신규감독" }, isNew: true }));
    },
  );
  await page.route(
    (url) => url.pathname === "/api/auth/login",
    (route) => {
      requests.push({ path: "/api/auth/login", body: route.request().postDataJSON() });
      if (mocks.login) return mocks.login(route);
      return route.fulfill(json({ token: "tok_local", user: { id: "u1", nickname: "테스터" }, isNew: false }));
    },
  );

  return requests;
}

async function openLocalPanel(page: Page) {
  await page.goto("/login");
  await expect(page.getByTestId("provider-choose")).toBeVisible();
  await page.getByTestId("provider-local").click();
  await expect(page.getByTestId("local-auth-form")).toBeVisible();
}

async function fillCredentials(page: Page, loginId = LOGIN_ID, password = PASSWORD) {
  await page.getByTestId("local-login-id").fill(loginId);
  await page.getByTestId("local-password").fill(password);
}

/** localStorage 전체 덤프 — 비밀번호 잔존 검사(AC-A2)용. */
async function storageDump(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      parts.push(`${key}=${localStorage.getItem(key)}`);
    }
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i)!;
      parts.push(`session:${key}=${sessionStorage.getItem(key)}`);
    }
    return parts.join("\n");
  });
}

test.describe("AC-A1 — 자체 로그인 진입점 (기존 플로우 무회귀)", () => {
  test("provider 화면에 기존 3버튼 + 아이디 진입점이 공존한다", async ({ page }) => {
    await mockApi(page);
    await page.goto("/login");
    await expect(page.getByTestId("provider-mock:google")).toBeVisible();
    await expect(page.getByTestId("provider-mock:apple")).toBeVisible();
    await expect(page.getByTestId("provider-guest")).toBeVisible();
    await expect(page.getByTestId("provider-local")).toBeVisible();
  });

  test("기존 게스트 플로우가 그대로 동작한다 (무회귀)", async ({ page }) => {
    const requests = await mockApi(page);
    await page.goto("/login");
    await page.getByTestId("provider-guest").click();
    await page.getByPlaceholder("2~16자").fill("게스트1");
    await page.getByRole("button", { name: "계속" }).click();

    await expect(page).toHaveURL(/\/lobby$/);
    expect(requests).toEqual([
      { path: "/api/auth/login", body: { nickname: "게스트1", provider: "guest" } },
    ]);
  });

  test("아이디 경로는 OAuth 동의 모달을 거치지 않는다", async ({ page }) => {
    await mockApi(page);
    await openLocalPanel(page);
    await expect(page.getByTestId("consent-modal")).toHaveCount(0);
    await expect(page.getByTestId("local-auth-form")).toHaveAttribute("data-mode", "login");
  });
});

test.describe("AC-A1 — 회원가입", () => {
  test("회원가입 성공 → 스타터팩 모달 → /lobby (provider 뱃지 '아이디')", async ({ page }) => {
    const requests = await mockApi(page);
    await openLocalPanel(page);
    await page.getByTestId("local-mode-toggle").click();
    await fillCredentials(page);
    await page.getByTestId("local-nickname").fill("신규감독");
    await page.getByTestId("local-submit").click();

    // isNew=true → 기존 신규 동선과 동일한 스타터팩 모달.
    await expect(page.getByText("스타터 팩 지급")).toBeVisible();
    await page.getByRole("button", { name: "확인" }).click();
    await expect(page).toHaveURL(/\/lobby$/);
    await expect(page.getByTestId("provider-badge")).toHaveText("아이디");

    expect(requests).toEqual([
      {
        path: "/api/auth/register",
        body: { loginId: LOGIN_ID, password: PASSWORD, nickname: "신규감독" },
      },
    ]);
  });

  test("409 DUPLICATE_LOGIN_ID → 아이디 필드 에러, 화면 유지", async ({ page }) => {
    await mockApi(page, {
      register: (route) =>
        route.fulfill(json({ code: "DUPLICATE_LOGIN_ID", message: "duplicate login id" }, 409)),
    });
    await openLocalPanel(page);
    await page.getByTestId("local-mode-toggle").click();
    await fillCredentials(page);
    await page.getByTestId("local-nickname").fill("신규감독");
    await page.getByTestId("local-submit").click();

    await expect(page.getByTestId("local-error-loginId")).toHaveText("이미 사용 중인 아이디입니다");
    await expect(page).toHaveURL(/\/login$/);
    expect(await storageDump(page)).not.toContain("hmb.auth.token");
  });
});

test.describe("AC-A1 — 로그인", () => {
  test("로그인 성공 → /lobby", async ({ page }) => {
    const requests = await mockApi(page);
    await openLocalPanel(page);
    await fillCredentials(page);
    await page.getByTestId("local-submit").click();

    await expect(page).toHaveURL(/\/lobby$/);
    expect(requests).toEqual([
      { path: "/api/auth/login", body: { provider: "local", loginId: LOGIN_ID, password: PASSWORD } },
    ]);
  });

  test("401 BAD_CREDENTIALS → 폼 전역 에러, 로그인 화면 유지", async ({ page }) => {
    await mockApi(page, {
      login: (route) => route.fulfill(json({ code: "BAD_CREDENTIALS", message: "bad" }, 401)),
    });
    await openLocalPanel(page);
    await fillCredentials(page, LOGIN_ID, "wrongpw");
    await page.getByTestId("local-submit").click();

    await expect(page.getByTestId("local-error-form")).toHaveText(
      "아이디 또는 비밀번호가 올바르지 않습니다",
    );
    // 어느 필드가 틀렸는지는 노출하지 않는다(계정 열거 방지).
    await expect(page.getByTestId("local-error-loginId")).toHaveCount(0);
    await expect(page.getByTestId("local-error-password")).toHaveCount(0);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("클라 검증 실패는 네트워크 요청을 만들지 않는다", async ({ page }) => {
    const requests = await mockApi(page);
    await openLocalPanel(page);
    await fillCredentials(page, "ab", "1");
    await page.getByTestId("local-submit").click();

    await expect(page.getByTestId("local-error-loginId")).toBeVisible();
    await expect(page.getByTestId("local-error-password")).toBeVisible();
    expect(requests).toEqual([]);
  });
});

test.describe("AC-A2 — 비밀번호 비노출", () => {
  test("로그인 성공 후 localStorage/sessionStorage 어디에도 비밀번호가 없다", async ({ page }) => {
    await mockApi(page);
    await openLocalPanel(page);
    await fillCredentials(page);
    await page.getByTestId("local-submit").click();
    await expect(page).toHaveURL(/\/lobby$/);

    const dump = await storageDump(page);
    expect(dump).toContain("tok_local"); // 토큰은 저장(기존 계약)
    expect(dump).not.toContain(PASSWORD);
  });

  test("비밀번호 입력은 마스킹되고 제출 후 폼에서 비워진다", async ({ page }) => {
    await mockApi(page, {
      login: (route) => route.fulfill(json({ code: "BAD_CREDENTIALS", message: "bad" }, 401)),
    });
    await openLocalPanel(page);
    await expect(page.getByTestId("local-password")).toHaveAttribute("type", "password");
    await fillCredentials(page);
    await page.getByTestId("local-submit").click();

    await expect(page.getByTestId("local-error-form")).toBeVisible();
    await expect(page.getByTestId("local-password")).toHaveValue("");
  });

  test("콘솔 로그에 비밀번호가 찍히지 않는다", async ({ page }) => {
    const consoleText: string[] = [];
    page.on("console", (msg) => consoleText.push(msg.text()));
    await mockApi(page);
    await openLocalPanel(page);
    await fillCredentials(page);
    await page.getByTestId("local-submit").click();
    await expect(page).toHaveURL(/\/lobby$/);

    expect(consoleText.join("\n")).not.toContain(PASSWORD);
  });

  test("평문 목업 안내가 폼에 1줄 명시된다", async ({ page }) => {
    await mockApi(page);
    await openLocalPanel(page);
    await expect(page.getByTestId("local-plaintext-notice")).toContainText("평문");
  });

  test("390px 모바일 뷰포트에서 가로 오버플로 0", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await openLocalPanel(page);
    await page.getByTestId("local-mode-toggle").click(); // 필드가 가장 많은 회원가입 모드
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
