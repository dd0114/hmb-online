import { expect, test, type Page, type Route } from "@playwright/test";
import { skipSplash } from "./splash-mock";

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
/**
 * 로그인 id 겸 표시 닉네임. 서버(server-java)는 별도 로그인 id 컬럼 없이
 * `users.nickname`(UNIQUE)을 재사용한다 — RegisterRequest={nickname,password},
 * LoginRequest={nickname,provider,password}. 그래서 폼 입력도 하나뿐이다.
 */
const NICKNAME = "테스터01";

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
  await skipSplash(page);
  await page.goto("/login");
  await expect(page.getByTestId("provider-choose")).toBeVisible();
  await page.getByTestId("provider-local").click();
  await expect(page.getByTestId("local-auth-form")).toBeVisible();
}

async function fillCredentials(page: Page, nickname = NICKNAME, password = PASSWORD) {
  await page.getByTestId("local-nickname").fill(nickname);
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
    await skipSplash(page);
    await page.goto("/login");
    await expect(page.getByTestId("provider-mock:google")).toBeVisible();
    await expect(page.getByTestId("provider-mock:apple")).toBeVisible();
    await expect(page.getByTestId("provider-guest")).toBeVisible();
    await expect(page.getByTestId("provider-local")).toBeVisible();
  });

  test("기존 게스트 플로우가 그대로 동작한다 (무회귀)", async ({ page }) => {
    const requests = await mockApi(page);
    await skipSplash(page);
    await page.goto("/login");
    await page.getByTestId("provider-guest").click();
    await page.getByPlaceholder("2~16자").fill("게스트1");
    await page.getByRole("button", { name: "계속" }).click();

    await expect(page).toHaveURL(/\/home$/);
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

  test("회원가입 폼에 아이디/닉네임 이중 입력이 없다 (서버 단일 식별자 계약)", async ({ page }) => {
    await mockApi(page);
    await openLocalPanel(page);
    await page.getByTestId("local-mode-toggle").click();
    await expect(page.getByTestId("local-auth-form")).toHaveAttribute("data-mode", "register");
    // 구 계약의 별도 아이디 입력이 남아 있으면 실패한다.
    await expect(page.getByTestId("local-login-id")).toHaveCount(0);
    // 필드 = 식별자 1 + 비번 1.
    await expect(page.getByTestId("local-auth-form").locator("input")).toHaveCount(2);
  });
});

test.describe("AC-A1 — 회원가입", () => {
  test("회원가입 성공 → 스타터팩 모달 → /home (provider 뱃지 '아이디')", async ({ page }) => {
    const requests = await mockApi(page);
    await openLocalPanel(page);
    await page.getByTestId("local-mode-toggle").click();
    await fillCredentials(page, "신규감독");
    await page.getByTestId("local-submit").click();

    // isNew=true → 기존 신규 동선과 동일한 스타터팩 모달.
    await expect(page.getByText("스타터 팩 지급")).toBeVisible();
    await page.getByRole("button", { name: "확인" }).click();
    await expect(page).toHaveURL(/\/home$/);
    // #286: 로그인 수단 뱃지가 로비 헤더 → **[내 정보] 탭**으로 옮겼다(홈은 간결하게, hero 3R).
    await page.goto("/me");
    await expect(page.getByTestId("provider-badge")).toHaveText("아이디");

    // 서버 RegisterRequest.java 와 정확히 같은 2필드(여분 필드 0).
    expect(requests).toEqual([
      { path: "/api/auth/register", body: { nickname: "신규감독", password: PASSWORD } },
    ]);
  });

  test("409 DUPLICATE_NICKNAME → 아이디 필드 에러, 화면 유지 (AuthErrors.java)", async ({ page }) => {
    await mockApi(page, {
      register: (route) =>
        route.fulfill(json({ code: "DUPLICATE_NICKNAME", message: "이미 사용 중인 아이디입니다" }, 409)),
    });
    await openLocalPanel(page);
    await page.getByTestId("local-mode-toggle").click();
    await fillCredentials(page, "신규감독");
    await page.getByTestId("local-submit").click();

    await expect(page.getByTestId("local-error-nickname")).toHaveText("이미 사용 중인 아이디입니다");
    await expect(page).toHaveURL(/\/login$/);
    expect(await storageDump(page)).not.toContain("hmb.auth.token");
  });
});

test.describe("AC-A1 — 로그인", () => {
  test("로그인 성공 → /home", async ({ page }) => {
    const requests = await mockApi(page);
    await openLocalPanel(page);
    await fillCredentials(page);
    await page.getByTestId("local-submit").click();

    await expect(page).toHaveURL(/\/home$/);
    // 서버 LoginRequest.java 3필드 — guest 경로와 같은 엔드포인트/같은 바디 형태.
    expect(requests).toEqual([
      { path: "/api/auth/login", body: { nickname: NICKNAME, provider: "local", password: PASSWORD } },
    ]);
  });

  test("401 BAD_CREDENTIALS → 폼 전역 에러, 로그인 화면 유지", async ({ page }) => {
    await mockApi(page, {
      login: (route) => route.fulfill(json({ code: "BAD_CREDENTIALS", message: "bad" }, 401)),
    });
    await openLocalPanel(page);
    await fillCredentials(page, NICKNAME, "wrongpw");
    await page.getByTestId("local-submit").click();

    await expect(page.getByTestId("local-error-form")).toHaveText(
      "아이디 또는 비밀번호가 올바르지 않습니다",
    );
    // 어느 필드가 틀렸는지는 노출하지 않는다(계정 열거 방지).
    await expect(page.getByTestId("local-error-nickname")).toHaveCount(0);
    await expect(page.getByTestId("local-error-password")).toHaveCount(0);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("클라 검증 실패는 네트워크 요청을 만들지 않는다", async ({ page }) => {
    const requests = await mockApi(page);
    await openLocalPanel(page);
    await fillCredentials(page, "x", "1");
    await page.getByTestId("local-submit").click();

    await expect(page.getByTestId("local-error-nickname")).toBeVisible();
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
    await expect(page).toHaveURL(/\/home$/);

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
    await expect(page).toHaveURL(/\/home$/);

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
