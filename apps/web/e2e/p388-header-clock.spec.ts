import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #388 — **한 화면이 두 시각을 말하지 않는다** (route-mock 전용, 백엔드/데모 8080 무접촉).
 *
 * 라이브 제보(engine@0.34.0 스모크): 같은 순간에 헤더는 `25'`, 로그줄은 `48'~51'`. 매치 전체로
 * 헤더가 `0→44'` 를 흐르는 동안 로그줄·타임라인은 `0→90'` 을 쓴다 — 정확히 2배.
 *
 * 원인은 축이 둘이었다는 것이다: 엔진은 45분(하프 1350틱)을 돌리고 표기만 0~90' 로 스케일해
 * (`displayMinutes`, #365) 스냅샷·이벤트에 `minute` 을 **구워서** 내린다. 로그줄은 그 값을 읽는데
 * 헤더(그리고 장면 목록·핀 툴팁)만 `floor(tick / 60)` 으로 **틱을 분으로 직독**했다.
 *
 * ⚠️ **픽스처는 지어낸 로그가 아니라 실로그다** — `scripts/gen-p388-fixture.ts` 가 라이브와 같은
 * config(`defaultEngineConfig`: 45분/표기 90분)로 실제 경기를 돌려 앞 600틱을 잘라 만든다.
 * 매핑을 손으로 적으면 계약이 "내가 적은 규칙"을 검사하게 되고, 엔진이 표기 규칙을 바꾸는 날
 * **화면과 함께 조용히 틀린다** — 이 결함이 정확히 그 모양으로 생겼다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다(glob 은 vite 소스까지 잡아 흰 화면).
 */

const MATCH_ID = "m-p388";
const HALF1 = JSON.parse(
  readFileSync(new URL("./fixtures/p388-half1.json", import.meta.url).pathname, "utf8"),
) as {
  tickSnapshots: { tick: number; minute: number }[];
  events: { tick: number; minute: number; type: string }[];
};

/** 픽스처 마지막 틱 = 표기 20'. 구 규칙(`tick/60`)이면 10' 이라 어긋남이 눈에 보인다. */
const SEEK_TICK = HALF1.tickSnapshots[HALF1.tickSnapshots.length - 1]!.tick;
const EXPECTED_MINUTE = HALF1.tickSnapshots[HALF1.tickSnapshots.length - 1]!.minute;

async function mockApi(page: Page, state: string = "FIRST_HALF") {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/me") {
        return route.fulfill({
          json: { user: { id: "u1", nickname: "테스터", isAdmin: false }, wallet: { points: 0, gems: 0 } },
        });
      }
      if (p === `/api/matches/${MATCH_ID}`) {
        return route.fulfill({
          json: {
            id: MATCH_ID,
            state,
            createdAt: "2026-08-01T09:00:00Z",
            opponent: { name: "봇 FC" },
          },
        });
      }
      if (p === `/api/matches/${MATCH_ID}/halves/1/log`) return route.fulfill({ json: HALF1 });
      if (p === "/api/players") return route.fulfill({ json: [] });
      if (p === "/api/deck") return route.fulfill({ json: { formation: "4-4-2", slots: [] } });
      return route.fulfill({ json: {} });
    },
  );
}

async function openStage(page: Page, state: string = "FIRST_HALF") {
  await mockApi(page, state);
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible({ timeout: 20_000 });
  /*
   * 감독시간에는 무대가 상시가 아니라 `경기장면` 탭 뒤다(#244) — 장면 목록(돌려보기 컨트롤)은
   * 그 화면에서만 열린다. 셸을 먼저 기다린 뒤 연다(매치 응답 전엔 탭이 아직 없다 — matchui 선례).
   */
  {
    const tab = page.getByTestId("stage-tab-stage");
    await tab.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    if (await tab.count()) await tab.click();
  }
  await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible();
  await page.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 20_000 },
  );
}

/** 재생을 멈추고 정확히 그 틱에 세운다 — 헤더와 로그줄을 **같은 순간**에 읽기 위해. */
async function seekTo(page: Page, tick: number) {
  await page.evaluate((t) => {
    const v = (window as never as { __viewer: { pause?: () => void; seek(t: number): void } }).__viewer;
    v.pause?.();
    v.seek(t);
  }, tick);
  await page.waitForTimeout(300);
}

