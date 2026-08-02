import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #406 W3 — **과거 전용 시크바** (요구 5-3, 목업 §3).
 *
 * hero 요구: *"동영상 바처럼 보이되 미래로는 못 가고 과거만 이동(돌려보기). 현재 경기 진행 시점이
 * 어디쯤인지 표시. 경기 종료 후 결과창·경기 돌려보기에서는 전체 이동 가능."*
 * 복귀 방식은 hero 확정 ③=B — **수동 [현재로] 만**(자동 복귀 없음).
 *
 * 유닛(`PlaybackControls.seek.test.ts`)이 배선을, 이 파일이 **실브라우저의 진실**을 잰다:
 * 실제 픽셀에서 슬라이더가 미래를 덮지 않는지, 키보드/클릭으로 정말 안 넘어가는지.
 *
 * ⚠️ `toBeVisible()` 은 뷰포트 밖도 통과한다(apps/web CLAUDE.md §3) → 배지·버튼은 **좌표로** 잰다.
 * ⚠️ 라우트 매칭은 pathname 술어로(glob 은 vite 소스 /src/api/*.ts 까지 잡아 흰 화면이 된다).
 * ⚠️ 백엔드에 붙지 않는다 — 전면 route-mock(:8080 데모 무접촉).
 */

const MATCH_ID = "m-406seek";
const RAW = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);
const TICKS: number = RAW.tickSnapshots.length;
/** 후반 로그는 엔진이 하프를 이어 붙인 그대로 **틱이 2700 부터**다 — 인덱스와 섞으면 여기서 깨진다. */
const H2_OFFSET = 2700;
const H2_LOG = {
  ...RAW,
  tickSnapshots: RAW.tickSnapshots.map((s: { tick: number }) => ({ ...s, tick: s.tick + H2_OFFSET })),
  events: RAW.events.map((e: { tick: number }) => ({ ...e, tick: e.tick + H2_OFFSET })),
};

const HALF_REAL_MS = 420_000;
/** 창의 절반 지점에서 연다 — 미래도 과거도 넉넉히 남는 유일한 위치. */
const ELAPSED_FRAC = 0.5;
const LIVE_IDX = Math.floor(TICKS * ELAPSED_FRAC);
/** `seekGraceMs` 1500 ÷ 1 게임초/틱 = 인덱스 1.5 → 클램프가 `floor` 하므로 여유는 2 로 본다. */
const GRACE_IDX = 2;
/**
 * 단언과 클릭 사이에 **자연 재생이 흐른 몫**(인덱스). 창 평균은 `TICKS/HALF_REAL_MS`(≈3.4 idx/s)지만
 * 연출 페이싱은 크루즈 구간에서 그보다 빠르다 — 2% 는 약 3.6초치라 넉넉하면서도 예전 임계
 * (`TICKS*0.75` = 1080, 라이브 헤드 720 에서 **360 여유**)보다 열 배 이상 조인다.
 */
const PLAY_ALLOWANCE_IDX = Math.ceil(TICKS * 0.02);

/** 픽스처의 골 이벤트 — "아직 안 온 장면"의 표본이자 라벨 스캔의 재료. */
interface GoalEv {
  tick: number;
  minute: number;
  team: string;
}
const GOALS: GoalEv[] = RAW.events.filter((e: { type: string }) => e.type === "goal");
const LAST_GOAL = GOALS[GOALS.length - 1]!;
/** `buildTimelinePins` 가 핀 `title`/`aria-label` 에 굽는 문구. 화면에서 **읽히면 안 되는 그 문자열**이다. */
const LAST_GOAL_LABEL = `${LAST_GOAL.minute}' · ${LAST_GOAL.team.toUpperCase()} GOAL`;

/**
 * ⚠️ **기본 목은 시계를 얼려 둔다.** `clockFor(elapsed)` 는 호출 시각 기준으로 `start` 를 되계산하므로
 * 폴링마다 "지금 정확히 50% 경과"를 다시 말한다 = 라이브 상한이 720 에 **고정**된다. 대부분의 계약은
 * 그 고정이 유리하지만(임계가 흔들리지 않는다), "상한이 흐르면 …" 계약은 그 목으로는 **영원히 참이
 * 될 수 없다**(실제로 60초를 기다려 실패했다). 그래서 흐르는 창이 필요한 스펙은 `flowing: true` 로
 * **앵커를 한 번만** 잡는다(`clockFrom`).
 */
function clockFor(elapsedMs: number) {
  return clockFrom(Date.now() - elapsedMs);
}

