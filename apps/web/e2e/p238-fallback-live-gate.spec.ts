import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #238 — **텍스트 폴백에도 라이브 게이트가 걸린다.**
 *
 * 시각 재생이 실패했을 때 뜨는 텍스트 타임라인의 `끝까지 보기` 에는 라이브 게이트가 **없었다**.
 * 후반 진행 중에 누르면 그 하프 이벤트가 **전부** 공개되고 스코어보드가 **경기 최종 스코어**를
 * 그렸다 — "재생 위치를 넘는 점수를 보이지 않는다"(#233, openapi `MatchDetail`: *"후반 스코어는
 * FINISHED 전까지 노출하지 않는다"*)와 정면으로 어긋난다. 도달 경로가 좁을 뿐(캔버스가 실패해야
 * 이 화면이 뜬다) 스포일러 계약의 구멍인 건 같다.
 *
 * ── 폴백을 **진짜 경로로** 띄운다 ──────────────────────────────────────────────────────────
 * 캔버스를 목으로 부수지 않는다. viewer-core 의 `loadLog` 는 `tickSnapshots·events·finalScore`
 * 중 하나라도 없으면 throw 하므로(#65 신뢰경계 검증), **`finalScore` 를 뺀 로그**를 내려주면
 * 실제 손상 로그와 같은 경로로 폴백 안내가 뜬다. 스냅샷·이벤트는 온전해서 상한 계산도 살아 있다 —
 * 이게 실서비스에서 이 화면을 보는 형태에 가장 가깝다.
 *
 * 계약:
 *  a. 라이브 후반에서 `지금까지 보기` 를 눌러도 **상한 밖 골이 안 나온다**.
 *  b. 같은 상황에서 스코어보드가 **경기 최종 스코어를 그리지 않는다**.
 *  c. 버튼 문구가 `끝까지 보기` 가 아니다 — 라이브엔 "끝"이 없다.
 *  d. 종료(FINISHED, 시계 없음) 무회귀 — 전부 보이고 문구도 `끝까지 보기` 그대로.
 */

const H2 = JSON.parse(readFileSync(new URL("./fixtures/p322-half2.json", import.meta.url).pathname, "utf8"));

const MATCH_ID = "m-238";
const HALF_REAL_MS = 420_000;

/** 후반 로그에서 `finalScore` 만 뺀다 = 코어가 throw → 실제 폴백 경로. */
const BROKEN_H2 = (() => {
  const { finalScore: _drop, ...rest } = H2;
  return rest;
})();

/** 이 하프 이벤트의 절대 틱 범위 — 상한 판정의 기준점. */
const TICKS: number[] = (H2.events as { tick: number }[]).map((e) => e.tick);
const FIRST_TICK = Math.min(...TICKS);
const LAST_TICK = Math.max(...TICKS);

function clockFor(elapsedMs: number) {
  const now = Date.now();
  const startAt = new Date(now - elapsedMs).toISOString();
  return {
    phase: "SECOND_HALF",
    kickoffAt: startAt,
    phaseStartAt: startAt,
    phaseEndsAt: new Date(now - elapsedMs + HALF_REAL_MS).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: 180_000,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
  };
}

async function open(page: Page, live: boolean) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 0, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state: live ? "SECOND_HALF" : "FINISHED",
          scoreH1Home: 1,
          scoreH1Away: 3,
          scoreHome: live ? null : 1,
          scoreAway: live ? null : 5,
          result: live ? null : "LOSS",
          createdAt: "2026-07-30T08:37:23Z",
          mode: "practice",
          ownerName: "테스터",
          opponent: { name: "봇 FC", deck: [] },
          // 라이브 하프의 **10%** 지점 — 후반 골(로그상 뒤쪽)이 아직 안 일어난 시점이다.
          clock: live ? clockFor(HALF_REAL_MS * 0.1) : null,
        },
      });
    }
    if (/halves\/1\/log$/.test(url.pathname)) return route.fulfill({ json: BROKEN_H2 });
    if (/halves\/2\/log$/.test(url.pathname)) return route.fulfill({ json: BROKEN_H2 });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({ json: { result: "LOSS", scoreHome: 1, scoreAway: 5, pointsAwarded: 0 } });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: [] });
    if (url.pathname === "/api/deck") return route.fulfill({ json: { formation: "4-3-3", slots: [] } });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
  // 손상 로그 → 시각 재생 실패 안내 → 유저가 타임라인으로 전환(자동 전환은 하지 않는 설계).
  await page.getByRole("button", { name: "타임라인으로 보기" }).click();
  await expect(page.getByTestId("viewer-timeline-half2")).toBeVisible({ timeout: 20_000 });
}

