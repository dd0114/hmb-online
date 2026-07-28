import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #233 — **후반 진행 중 헤더 스코어**가 전반 스코어를 잃지 않는다.
 *
 * 제보 재현(라이브 DB 실경기, 전반 1:4): 후반 킥오프 헤더가 `0 : 0`, 후반 2골 뒤 `0 : 6` 이 아니라
 * `0 : 2` 였다 — 헤더가 **그 하프 로그만** 세고 있었다. 규칙은 하나다:
 *
 *   헤더 = [서버 확정] 이미 끝난 하프  +  [재생] 지금 하프의 플레이헤드 델타
 *
 * ⚠️ 이 스펙은 **전반 스코어를 목 API 값(1:4)으로 못 박아** 단언한다 — 픽스처에서 유도하지 않는다.
 * 유도하면 구현과 같은 식이 되어 항진명제가 된다(#226 독립검증 minor-5 가 그 지적이었다).
 * 후반 델타만 픽스처에서 읽고, 그 델타가 0 이 아님을 신선도 가드로 확인한다(#188 패턴).
 *
 * 라우트 매칭은 pathname 술어로 한다 — glob('**\/api\/**') 는 vite 소스까지 잡아 흰 화면이 된다.
 */

const MATCH_ID = "m-p233";
/** 목 API 가 내려주는 전반 확정 스코어. 헤더 단언의 **독립 앵커**다. */
const H1 = { home: 1, away: 4 };

interface Snap {
  tick: number;
}
interface Ev {
  tick: number;
  minute: number;
  type: string;
  team?: "home" | "away";
}

/** 데모 로그(전반 형상) → 후반 형상. 실제 후반 로그는 틱이 **절대값**(전반 끝 다음부터)이다. */
function asSecondHalf(log: { tickSnapshots: Snap[]; events: Ev[] }) {
  const offset = log.tickSnapshots[log.tickSnapshots.length - 1]!.tick + 1;
  const shift = <T extends { tick: number; minute?: number }>(x: T): T => ({
    ...x,
    tick: x.tick + offset,
    ...(typeof x.minute === "number" ? { minute: Math.floor((x.tick + offset) / 60) } : {}),
  });
  return {
    log: {
      ...log,
      tickSnapshots: log.tickSnapshots.map(shift),
      events: log.events.map(shift),
    },
    offset,
  };
}

const DEMO = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
) as { tickSnapshots: Snap[]; events: Ev[] };
const { log: H2_LOG, offset: H2_START } = asSecondHalf(DEMO);
const H2_GOALS = H2_LOG.events.filter((e) => e.type === "goal");

/** 두 번째 골 직후 = 델타가 확실히 0 이 아닌 지점. */
const PROBE_TICK = H2_GOALS[1] ? H2_GOALS[1].tick + 1 : 0;
/** 그 지점까지의 **후반만의** 델타 — 배포본이 헤더에 그리던 값. */
const DELTA = {
  home: H2_GOALS.filter((g) => g.tick <= PROBE_TICK && g.team === "home").length,
  away: H2_GOALS.filter((g) => g.tick <= PROBE_TICK && g.team === "away").length,
};

const DECK = {
  formation: "4-3-3",
  slots: Array.from({ length: 11 }, (_, i) => ({ slotIndex: i, playerId: `p${i + 1}`, role: "starter" as const })),
};
const PLAYERS = Array.from({ length: 11 }, (_, i) => ({
  id: `p${i + 1}`,
  name: `선수${i + 1}`,
  position: i === 0 ? "GK" : "MF",
  grade: "B",
}));

async function mockApi(page: Page, detail: Record<string, unknown>, log: unknown = H2_LOG) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill({ json: detail });
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: log });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
}