function clockFrom(startMs: number) {
  const now = Date.now();
  const start = startMs;
  return {
    phase: "SECOND_HALF",
    kickoffAt: new Date(start).toISOString(),
    phaseStartAt: new Date(start).toISOString(),
    phaseEndsAt: new Date(start + HALF_REAL_MS).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: 180_000,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
  };
}

async function open(page: Page, live: boolean, opts: { flowing?: boolean } = {}) {
  /** `flowing` 이면 창의 시작점을 **여기서 한 번만** 잡는다 → 폴링마다 경과가 실제로 늘어난다. */
  const anchorMs = Date.now() - HALF_REAL_MS * ELAPSED_FRAC;
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
          scoreH1Away: 0,
          scoreHome: live ? null : 2,
          scoreAway: live ? null : 1,
          result: live ? null : "WIN",
          createdAt: "2026-08-02T09:00:00Z",
          mode: "practice",
          ownerName: "테스터",
          opponent: { name: "봇 FC", deck: [] },
          // 폴링마다 serverNow 가 갱신되는 실제 서버를 흉내낸다(스큐 보정 경로가 실제로 돈다).
          clock: live ? (opts.flowing ? clockFrom(anchorMs) : clockFor(HALF_REAL_MS * ELAPSED_FRAC)) : null,
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: H2_LOG });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({ json: { result: "WIN", scoreHome: 2, scoreAway: 1, pointsAwarded: 10 } });
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
  await expect(page.getByTestId("stage-shell")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("viewer-canvas-half2")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("viewer-seek-bar-half2")).toBeVisible({ timeout: 20_000 });
}

/** 재생 헤드의 **스냅샷 인덱스**(후반 오프셋을 되돌린 값). */
function headIndex(page: Page): Promise<number> {
  return page.evaluate(
    (off) => {
      const v = (window as unknown as { __viewer?: { cur(): { tick: number } } }).__viewer;
      return v ? Number(v.cur().tick) - off : -1;
    },
    H2_OFFSET,
  );
}

/** 지금 **DOM 에 실재하는** 시크바 핀들의 스냅샷 인덱스(후반 오프셋을 되돌린 값). */
async function shownPinIndices(page: Page): Promise<number[]> {
  const ticks = await page
    .locator('[data-testid^="viewer-seek-pin-"]')
    .evaluateAll((els) =>
      els.map((el) => Number(/viewer-seek-pin-(\d+)/.exec(el.getAttribute("data-testid") ?? "")?.[1] ?? "-1")),
    );
  return ticks.map((t) => t - H2_OFFSET);
}

/** 지금 상한(스냅샷 인덱스) — 슬라이더 `max` 가 곧 라이브 헤드다(`trackGeometry.maxIndex`). */
async function liveCap(page: Page): Promise<number> {
  return Number(await page.getByTestId("viewer-seek-half2").getAttribute("max"));
}

/** 요소가 **실제로 화면 안에 그려졌는가** — `toBeVisible()` 이 통과시키는 뷰포트 밖을 걸러낸다. */
async function onScreen(page: Page, el: Locator): Promise<boolean> {
  const box = await el.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) return false;
  const vp = page.viewportSize()!;
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1;
}

/** 슬라이더를 키보드로 N칸 되감는다(포인터 좌표 의존 없이 결정적으로 움직인다). */
async function rewind(page: Page, steps: number) {
  const bar = page.getByTestId("viewer-seek-half2");
  await bar.focus();
  for (let i = 0; i < steps; i += 1) await bar.press("ArrowLeft");
}

/**
 * 트랙 맨 앞으로 되감는다(`Home`).
 *
 * ⚠️ 화살표 N번으로 "충분히 뒤로"를 만들지 마라 — 되감는 동안에도 재생과 라이브 상한이 같이 흐르므로
 * 순 이동량이 눌린 횟수보다 **작다**(실측: 60번 눌러 720 → 658, 약 4%). 그 표본으로 세운 임계는
 * 머신 속도에 따라 흔들린다. 이 계약이 재는 것은 되감기의 양이 아니라 **끌려오지 않는가**다.
 */
async function rewindToStart(page: Page) {
  const bar = page.getByTestId("viewer-seek-half2");
  await bar.focus();
  await bar.press("Home");
}

test.use({ viewport: { width: 390, height: 844 } });

