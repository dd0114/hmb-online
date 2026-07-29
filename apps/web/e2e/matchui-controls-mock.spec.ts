import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #148 매치 화면 컨트롤 간소화 (#169 S3 직접 마운트) — 백엔드 없이 route-mock 으로 실화면 계약을 박제한다.
 *
 * 계약(hero 재지시 2026-07-21 → #216 하이라이트 단일화 2026-07-27):
 *  - 플레이 모드(일반 유저): 경기는 **자동 진행**하고 컨트롤은 **아예 없다**. 하이라이트 연출이
 *    유일 모드라 끄는 버튼도 없다(#216 — 끔 모드는 렌더가 깨진 채였고 라이브 재생이 그 경로를 탔다).
 *  - admin/QA 모드: 코어 풀컨트롤(재생·배속·스크럽·프레임점프) + 모드 전환 토글. 배속은 연출을
 *    끄지 않고 그 위에 곱해진다.
 *
 * S3: iframe·postMessage 제거 — web 이 viewer-core 를 직접 마운트한다. 컨트롤은 코어 컨트롤러를
 * 직접 조작하고, 재생 상태는 window.__viewer(코어 훅)로 읽는다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면.
 */

const CAP_DIR = new URL("../.matchui/", import.meta.url).pathname;
const MATCH_ID = "m-matchui";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);

async function mockApi(page: Page, opts: { isAdmin: boolean; corruptLog?: boolean; state?: string }) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: opts.isAdmin },
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state: opts.state ?? "FIRST_HALF",
          scoreH1Home: 2,
          scoreH1Away: 1,
          createdAt: "2026-07-21T09:00:00Z",
          opponent: { name: "봇 FC" },
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/halves/1/log`) {
      // corruptLog: 코어 load 가 거부하는 형태(tickSnapshots 결손) — 실패 경로 검증용.
      return route.fulfill({ json: opts.corruptLog ? { events: [], finalScore: { home: 0, away: 0 } } : MATCH_LOG });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: [] });
    if (url.pathname === "/api/deck") return route.fulfill({ json: { formation: "4-4-2", slots: [] } });
    return route.fulfill({ json: {} });
  });
}

/**
 * 매치 화면을 열고 코어가 마운트(ready)될 때까지 기다린다.
 *
 * ⚠️ 기본 상태는 **관전(FIRST_HALF)** 이다. 이 파일의 계약(#148/#216)은 "플레이 모드에는 컨트롤이
 * 하나도 없다"인데, #244 에서 **감독시간의 `경기장면` 탭은 일반 유저에게도 돌려보기 컨트롤을 연다**
 * (hero 결정 — 지나간 하프를 장면으로 찾아보는 자리다). 그래서 감독시간에서 이 파일을 열면 두 계약이
 * 정면으로 부딪힌다. 대상이 다른 두 규칙이므로 **이 파일은 관전 화면에서** 잰다.
 */
async function openHalftime(page: Page, isAdmin: boolean, state?: string): Promise<void> {
  await mockApi(page, { isAdmin, state });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  /*
   * #244: 감독시간에는 무대가 `경기장면` 탭 뒤다 — 뷰어를 보려면 한 번 연다(관전 화면이면 없다).
   * ⚠️ **셸을 먼저 기다린다.** `goto` 직후엔 매치 응답 전이라 탭이 아직 없고(`H1_BREAK` 실측 count 0),
   *    그러면 `count()` 분기가 클릭을 조용히 건너뛰어 뷰어가 영영 안 뜬다 — 웜 캐시에서만 green 인
   *    레이스가 된다(독립 검증 2회차 blocker). 형제 스펙(p226·match-live-clock)은 셸 대기 뒤에 연다.
   */
  await expect(page.getByTestId("stage-shell")).toBeVisible({ timeout: 20_000 });
  {
    const tab = page.getByTestId("stage-tab-stage");
    await tab.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    if (await tab.count()) await tab.click();
  }
  await expect(page.getByTestId("match-viewer-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible();
  await page.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 20_000 },
  );
}

/** 코어 현재 재생 틱(진행 여부 판정용). */
function tickNow(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as never as { __viewer: { cur: () => { tick: number } } }).__viewer.cur().tick,
  );
}

/** 실제 진행 속도(게임틱/실초) 측정 — "칩이 눌렸다"가 아니라 "정말 진행한다"를 본다. */
async function measureRate(page: Page, ms: number): Promise<number> {
  const t0 = await tickNow(page);
  await page.waitForTimeout(ms);
  const t1 = await tickNow(page);
  return (t1 - t0) / (ms / 1000);
}

/** 지정 틱으로 옮겨 재생을 다시 시작한 뒤 그 구간의 진행 속도를 잰다(코어 seek 은 일시정지 동반). */
async function measureFrom(page: Page, tick: number, ms: number): Promise<number> {
  await page.evaluate((t) => {
    const v = (window as never as { __viewer: { seek(t: number): void; play(): void } }).__viewer;
    v.seek(t);
    v.play();
  }, tick);
  return measureRate(page, ms);
}


/**
 * 페이스 대비를 잴 두 지점을 **로그에서 계산**한다(틱 하드코딩 금지 — minor-A).
 *  · `quietTick`     키장면·정지가 없는 구간의 시작 = 크루즈(4x)로 지나가야 하는 곳.
 *  · `keySceneTick`  키틱의 하이라이트 창 시작(kt − HL_PRE) = 슬로우(1x)여야 하는 곳.
 * 두 판정 모두 코어와 같은 규칙을 쓴다(keyTicks 정의 = goal·penalty·유효슛, HL_PRE=8/HL_POST=3).
 */
function pickPaceProbes(): { quietTick: number; keySceneTick: number } {
  const HL_PRE = 8, HL_POST = 3;
  const events = MATCH_LOG.events as { tick: number; type: string; detail?: string }[];
  const snaps = MATCH_LOG.tickSnapshots as { tick: number }[];
  const lastTick = snaps[snaps.length - 1]!.tick;
  const keyTicks = events
    .filter((e) => e.type === "goal" || e.type === "penalty" || (e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target"))
    .map((e) => e.tick);
  // 정지(홀드)를 만드는 이벤트 — 여기 걸리면 재생이 멈춰 속도 측정이 오염된다.
  const stopTypes = new Set(["goal", "save", "foul", "offside", "penalty", "kickoff"]);
  const stopTicks = events.filter((e) => stopTypes.has(e.type) || (e.type === "shot" && e.detail)).map((e) => e.tick);

  const busy = new Set<number>();
  for (const t of keyTicks) for (let i = t - HL_PRE - 4; i <= t + HL_POST + 4; i++) busy.add(i);
  for (const t of stopTicks) for (let i = t - 2; i <= t + 6; i++) busy.add(i);

  // 가장 긴 조용한 구간(측정 3초 × 크루즈 8틱/s = 최소 24틱 필요).
  let best = { start: 0, len: 0 }, run = 0, start = 0;
  for (let t = 0; t <= lastTick; t++) {
    if (busy.has(t)) { run = 0; continue; }
    if (run === 0) start = t;
    run++;
    if (run > best.len) best = { start, len: run };
  }
  if (best.len < 30) throw new Error(`데모 로그에 조용한 구간이 없다(최장 ${best.len}틱) — 페이스 대비를 잴 수 없다`);

  // 하이라이트 창 안에서 3초(슬로우 2틱/s = 6틱)를 정지 없이 보낼 수 있는 키틱.
  const keyTick = keyTicks.find((kt) => {
    for (let t = kt - HL_PRE; t <= kt - HL_PRE + 8; t++) if (stopTicks.includes(t)) return false;
    return kt - HL_PRE > 0;
  });
  if (keyTick == null) throw new Error("데모 로그에 정지 없는 하이라이트 창이 없다 — 페이스 대비를 잴 수 없다");

  return { quietTick: best.start, keySceneTick: keyTick - HL_PRE };
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test("#148/#216 플레이 모드: 컨트롤이 없고 경기는 자동 진행한다", async ({ page }) => {
  await openHalftime(page, false);

  // (1) web 바에 컨트롤이 하나도 없다(하이라이트 토글·재생·배속·스크럽·프레임점프·모드토글 전부).
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-play-toggle-half1")).toHaveCount(0);
  for (const s of [1, 2, 4]) await expect(page.getByTestId(`viewer-speed-${s}-half1`)).toHaveCount(0);
  await expect(page.getByTestId("viewer-scrub-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-mode-toggle-half1")).toHaveCount(0);
  const buttons = await page.getByTestId("viewer-controls-half1").locator("button").count();
  expect(buttons, "플레이 모드 컨트롤 바에는 버튼이 없다").toBe(0);

  // 스코어는 무대(캔버스)가 아니라 호스트 스코어바가 소유한다(중복 없이 한 곳).
  await expect(page.getByTestId("stage-scorebar")).toBeVisible();
  await expect(page.getByTestId("stage-score")).toBeVisible();
  await page.screenshot({ path: `${CAP_DIR}play-mode.png`, fullPage: false });

  // (2) 아무 조작 없이도 경기가 진행된다(자동 진행 — 재생 버튼이 없으므로 이게 유일한 시작 경로).
  const t0 = await tickNow(page);
  await expect.poll(() => tickNow(page), { timeout: 10_000 }).toBeGreaterThan(t0);
});

test("#216 하이라이트 연출이 유일 모드다 — 끌 경로가 없고 연출 페이스로 진행한다", async ({ page }) => {
  await openHalftime(page, false);

  // 화면에 연출을 끄는 컨트롤이 존재하지 않는다(플레이·admin 어느 쪽에도).
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-highlight-admin-half1")).toHaveCount(0);

  // **연출이 실제로 도는가**를 속도 대비로 본다: 빌드업(크루즈 4x = 8틱/s)과 키장면(1x = 2틱/s)의
  // 4:1 대비가 관측돼야 한다. "속도가 0보다 크다" 류의 단언은 구 깨진 경로(autoPace off + speed 4 =
  // 정확히 8틱/s 등속)도 그대로 통과시킨다 — 대비가 있어야 연출이 산 증거다(독립검증 minor-7).
  // 구간은 **로그에서 런타임에 고른다**. 데모 로그는 git 미추적 생성물이라(엔진/쇼케이스 config 가
  // 바뀌면 재생성된다) 틱 번호를 박아두면 "조용한 구간/하이라이트 창"이라는 전제가 조용히 깨진다
  // (독립검증 minor-A).
  const { quietTick, keySceneTick } = pickPaceProbes();
  const cruise = await measureFrom(page, quietTick, 3000);
  const keyScene = await measureFrom(page, keySceneTick, 3000);
  console.log(`[#216] 크루즈 ${cruise.toFixed(2)} tick/s · 키장면 ${keyScene.toFixed(2)} tick/s`);
  expect(cruise, "빌드업은 크루즈 속도(≈8틱/s)로 지나가야 한다").toBeGreaterThan(5);
  expect(keyScene, "키장면은 슬로우(≈2틱/s)여야 한다").toBeLessThan(4);
  expect(cruise / keyScene, "연출이 살아 있으면 대비가 2배 이상 벌어진다").toBeGreaterThan(2);
  await page.screenshot({ path: `${CAP_DIR}play-mode-highlight-on.png`, fullPage: false });
});