async function openSecondHalf(
  page: Page,
  over: Record<string, unknown> = {},
  opts: { waitForCanvas?: boolean } = {},
) {
  await mockApi(page, {
    id: MATCH_ID,
    state: "SECOND_HALF",
    scoreH1Home: H1.home,
    scoreH1Away: H1.away,
    // 후반 진행 중에는 서버가 후반·최종 스코어를 내려주지 않는다(스포일러 금지 계약).
    scoreHome: null,
    scoreAway: null,
    result: null,
    createdAt: "2026-07-28T04:00:00Z",
    opponent: { name: "봇 FC" },
    ...over,
  });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
  if (opts.waitForCanvas === false) return;
  await page.locator('[data-testid="viewer-canvas-half2"]').waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(() => (window as unknown as ViewerWindow).__viewer?.pause?.());
}

interface ViewerWindow {
  __viewer?: { pause?: () => void; seek?: (t: number) => void };
}

async function seek(page: Page, tick: number) {
  await page.evaluate((t) => (window as unknown as ViewerWindow).__viewer?.seek?.(t), tick);
  await expect
    .poll(() => page.getByTestId("stage-clock").textContent(), { timeout: 10_000 })
    .toBe(`${Math.floor(tick / 60)}'`);
}

const score = (page: Page) => page.getByTestId("stage-score");

test.use({ viewport: { width: 390, height: 844 } });

test.describe("#233 후반 헤더 스코어", () => {
  test("픽스처 신선도 — 후반 델타가 0 이면 이 스펙은 아무것도 증명하지 못한다", () => {
    expect(H2_GOALS.length, "데모 로그에 골이 2개 이상 있어야 한다(재생성 시 확인)").toBeGreaterThanOrEqual(2);
    expect(DELTA.home + DELTA.away, "프로브 지점의 후반 델타가 0 이면 before/after 가 같아진다").toBeGreaterThan(0);
  });

  test("a. 후반 킥오프에도 전반 스코어가 살아 있다(`0 : 0` 아님)", async ({ page }) => {
    await openSecondHalf(page);
    await seek(page, H2_START);
    await expect(score(page)).toContainText(`${H1.home} : ${H1.away}`);
  });

  test("b. 후반 골은 전반 위에 쌓인다 — 후반만의 점수를 경기 점수로 그리지 않는다", async ({ page }) => {
    await openSecondHalf(page);
    await seek(page, PROBE_TICK);

    const expected = `${H1.home + DELTA.home} : ${H1.away + DELTA.away}`;
    await expect(score(page)).toContainText(expected);
    // 배포본이 그리던 값(= 후반 델타만)이 화면에 남아 있으면 안 된다.
    await expect(score(page)).not.toContainText(`${DELTA.home} : ${DELTA.away}`);
  });

  test("c. 되감아도 전반 스코어가 무너지지 않는다(제보 재현 경로)", async ({ page }) => {
    await openSecondHalf(page);
    await seek(page, PROBE_TICK);
    await seek(page, H2_START);
    await expect(score(page)).toContainText(`${H1.home} : ${H1.away}`);
  });

  test("d. 로그 패널 골 라인도 같은 스코어를 말한다(헤더와 어긋나지 않게)", async ({ page }) => {
    await openSecondHalf(page);
    await page.getByTestId("stage-toggle-log").click();
    await seek(page, PROBE_TICK);

    const goalRows = page.locator('[data-testid="stage-panel-log"] li', { hasText: "GOAL" });
    await expect(goalRows.last()).toContainText(`${H1.home + DELTA.home}-${H1.away + DELTA.away}`);
  });

  test("e. 전반 확정값 없는 후반(구 매치)은 '-' — 틀린 숫자를 대신 그리지 않는다", async ({ page }) => {
    await openSecondHalf(page, { scoreH1Home: null, scoreH1Away: null });
    await seek(page, PROBE_TICK);
    await expect(score(page)).toContainText("- : -");
  });
});