test("① 미래로는 못 간다 — 슬라이더가 미래 구간을 덮지 않고, 그쪽을 눌러도 안 간다", async ({ page }) => {
  await open(page, true);

  const track = page.getByTestId("viewer-seek-track-half2");
  const bar = page.getByTestId("viewer-seek-half2");
  const future = page.getByTestId("viewer-seek-future-half2");
  const tb = (await track.boundingBox())!;
  const bb = (await bar.boundingBox())!;
  const fb = (await future.boundingBox())!;
  console.log("[p406] geom", JSON.stringify({ track: tb, slider: bb, future: fb }));

  /*
   * 기하 — 잡을 수 있는 구간이 트랙보다 **짧다**. 예전엔 max=snapCount-1 이라 바 끝이 곧 스포일러였다.
   *
   * ⚠️ **전제**(독립검증 M-4): 이 기하 계약은 `.seekInput { min-width: 24px }` 보다 상한이 넉넉히
   *    클 때만 성립한다. 하프 극초반(상한 ≈ 0%)에는 엄지로 잡히게 하려고 슬라이더가 계산된 폭보다
   *    넓게 그려져서 "슬라이더 폭 = 닿는 구간"이 **기하로는 참이 아니다**(값은 그래도 `max` 가 자른다 —
   *    그 층은 아래 동작 단언과 ④ 가 잰다). 그래서 이 표본은 창의 절반(ELAPSED_FRAC 0.5)이다.
   */
  expect(bb.width, "표본 전제 붕괴 — 상한이 min-width(24px) 근처면 폭 계약이 성립하지 않는다").toBeGreaterThan(60);
  expect(bb.width, "슬라이더가 트랙 전체를 덮는다 = 미래까지 잡힌다").toBeLessThan(tb.width - 20);
  expect(fb.x + 1, "미래 구간이 슬라이더 오른쪽에서 시작하지 않는다").toBeGreaterThanOrEqual(bb.x + bb.width - 2);
  // `max` 는 라이브 헤드다(트랙 끝이 아니다).
  expect(Number(await bar.getAttribute("max"))).toBeLessThan(TICKS - 1);

  /*
   * 동작 — 트랙 오른쪽 끝(=미래 구간)을 눌러도 재생 위치가 미래로 뛰지 않는다.
   *
   * ⚠️ 임계는 **지금 잠긴 경계 기준**이다(독립검증 M-3). 예전 `TICKS * 0.75`(=1080)는 라이브 헤드가
   *    720 이라 **인덱스 1000 까지 끌려가도 통과**했다 — 검정력이 거의 없었다. 경계는 `clampSeek` 가
   *    보장하는 `max(헤드, 상한) + grace` 이고, 여기에 클릭 후 대기 동안 자연 재생이 흐른 몫만 더한다.
   *    (헤드가 상한을 앞설 수 있다 — `PACE_DRIFT_FRAC` 안쪽의 크루즈 앞섬은 #216 계약이라 경계에 포함.)
   */
  const capBefore = await liveCap(page);
  const headBefore = await headIndex(page);
  await page.mouse.click(tb.x + tb.width - 3, tb.y + tb.height / 2);
  await page.waitForTimeout(600);
  const idx = await headIndex(page);
  const bound = Math.max(headBefore, capBefore) + GRACE_IDX + PLAY_ALLOWANCE_IDX;
  console.log(`[p406] after future click: idx=${idx} cap=${capBefore} head=${headBefore} bound=${bound}`);
  expect(idx, `미래로 끌렸다(인덱스 ${idx} > 경계 ${bound})`).toBeLessThanOrEqual(bound);
});

test("② 뒤로 끌면 `과거 보는 중` 배지와 [현재로] 가 화면 안에 뜬다", async ({ page }) => {
  await open(page, true);
  const badge = page.getByTestId("viewer-seek-past-half2");
  const now = page.getByTestId("viewer-seek-now-half2");
  await expect(badge, "처음엔 라이브를 따라간다").toBeHidden();

  await rewind(page, 40);
  await expect(badge).toBeVisible();
  await expect(now).toBeVisible();
  // ⚠️ 좌표로 재라 — `toBeVisible()` 은 뷰포트 밖도 통과한다.
  expect(await onScreen(page, badge), "배지가 화면 밖에 그려졌다").toBe(true);
  expect(await onScreen(page, now), "[현재로] 가 화면 밖에 그려졌다").toBe(true);
});

