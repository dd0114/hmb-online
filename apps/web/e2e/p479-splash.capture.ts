import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { appConfigPayload } from "./app-config-mock";

/**
 * #479 — 첫 진입 스플래시 실화면 캡처(독립 QA / hero 컨펌 자료).
 *
 * 계약이 아니라 **눈으로 볼 자료**다(그래서 `*.capture.ts` — 판정 게이트에 섞이지 않는다).
 * 루트 §2-2: 인지 갭("보이는 것 vs 데이터")은 좌표 추론이 아니라 실화면으로 확인한다.
 *
 * 실행:
 *   cd apps/web && CI=1 WEB_E2E_PORT=5287 npx playwright test --config=playwright.capture.config.ts p479-splash
 *
 * 산출 = `.p479/` (gitignore — 모듈 관례).
 *
 * ⚠️ **시각은 벽시계로 잡는다.** 원본 플레이어의 `__seek` 전역은 이설하지 않았고(SPA 에 전역
 * 훅을 심지 않는다), 대신 preload 완료 시점을 t0 로 삼아 오프셋만큼 기다린다. 프레임 단위로
 * 정확하지는 않지만 이 캡처의 목적은 "그 컷이 제대로 그려지나"라 충분하다.
 */

const OUT = ".p479";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** 컷별 확인 포인트(초). 동결본 컷 경계에서 뽑았다 — `ad-show.ts` 의 T 참조. */
const MOMENTS: readonly { at: number; name: string; look: string }[] = [
  { at: 0.9, name: "01-coldopen-goal", look: "① 콜드오픈 — 골망 버스트 + 「골이 터진다」 슬램" },
  { at: 2.6, name: "02-say1-card", look: "② 지시① — 감독의 한마디 카드만 선명, 나머지 흐림 + 파란 배지" },
  { at: 6.4, name: "03-result1-goal", look: "③ 결과① — 골 순간 펀치인 + GOAL 슬램" },
  { at: 7.9, name: "04-say2-composited", look: "④ 지시② — **합성 문구**「패스 길목만 노려…」+ 카운터 22/500" },
  { at: 11.4, name: "05-result2-goal", look: "⑤ 결과② — 끊고 역습 골 + GOAL" },
  { at: 12.2, name: "06-collection", look: "⑥ 수집 — 뽑기 실화면 + 불투명 플레이트 문구" },
  { at: 14.2, name: "07-cta", look: "⑦ CTA — HMB 온라인 타이틀 + 서브 + 파란 버튼" },
];

async function mockApi(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/config")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(appConfigPayload()),
        });
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    },
  );
}

for (const [label, vp] of [
  ["phone-390x844", PHONE],
  ["desktop-1280x800", DESKTOP],
] as const) {
  test(`#479 스플래시 컷 7개 — ${label}`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await mockApi(page);
    await page.setViewportSize(vp);
    await page.goto("/login");

    // preload 완료 = 진행 표시가 빈다. 여기서부터 t0.
    await expect(page.getByTestId("splash-progress")).toHaveText("", { timeout: 90_000 });
    const t0 = Date.now();

    for (const m of MOMENTS) {
      const wait = m.at * 1000 - (Date.now() - t0);
      if (wait > 0) await page.waitForTimeout(wait);
      await page.screenshot({ path: `${OUT}/${label}-${m.name}.png` });
      console.log(`[p479] ${label} ${m.name} — ${m.look}`);
    }

    // 로그인 폼 전환 후 화면도 한 장(무회귀 눈 확인용).
    await page.getByTestId("splash-start").click();
    await expect(page.getByTestId("provider-choose")).toBeVisible();
    await page.screenshot({ path: `${OUT}/${label}-08-login-form.png` });
  });
}