test("#148 admin 모드: 코어 풀컨트롤 노출 + 모드 토글로 플레이어 체감 전환", async ({ page }) => {
  await openHalftime(page, true);

  // 풀컨트롤: 재생/정지·배속·스크럽·골점프가 보인다.
  await expect(page.getByTestId("viewer-play-toggle-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-speed-0.25-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-scrub-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-prev-goal-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-mode-toggle-half1")).toBeVisible();
  // 하이라이트 토글은 어느 모드에도 없다(#216).
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-highlight-admin-half1")).toHaveCount(0);
  await page.screenshot({ path: `${CAP_DIR}admin-full-mode.png`, fullPage: false });

  // 모드 토글 → 플레이어가 보는 화면으로 즉시 전환(풀컨트롤 사라지고 빈 바만).
  await page.getByTestId("viewer-mode-play-half1").click();
  await expect(page.getByTestId("viewer-scrub-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-play-toggle-half1")).toHaveCount(0);
  await page.screenshot({ path: `${CAP_DIR}admin-switched-to-play.png`, fullPage: false });
});

test("#148 뷰어 로드 실패는 화면 안에 보인다(설명 없는 빈 피치 방지)", async ({ page }) => {
  /*
   * 손상 MatchLog → 코어 load 가 throw → 같은 자리에 실패 안내 + 타임라인 폴백 버튼.
   * 이 케이스만 **감독시간(H1_BREAK)** 을 유지한다 — 실패 안내가 검증돼 있던 경로가 그쪽이고,
   * 라이브(FIRST_HALF)는 로그 로딩 경로가 달라 같은 손상 픽스처가 실패 UI 로 이어지지 않는다.
   * (컨트롤 노출 계약과 달리 이건 상태가 아니라 **렌더 실패**를 재는 테스트다.)
   */
  await mockApi(page, { isAdmin: false, corruptLog: true, state: "H1_BREAK" });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  /*
   * #244: 감독시간에는 무대가 `경기장면` 탭 뒤다 — 뷰어를 보려면 한 번 연다(관전 화면이면 없다).
   * ⚠️ **셸을 먼저 기다린다.** `goto` 직후엔 매치 응답 전이라 탭이 아직 없고(`H1_BREAK` 실측 count 0),
   *    그러면 `count()` 분기가 클릭을 조용히 건너뛰어 뷰어가 영영 안 뜬다 — 웜 캐시에서만 green 인
   *    레이스가 된다(독립 검증 2회차 blocker). 형제 스펙(p226·match-live-clock)은 셸 대기 뒤에 연다.
   */
  await expect(page.getByTestId("stage-shell")).toBeVisible({ timeout: 20_000 });
  {
    const tab = page.getByTestId("stage-tab-stage");
    await tab.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    if (await tab.count()) await tab.click();
  }
  const err = page.getByTestId("viewer-visual-error-half1");
  await expect(err).toBeVisible({ timeout: 20_000 });
  const box = await err.boundingBox();
  const vh = page.viewportSize()!.height;
  expect(box!.y, "실패 안내가 첫 화면 안에 있어야 함").toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1);
  await page.screenshot({ path: `${CAP_DIR}play-mode-load-error.png`, fullPage: false });
});

test("#148 모바일 390px: 간소 컨트롤 가로 오버플로 0", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHalftime(page, false);
  await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${CAP_DIR}play-mode-mobile390.png`, fullPage: false });
});