test("③ 과거에 머문다 — 자동 복귀 없음, [현재로] 를 눌러야 돌아온다", async ({ page }) => {
  await open(page, true);
  await rewindToStart(page);
  const back = await headIndex(page);
  expect(back, "되감기가 안 먹었다 — 표본이 잘못됐다").toBeLessThan(LIVE_IDX * 0.5);

  /*
   * 복구 루프(250ms)가 억제되는지 본다. 재생은 계속 흐르므로 "제자리"를 요구하면 안 된다 —
   * 라이브 헤드로 **점프해 버리지 않는가**를 잰다(억제가 없으면 0.25초 안에 헤드로 튄다).
   */
  await page.waitForTimeout(2000);
  const stayed = await headIndex(page);
  console.log(`[p406] rewound=${back} after2s=${stayed} live≈${LIVE_IDX}`);
  expect(stayed, "과거로 돌려놨는데 현재로 튕겨 왔다(자동 복귀 = hero 기각안 A)").toBeLessThan(
    back + TICKS * 0.1,
  );
  await expect(page.getByTestId("viewer-seek-past-half2")).toBeVisible();

  // [현재로] → 라이브 헤드로 복귀하고 배지가 꺼진다.
  await page.getByTestId("viewer-seek-now-half2").click();
  await expect
    .poll(() => headIndex(page), { message: "[현재로] 가 라이브 헤드로 데려가지 않았다", timeout: 10_000 })
    .toBeGreaterThan(LIVE_IDX * 0.85);
  await expect(page.getByTestId("viewer-seek-past-half2")).toBeHidden();
});

/*
 * ④ **아직 안 온 장면 핀은 DOM 에 없다.**
 *
 * ⚠️ 이 계약은 원래 정반대를 요구했다 — `[data-future="true"]` 핀이 **하나 이상 있어야** 표본이
 *    유효하다고 못 박아, `opacity: .28` 로 흐리게만 그리던 결함을 **계약이 박제**하고 있었다.
 *    흐린 핀도 `title`/`aria-label`(`76' · HOME GOAL`)을 들고 있어 호버·스크린리더·DOM 조회로
 *    아직 안 온 골이 읽혔다(후반 25% 실측: 핀 46개 중 미래 34개, 미발생 골 8개).
 *    그래서 **DOM 부재로 잰다** — `opacity` 로 재면 그게 이 결함의 모양 그대로다.
 * ⚠️ `toHaveCount(0)` 만 두면 "핀을 통째로 안 그리는" 변이체가 통과한다(CLAUDE.md 거짓말 패턴 #6).
 *    그래서 ⓐ 부재와 ⓑ **지난 핀은 있다** ⓒ **상한이 흐르면 나타난다** 를 같이 건다.
 */
test("④ 아직 안 온 장면 핀은 DOM 에 없다 — 라벨도 안 새고, 왕복해도 되살아나지 않는다", async ({ page }) => {
  await open(page, true);

  // ⚠️ `GOALS[].tick` 은 **원본 틱**이고 스냅샷이 틱당 1개라 그대로 스냅샷 인덱스다(H2_OFFSET 는
  //    로그를 후반 자리로 옮길 때만 붙는다). 그래서 아래에서 인덱스 `cap` 과 직접 비교한다.
  /*
   * ⚠️ 순서가 중요하다: 핀을 **먼저** 읽고 상한을 **나중에** 읽는다. 상한은 실시간으로 늘어나므로
   *    나중에 읽은 값은 그릴 때의 상한보다 크거나 같다 = 위반이 있으면 반드시 걸린다(거짓 green 없음).
   * ⚠️ 그리고 그 사이에 **폴링 한 주기(250ms)를 넘겨 기다린다**: 핀 판정은 `isFutureTick` 이 시계를
   *    직접 읽지만 슬라이더 `max` 는 250ms 게이트 폴링이 밀어 넣는 값이라 최대 한 주기(≈1 인덱스)
   *    **뒤처진다**. 안 기다리면 정상 동작이 1 인덱스 차이로 빨간불이 된다(임계를 느슨하게 하는 대신
   *    측정 순간을 정렬한다 — 계약은 그대로 `> cap` 엄격이다).
   */
  const shown = await shownPinIndices(page);
  await page.waitForTimeout(400);
  const cap = await liveCap(page);
  const futureShown = shown.filter((i) => i > cap);
  const futureInFixture = GOALS.filter((g) => g.tick > cap).length;
  console.log(`[p406] pins shown=${shown.length} cap=${cap} futureShown=${futureShown.length} futureGoals=${futureInFixture}`);

  expect(futureInFixture, "상한 뒤에 남은 골이 없다 = 표본이 잘못됐다(창을 더 앞에서 열어라)").toBeGreaterThan(0);
  expect(futureShown, `아직 안 온 장면 핀이 DOM 에 있다: ${futureShown.join(",")}`).toEqual([]);
  expect(shown.length, "핀을 통째로 안 그린다 = 부재 단언이 공허하다").toBeGreaterThan(0);

  // ⓑ 라벨로도 안 샌다 — 마지막 골 문구가 무대 어디에도 없어야 한다(호버 툴팁·스크린리더 경로).
  const track = page.getByTestId("viewer-seek-track-half2");
  const labels = await track.locator("[aria-label]").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  expect(labels.join(" | "), `미발생 골 라벨이 읽힌다: ${LAST_GOAL_LABEL}`).not.toContain(LAST_GOAL_LABEL);
  expect(await track.locator(`[title="${LAST_GOAL_LABEL}"]`).count(), "미발생 골이 title 로 읽힌다").toBe(0);

  // 왕복 — 과거를 다녀와도 상한이 헐거워지지 않는다.
  await rewindToStart(page);
  await page.getByTestId("viewer-seek-now-half2").click();
  await page.waitForTimeout(500);

  const shownAfter = await shownPinIndices(page);
  await page.waitForTimeout(400); // 위와 같은 이유 — `max` 가 폴링 한 주기 뒤처진다.
  const capAfter = await liveCap(page);
  expect(capAfter, "왕복 뒤 슬라이더가 트랙 끝까지 열렸다").toBeLessThan(TICKS - 1);
  expect(
    shownAfter.filter((i) => i > capAfter),
    "왕복 뒤 미래 핀이 되살아났다",
  ).toEqual([]);
});