/**
 * #233 스코프 추가(hero) — **경기 시간이 안 보인다**. 값은 있었지만 12px muted 로 구석에 있었고
 * 플레이헤드 도착 전엔 요소가 통째로 사라졌다. 여기서 거는 건 "존재"가 아니라 **읽히는 크기**다.
 */
test.describe("#233 경기 분 상시 표시", () => {
  test("f. 후반 재생 중 경기 분이 헤더에 보인다 — 재생 위치 기준(실경과 시간 아님)", async ({ page }) => {
    await openSecondHalf(page);
    await seek(page, PROBE_TICK);

    const clock = page.getByTestId("stage-clock");
    await expect(clock).toBeVisible();
    await expect(clock).toHaveText(`${Math.floor(PROBE_TICK / 60)}'`);

    // 배포본이 12px 였다 — "있긴 한데 안 보인다"로 되돌아가지 않게 크기를 계약으로 건다.
    const px = await clock.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(px, "경기 분은 구석 캡션이 아니라 읽히는 크기여야 한다").toBeGreaterThanOrEqual(15);
  });

  test("g. 로그가 아직 안 왔어도 시계 슬롯은 있다(`--'`)", async ({ page }) => {
    // ⚠️ 캔버스가 뜬 뒤에 재면 이미 플레이헤드가 도착해 있어 아무것도 증명하지 못한다
    //    (독립검증 minor-3: 슬롯을 접는 변이체가 이 자리를 통과했다). **로그 응답을 붙잡아** 진짜
    //    "플레이헤드 이전" 상태를 만든다.
    let releaseLog: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseLog = resolve;
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) {
        await held;
        return route.fulfill({ json: H2_LOG });
      }
      return route.fallback();
    });
    await openSecondHalf(page, {}, { waitForCanvas: false });

    const clock = page.getByTestId("stage-clock");
    await expect(clock).toBeVisible();
    await expect(clock).toHaveText("--'");
    // 스코어는 이미 진실을 말한다 — 전반 확정값은 로그와 무관하게 서버가 준다.
    await expect(score(page)).toContainText(`${H1.home} : ${H1.away}`);

    releaseLog();
    await page.locator('[data-testid="viewer-canvas-half2"]').waitFor({ state: "visible", timeout: 30_000 });
    await expect.poll(() => clock.textContent(), { timeout: 10_000 }).not.toBe("--'");
  });
});

test.describe("무회귀 — 전반은 그대로 재생을 따라간다", () => {
  test("FIRST_HALF 헤더는 플레이헤드 스코어", async ({ page }) => {
    // 전반은 앞에 끝난 하프가 없다 = 베이스라인 0. 서버도 scoreH1 을 내려주지 않는다.
    // ⚠️ 여기엔 **전반 형상 로그(DEMO, 틱 0~)** 를 쓴다 — 후반 형상을 전반 자리에 먹이면 지금은
    //    분기가 state 기반이라 통과하지만 규칙이 틱 파생으로 바뀌는 날 조용히 무의미해진다
    //    (독립검증 minor-6).
    await mockApi(
      page,
      {
        id: MATCH_ID,
        state: "FIRST_HALF",
        scoreH1Home: null,
        scoreH1Away: null,
        createdAt: "2026-07-28T04:00:00Z",
        opponent: { name: "봇 FC" },
      },
      DEMO,
    );
    await page.addInitScript(() => {
      localStorage.setItem("hmb.auth.token", "mock-token");
      localStorage.setItem("hmb.auth.provider", "local");
    });
    await page.goto(`/match/${MATCH_ID}`);
    await page.locator('[data-testid="viewer-canvas-half1"]').waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(() => (window as unknown as ViewerWindow).__viewer?.pause?.());
    await seek(page, PROBE_TICK - H2_START);
    // 전반은 그 로그의 델타가 곧 스코어다(H1 베이스라인이 더해지면 안 된다).
    await expect(score(page)).toContainText(`${DELTA.home} : ${DELTA.away}`);
  });
});