/**
 * 폴백 타임라인이 실제로 그린 이벤트들의 **틱**. 표기는 `formatClock` 의 `mm:ss` 이고 후반은
 * +45:00 오프셋이 붙으므로(로그 틱은 하프 로컬 0..2699) 되돌려 틱으로 환산한다.
 */
async function shownTicks(page: Page): Promise<number[]> {
  const texts = await page.getByTestId("viewer-timeline-half2").locator("li").allInnerTexts();
  return texts
    .map((t) => {
      const m = t.match(/(\d+):(\d+)/);
      return m ? Number(m[1]) * 60 + Number(m[2]) - 45 * 60 : NaN;
    })
    .filter((n) => Number.isFinite(n));
}

test.use({ viewport: { width: 390, height: 844 } });

/*
 * ⚠️ **a·b·c 를 한 테스트에 묶지 마라.** 처음엔 묶었는데, 변이체(상한 제거)가 **문구 단언에서 먼저
 * 죽어** 정작 스포일러 단언 두 개는 실행조차 되지 않았다 — "죽었으니 계약이 있다"고 착각하기 딱
 * 좋은 모양이다. 셋을 갈라 **각각** 변이를 죽이는지 확인했다.
 */
test("a. 라이브 후반 — 상한 밖 장면이 열리지 않는다", async ({ page }) => {
  await open(page, true);
  await page.getByTestId("viewer-skip-half2").click();
  await page.waitForTimeout(500);

  const ticks = await shownTicks(page);
  // 하프의 10% 지점이라 후반부 장면은 나오면 안 된다. 상한은 넉넉히 50% 로 둔다(드리프트 허용) —
  // 정확한 틱을 단언하면 시계 오차·페이스 튜닝마다 거짓 실패가 된다.
  const cutoff = FIRST_TICK + (LAST_TICK - FIRST_TICK) * 0.5;
  expect(ticks.length, "이벤트가 하나도 없으면 계약이 공허하다 — 표본이 잘못됐다").toBeGreaterThan(0);
  expect(Math.max(...ticks), `상한 밖 장면이 열렸다(최대 tick ${Math.max(...ticks)} > ${cutoff})`).toBeLessThan(
    cutoff,
  );
});

test("b. 라이브 후반 — 폴백 스코어보드가 최종 스코어를 그리지 않는다", async ({ page }) => {
  await open(page, true);
  await page.getByTestId("viewer-skip-half2").click();
  await page.waitForTimeout(500);
  // 이 픽스처의 후반 최종은 away 2골(전반 1:3 을 얹으면 경기 1:5) — 10% 시점에 그게 보이면 스포일러다.
  await expect(page.getByTestId("viewer-score-half2"), "폴백 스코어보드가 경기 최종을 그렸다").not.toHaveText(
    "1 : 5",
  );
});

test("c. 라이브 후반 — 버튼이 '끝까지'라고 말하지 않는다", async ({ page }) => {
  await open(page, true);
  // 라이브엔 "끝"이 없다. 문구가 남아 있으면 유저는 여전히 앞을 볼 수 있다고 믿는다.
  await expect(page.getByTestId("viewer-skip-half2")).toHaveText("지금까지 보기");
});

test("d. 종료(시계 없음) 무회귀 — 전부 열리고 문구도 그대로", async ({ page }) => {
  await open(page, false);
  const skip = page.getByTestId("viewer-skip-half2");
  await expect(skip).toHaveText("끝까지 보기");
  await skip.click();
  await page.waitForTimeout(400);
  const ticks = await shownTicks(page);
  expect(ticks.length).toBeGreaterThan(0);
  /*
   * 상한이 없으므로 **라이브였다면 막혔을 구간**이 열려야 한다. "로그 마지막 틱"으로 단언하지
   * 않는 이유: 타임라인은 `keyEvents` 로 거른 장면만 그려서 마지막 표시 장면이 마지막 이벤트보다
   * 앞이다(실측 2533 vs 2696). 그걸 단언하면 이벤트 표시 정책이 바뀔 때마다 거짓 실패가 난다.
   * 재는 것은 **게이트의 유무**다.
   */
  const cutoff = FIRST_TICK + (LAST_TICK - FIRST_TICK) * 0.5;
  expect(Math.max(...ticks), "시계가 없는데도 뒷구간이 안 열렸다 = 상한이 잘못 걸렸다").toBeGreaterThan(
    cutoff,
  );
});