/**
 * ⓒ **양성 단언** — 감추는 게 아니라 *아직* 안 보이는 것이다. 상한이 흐르면 그 핀이 스스로 나타난다.
 * 이게 없으면 위 ④ 는 "핀 기능을 죽였다"와 구별되지 않는다.
 */
test("④-b 상한이 흐르면 잠겨 있던 핀이 나타난다(영영 감추는 게 아니다)", async ({ page }) => {
  // ⚠️ 이 스펙만 **흐르는 창**이다 — 기본 목은 폴링마다 "지금 50%"를 다시 말해 상한이 얼어 있다.
  await open(page, true, { flowing: true });

  // 여기선 상한을 **먼저** 읽는다 — `cap0` 은 "이 시점 이후에 열린 것"의 하한이어야 하므로
  // 작게(=이르게) 잡는 쪽이 안전하다(④ 와 방향이 반대다).
  const cap0 = await liveCap(page);
  const before = await shownPinIndices(page);
  expect(GOALS.filter((g) => g.tick > cap0).length, "더 열릴 핀이 없다 = 표본이 잘못됐다").toBeGreaterThan(0);

  // 상한은 실시간(≈ TICKS/HALF_REAL_MS ≈ 3.4 인덱스/초)으로 흐른다 — 다음 핀까지 기다린다.
  await expect
    .poll(() => shownPinIndices(page).then((p) => p.length), {
      message: "상한이 흘렀는데 새 핀이 나타나지 않았다 = 미래 핀을 영영 감추고 있다",
      timeout: 60_000,
    })
    .toBeGreaterThan(before.length);

  const after = await shownPinIndices(page);
  const revealed = after.filter((i) => !before.includes(i));
  console.log(`[p406] revealed pins: ${revealed.join(",")} (cap0=${cap0} → ${await liveCap(page)})`);
  // 새로 열린 핀은 **예전 상한 너머**의 것이다(같은 핀이 두 번 세어진 게 아니다).
  expect(Math.max(...revealed), "새로 나타난 핀이 예전 상한 안쪽이다").toBeGreaterThan(cap0);
});

test("⑤ 종료 화면 — 같은 시크바로 전 구간 이동(잠금만 빠진다)", async ({ page }) => {
  await open(page, false);

  const bar = page.getByTestId("viewer-seek-half2");
  const track = page.getByTestId("viewer-seek-track-half2");
  await expect(page.getByTestId("viewer-seek-future-half2"), "종료인데 잠긴 구간이 있다").toBeHidden();
  await expect(page.getByTestId("viewer-seek-live-half2"), "종료인데 `현재` 선이 있다").toBeHidden();
  expect(Number(await bar.getAttribute("max")), "종료면 트랙 끝까지 열려야 한다").toBe(TICKS - 1);

  const tb = (await track.boundingBox())!;
  const bb = (await bar.boundingBox())!;
  expect(bb.width, "종료 화면 슬라이더가 트랙을 다 덮지 않는다").toBeGreaterThan(tb.width - 4);

  // 실제로 경기 끝쪽으로 이동된다(라이브였다면 막혔을 구간).
  await bar.focus();
  await bar.press("End");
  await expect
    .poll(() => headIndex(page), { message: "종료 화면에서 전체 이동이 안 된다", timeout: 10_000 })
    .toBeGreaterThan(TICKS * 0.8);
  // 돌아가는 것도 자유.
  await bar.press("Home");
  await expect.poll(() => headIndex(page), { timeout: 10_000 }).toBeLessThan(TICKS * 0.2);
});