test.describe("#388 헤더 시계 — 로그줄과 같은 시각을 말한다", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /**
   * ⚠️ **변이체 킬 대상** — `clockLabel` 을 틱 직독(`floor(tick/60)`)으로 되돌리면 여기가 죽는다.
   * 그 상태가 hero 가 본 화면이다(헤더 10' / 로그줄 20').
   */
  test("헤더 시계 = 그 순간 로그줄의 분 (2배 어긋남 0)", async ({ page }) => {
    await openStage(page);
    await seekTo(page, SEEK_TICK);

    const clock = (await page.getByTestId("stage-clock").textContent())?.trim();
    expect(clock, "헤더가 표기 분을 말한다").toBe(`${EXPECTED_MINUTE}'`);
    // 구 규칙이 만들던 값이 아님을 못박는다(정확히 절반).
    expect(clock).not.toBe(`${Math.floor(SEEK_TICK / 60)}'`);

    // 같은 순간의 로그줄 — 마지막 줄의 분이 헤더를 넘지 않고, 같은 축 위에 있다.
    await page.getByTestId("stage-tab-log").click();
    const rows = page.getByTestId("stage-panel-log").locator("li");
    const lastText = (await rows.last().textContent()) ?? "";
    const lastMinute = Number(/^(\d+)'/.exec(lastText.trim())?.[1]);
    expect(Number.isFinite(lastMinute), `로그줄에서 분을 읽었다: ${lastText}`).toBe(true);
    // 재생 위치까지의 줄만 보이므로 로그줄 ≤ 헤더, 그리고 **절반이 아니다**.
    expect(lastMinute).toBeLessThanOrEqual(EXPECTED_MINUTE);
    expect(lastMinute).toBeGreaterThan(Math.floor(SEEK_TICK / 60));
    await page.screenshot({ path: "test-results/p388-header-vs-log.png" });
  });

  /**
   * AC5 — 같은 화면의 **장면 목록·핀 툴팁**도 같은 축이어야 한다. 헤더만 고치면 로그줄 20' 옆에서
   * 장면 목록이 `10'00"` 라고 말한다(같은 뿌리, 다른 소비자).
   */
  test("장면 목록·핀 툴팁도 구워진 분을 쓴다 (`mm'ss\"` 절반 표기 0)", async ({ page }) => {
    // ⚠️ 장면 목록은 **돌려보기(review) 화면**에만 있다 — 관전 무대(플레이 모드)엔 컨트롤이 아예
    //    없다(#148/#216). 그래서 감독시간의 `경기장면` 탭(#244)에서 잰다.
    await openStage(page, "HALFTIME");
    await seekTo(page, SEEK_TICK);

    const scenes = page.getByTestId("viewer-scenes-half1").locator("li button");
    const n = await scenes.count();
    // 픽스처에 세이브 2 · 유효슛이 들어 있다 — 0 이면 계약이 공허해지므로 그 자체를 막는다.
    expect(n, "장면 목록에 핀이 있어야 이 계약이 무언가를 검사한다").toBeGreaterThan(0);

    for (let i = 0; i < n; i += 1) {
      const text = (await scenes.nth(i).textContent()) ?? "";
      // 초 표기(`10'00"`)가 남아 있으면 그건 틱 직독 폴백 경로다.
      expect(text, `장면 ${i} 시각이 분 표기여야 한다: ${text}`).not.toMatch(/\d+'\d\d"/);
      const min = Number(/(\d+)'/.exec(text)?.[1]);
      expect(Number.isFinite(min)).toBe(true);
      expect(min).toBeLessThanOrEqual(EXPECTED_MINUTE);
    }

    // 핀 툴팁(aria-label)도 같은 문자열을 쓴다 — 목록과 툴팁이 갈라지지 않는다.
    const pins = page.locator('[data-testid^="viewer-pin-"]');
    if (await pins.count()) {
      const label = (await pins.first().getAttribute("aria-label")) ?? "";
      expect(label).not.toMatch(/\d+'\d\d"/);
    }
    await page.screenshot({ path: "test-results/p388-scenes.png" });
  });
});
