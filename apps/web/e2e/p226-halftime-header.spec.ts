import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #226 — **감독시간 헤더가 재생 플레이헤드를 따라가면 안 된다**.
 *
 * v8.01 배포 스모크에서 hero 가 본 것: 감독시간 화면 헤더가 `0 : 0 / 0'`. 같은 시점 API 는
 * `scoreH1 0:4` 로 정상이었다 = **데이터는 맞는데 화면만 틀린** 인지 갭(루트 §2-2).
 *
 * 왜 지금까지 안 잡혔나: 헤더의 "확정 스코어 우선" 규칙(#169 독립검증 major)이 **`H1_BREAK`**
 * (P4 이전 레거시 상태명)에만 걸려 있었고, 실제 배포본이 쓰는 상태는 **`HALFTIME`**(P4-E2 #170)이다.
 * 그런데 이 자리를 덮는 기존 계약(match-stage·MatchPage.test)이 전부 `H1_BREAK` 로만 열려 있어
 * 규칙이 실상태에서 빠져 있는 걸 아무도 못 봤다. → 이 스펙은 **`HALFTIME` 으로만** 연다.
 *
 * 계약:
 *  a. 헤더 스코어 = 서버의 전반 확정 스코어(`scoreH1*`). 재생이 어디에 있든 무관.
 *  b. 헤더 시계 = 전반이 끝난 지점(45'). 재생 플레이헤드를 따라가지 않는다.
 *  c. 전반 재생을 처음으로 되감아도 헤더는 `0 : 0 / 0'` 로 무너지지 않는다(제보 재현 경로).
 *  d. 전반 진행 중(FIRST_HALF)에는 여전히 재생 진행을 따라간다 — 픽스가 라이브를 죽이지 않았나.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로(glob 은 vite 소스 /src/api/*.ts 까지 잡아 흰 화면이 된다 —
 * 프로젝트 기지식 web-visual-qa-mock-harness).
 */

const MATCH_ID = "m-226";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);
const SNAPS: { tick: number; minute?: number }[] = MATCH_LOG.tickSnapshots;
const LAST_TICK: number = SNAPS[SNAPS.length - 1].tick;
const WHISTLE: { minute?: number } | undefined = (MATCH_LOG.events as { type: string; minute?: number }[]).find(
  (e) => e.type === "half_whistle" || e.type === "full_whistle",
);
/**
 * 로그가 끝난 지점의 **표기 분** — #388 이후 **로그가 구운 값**을 그대로 읽는다(휘슬 우선).
 *
 * ⚠️ 예전엔 `round(LAST_TICK / 60)` 으로 계산했다. 그건 "1틱 = 1분/60" 가정인데, 엔진은 45분
 * 경기를 0~90' 로 표기하므로(`displayMinutes`, #365) **정확히 절반**을 말한다 — 그 식이 곧 #388 의
 * 결함이었고, 그걸 기대값으로 쓰는 한 이 스펙은 버그를 계약으로 굳힌다.
 */
const END_MINUTE = `${WHISTLE?.minute ?? SNAPS[SNAPS.length - 1].minute}'`;
/** 재생 플레이헤드가 맨 앞일 때의 분 = 버그 화면의 값. 헤더가 이걸 그리면 안 된다. */
const PLAYHEAD_MINUTE = "0'";
/**
 * 픽스처 신선도 가드(#188 패턴) — **축이 실제로 둘로 갈리는 로그인가**.
 *
 * 데모 로그(gitignore 생성물)가 `displayMinutes` 없이 재생성되면 구운 분이 `tick/60` 과 같아져
 * 이 스펙이 #388 회귀(틱 직독)를 더는 구분하지 못한다 = 조용한 항진명제. 그때 고칠 것은 스펙이
 * 아니라 로그 생성 쪽이다(진짜 앵커는 `stage-state.test.ts` 의 1350틱 레짐 계약).
 */
const SCALE_IS_OBSERVABLE =
  (WHISTLE?.minute ?? SNAPS[SNAPS.length - 1].minute ?? 0) !== Math.round(LAST_TICK / 60);

const HALF_REAL_MS = 420_000;
const HALFTIME_MS = 180_000;

/** hero 가 본 그 스코어(0:4) — 재생 시작점(0:0)과 확실히 다른 값이어야 계약이 성립한다. */
const H1_HOME = 0;
const H1_AWAY = 4;

function clockFor(phase: "FIRST_HALF" | "HALFTIME", elapsedMs: number) {
  const now = Date.now();
  const windowMs = phase === "HALFTIME" ? HALFTIME_MS : HALF_REAL_MS;
  const startAt = new Date(now - elapsedMs).toISOString();
  return {
    phase,
    kickoffAt: startAt,
    phaseStartAt: startAt,
    phaseEndsAt: new Date(now - elapsedMs + windowMs).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: HALFTIME_MS,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
  };
}

const DECK = {
  formation: "4-3-3",
  slots: [
    ...Array.from({ length: 11 }, (_, i) => ({ slotIndex: i, playerId: `p${i + 1}`, role: "starter" as const })),
    ...Array.from({ length: 5 }, (_, i) => ({ slotIndex: i, playerId: `b${i + 1}`, role: "bench" as const })),
  ],
};
const PLAYERS = [
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `선수${i + 1}`,
    position: i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW",
    grade: "B",
  })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i + 1}`, name: `벤치${i + 1}`, position: i === 0 ? "GK" : "MF", grade: "C" })),
];

async function openMatch(page: Page, state: "FIRST_HALF" | "HALFTIME", elapsedMs: number) {
  const clock = clockFor(state, elapsedMs);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          clock: { ...clock, serverNow: new Date().toISOString() },
          // 전반 확정 스코어는 감독시간에 이미 서버에 있다(hero 제보 시점의 API 응답과 같은 모양).
          scoreH1Home: state === "FIRST_HALF" ? null : H1_HOME,
          scoreH1Away: state === "FIRST_HALF" ? null : H1_AWAY,
          createdAt: "2026-07-28T09:00:00Z",
          opponent: { name: "봇 FC" },
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: MATCH_LOG });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
}

/** 뷰어 플레이헤드(원시 스냅샷 틱). */
function playhead(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = (window as unknown as { __viewer?: { cur(): { tick: number } } }).__viewer;
    return v ? Number(v.cur().tick) : -1;
  });
}

/**
 * #244: 감독시간에는 무대가 **`경기장면` 탭 뒤**에 있다(hero 결정). 이 스펙은 감독시간 헤더가
 * 재생 플레이헤드를 따라가지 않는지를 재므로 **뷰어가 실제로 돌아가야** 한다 → 탭을 먼저 연다.
 * (탭이 없으면 = 관전 화면이면 그냥 지나간다.)
 */
async function openStageTab(page: Page) {
  const tab = page.getByTestId("stage-tab-stage");
  if (await tab.count()) await tab.click();
}

async function waitForViewer(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as { __viewer?: unknown }).__viewer), null, {
    timeout: 20_000,
  });
}

test.describe("#226 감독시간 헤더 — 확정 스코어·전반 종료 시각 고정", () => {
  test("a+b. HALFTIME 헤더 = 전반 확정 스코어 + 전반 종료 분", async ({ page }) => {
    await openMatch(page, "HALFTIME", 5_000);
    await openStageTab(page);
    await waitForViewer(page);

    const scorebar = page.getByTestId("stage-scorebar");
    await expect(page.getByTestId("match-state")).toHaveText("감독시간");
    // a. 재생이 어디에 있든 스코어는 서버의 전반 확정값이다.
    await expect(page.getByTestId("h1-score")).toHaveText(`${H1_HOME} : ${H1_AWAY}`);
    // b. 시계는 전반이 끝난 지점. 재생은 이 시점 앞쪽 어딘가에 있다.
    await expect(scorebar).toContainText(END_MINUTE);
    expect(
      SCALE_IS_OBSERVABLE,
      `데모 로그(끝 ${LAST_TICK}틱)의 구운 분이 tick/60 과 같아 이 스펙이 #388 회귀를 구분하지 못한다 — 위 주석 참조`,
    ).toBe(true);
  });

  test("c. 전반을 처음으로 되감아도 헤더가 0 : 0 / 0' 로 무너지지 않는다", async ({ page }) => {
    await openMatch(page, "HALFTIME", 5_000);
    await openStageTab(page);
    await waitForViewer(page);

    // hero 가 본 화면의 재현 경로 — 감독시간에는 전반 전체가 자유 리뷰라 재생이 앞쪽에 있을 수 있다.
    await page.evaluate(() => {
      (window as unknown as { __viewer?: { seek(t: number): void; pause(): void } }).__viewer?.seek(0);
      (window as unknown as { __viewer?: { pause(): void } }).__viewer?.pause();
    });
    await expect.poll(() => playhead(page), { timeout: 10_000 }).toBeLessThan(30);

    const scorebar = page.getByTestId("stage-scorebar");
    await expect(page.getByTestId("h1-score")).toHaveText(`${H1_HOME} : ${H1_AWAY}`);
    await expect(scorebar).toContainText(END_MINUTE);
    await expect(scorebar).not.toContainText("0 : 0");
    await expect(page.getByTestId("stage-clock")).not.toHaveText(PLAYHEAD_MINUTE);
  });

  test("d. FIRST_HALF 헤더는 여전히 재생 진행을 따라간다(라이브 무회귀)", async ({ page }) => {
    await openMatch(page, "FIRST_HALF", 30_000);
    await openStageTab(page);
    await waitForViewer(page);

    // 라이브 전반은 확정 스코어가 없다 → 재생 기준 스코어·시계가 쓰인다.
    await expect(page.getByTestId("match-state")).toHaveText("전반 진행 중");
    await expect(page.getByTestId("h1-score")).toHaveCount(0);
    const before = await page.getByTestId("stage-scorebar").textContent();
    await expect
      .poll(async () => (await page.getByTestId("stage-scorebar").textContent()) !== before, { timeout: 20_000 })
      .toBe(true);
  });
});
