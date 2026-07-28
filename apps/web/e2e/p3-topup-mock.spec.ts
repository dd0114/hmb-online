import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * P3 W-D 충전 탭 목업 route-mock E2E (PRD-v4 §1 D / **AC-D1**).
 *
 * 핵심 계약 = "충전 상자 클릭 → 안내 모달만, **어떤 상태 변화도 없음**".
 * 그래서 이 스펙은 UI 노출뿐 아니라 **탭 진입 이후 네트워크 요청 수 == 0** 과
 * **포인트 배지 불변**을 함께 박제한다. 충전 탭에 fetch/mutation/invalidate 가
 * 끼어드는 순간 여기서 깨진다.
 *
 * 백엔드 없이 vite dev + page.route 목킹으로 돈다(서버 의존 0).
 */

const POINTS = 4_200;

const ME_RESPONSE = {
  user: { id: "U1", nickname: "테스터", provider: "guest" },
  wallet: { points: POINTS },
  records: { played: 0, wins: 0, draws: 0, losses: 0 },
};

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page: Page) {
  // pathname 매칭 — glob '**/api/**' 는 vite 소스 /src/api/*.ts 까지 잡아 모듈로딩을 깬다.
  // Playwright 는 나중에 등록한 핸들러가 우선 → catch-all 먼저, 구체 라우트 뒤에.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) => route.fulfill(json(ME_RESPONSE)),
  );
  await page.route(
    (url) => url.pathname === "/api/players",
    (route) => route.fulfill(json([])),
  );
  // #232: 충전 탭 노출은 서버 플래그(shop.gemTopup.enabled)가 정한다 — 이 스펙의 주제가 그 탭이므로 켠다.
  // (운영 발행물 기본값은 false 라 실제 화면에는 탭이 없다 — 그 계약은 currency-display.spec.ts 소관.)
  await mockAppConfig(page, { topupEnabled: true });
}

async function openShop(page: Page) {
  await mockApi(page);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/shop");
  // 지갑이 실린 뒤부터 카운트를 시작해야 초기 로딩 요청과 구분된다.
  await expect(page.getByTestId("points-badge")).toHaveAttribute("data-points", String(POINTS));
}

test("AC-D1: 충전 탭 상자 클릭 → 안내 모달만, API 요청 0 · 포인트 불변", async ({ page }) => {
  await openShop(page);

  // 기존 뽑기 동선 무회귀 — 기본 탭은 뽑기이고 기존 testid 가 그대로 보인다.
  await expect(page.getByTestId("shop-tab-gacha")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gacha-single")).toBeVisible();
  await expect(page.getByTestId("gacha-ten")).toBeVisible();

  // 여기서부터 발생하는 모든 요청을 기록한다(AC-D1 감시 지점).
  const requests: string[] = [];
  page.on("request", (req) => requests.push(`${req.method()} ${req.url()}`));

  await page.getByTestId("shop-tab-topup").click();
  await expect(page.getByTestId("topup-panel")).toBeVisible();
  await expect(page.getByTestId("shop-tab-topup")).toHaveAttribute("aria-selected", "true");
  // 충전 탭에서는 뽑기 버튼이 사라진다.
  await expect(page.getByTestId("gacha-single")).toHaveCount(0);

  // 목업 패키지 4종 노출 + 총 지급 포인트 표기.
  for (const [id, points] of [
    ["starter", "1000"],
    ["basic", "5500"],
    ["plus", "12000"],
    ["mega", "30000"],
  ] as const) {
    await expect(page.getByTestId(`topup-package-${id}`)).toHaveAttribute("data-points", points);
  }
  // 보너스% 표기가 실제로 렌더된다.
  await expect(page.getByTestId("topup-package-plus")).toContainText("보너스 20%");

  // 상자 클릭 → 안내 모달.
  await page.getByTestId("topup-package-mega").click();
  const modal = page.getByTestId("topup-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("결제 준비 중");
  await expect(modal).toContainText("충전은 admin에게 문의하세요");
  // admin 문의 동선 안내가 있어야 한다.
  await expect(page.getByTestId("topup-modal-contact")).toContainText("admin");

  // ── AC-D1 본체: 상태 변화 0 ──────────────────────────────────────────
  const apiCalls = requests.filter((r) => r.includes("/api/"));
  expect(apiCalls, `충전 동선에서 API 호출이 발생했다: ${apiCalls.join(", ")}`).toEqual([]);
  await expect(page.getByTestId("points-badge")).toHaveAttribute("data-points", String(POINTS));

  // 확인 버튼으로 닫힌다.
  await page.getByTestId("topup-modal-confirm").click();
  await expect(modal).toHaveCount(0);

  // 뽑기 탭으로 되돌아가도 기존 동선 그대로(무회귀) — 여전히 요청 0.
  await page.getByTestId("shop-tab-gacha").click();
  await expect(page.getByTestId("gacha-single")).toBeVisible();
  await expect(page.getByTestId("points-badge")).toHaveAttribute("data-points", String(POINTS));
  expect(requests.filter((r) => r.includes("/api/"))).toEqual([]);
});

test("충전 탭 모바일 390px 가로 오버플로 0", async ({ page }) => {
  await openShop(page);
  await page.getByTestId("shop-tab-topup").click();
  await expect(page.getByTestId("topup-panel")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // 모달을 연 상태에서도 오버플로 0.
  await page.getByTestId("topup-package-mega").click();
  await expect(page.getByTestId("topup-modal")).toBeVisible();
  const overflowModal = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowModal).toBeLessThanOrEqual(0);
});
