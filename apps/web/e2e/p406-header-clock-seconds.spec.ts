import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #406 W2 — **경기중 시간을 초까지**(`48'32"`, hero 확정 안 A · 보간 없음).
 *
 * 요구와 #388 규율("화면에서 표기 스케일을 다시 유도하지 마라")이 정면으로 만나는 자리다. 둘을
 * 같이 지키는 방법은 하나뿐이다:
 *
 *   분 = 로그가 구운 `minute`  ·  초 = **그 분이 처음 나타난 틱**부터의 경과
 *
 * 그래서 이 스펙이 재는 것은 두 가지다:
 *  ① 초가 붙어도 **헤더의 분 == 그 순간 로그줄의 분** (#388 불변식 유지)
 *  ② 초가 그 분의 **시작 틱에서 `00`**, 분이 넘어가기 직전이 최대
 *  ③ ★ **스케일을 화면이 알고 있지 않다** — 같은 틱이라도 로그의 레짐이 다르면 시계가 다르다
 *
 * ③ 이 이 스펙의 존재 이유다. `30`(틱/표기분)을 어딘가에 적어 두면 ①②는 **전부 초록**이고,
 * 엔진이 `matchMinutes`/`displayMinutes` 를 바꾸는 날 화면만 조용히 어긋난다 — #388 이 정확히
 * 그렇게 생겼다(하프 2700틱 시절엔 `tick/60` 이 **우연히** 맞았다).
 *
 * ⚠️ 픽스처는 **실엔진 로그**(`scripts/gen-p388-fixture.ts`, `defaultEngineConfig` = 45분/표기 90분)다.
 *    대조군만 그 로그의 `minute` 을 **구 레짐(60틱/분)으로 다시 구워** 쓴다 — 지어낸 경기가 아니라
 *    같은 경기의 다른 표기 레짐이라, 화면이 로그를 따라가는지만 갈린다.
 * ⚠️ 라우트 매칭은 pathname 술어로 한다(glob 은 vite 소스까지 잡아 흰 화면).
 */

interface Snap {
  tick: number;
  minute: number;
}
interface Ev {
  tick: number;
  minute: number;
  type: string;
}
type Log = { tickSnapshots: Snap[]; events: Ev[] };

const REAL: Log = JSON.parse(
  readFileSync(new URL("./fixtures/p388-half1.json", import.meta.url).pathname, "utf8"),
);

/** 구 레짐(하프 2700틱 = 60틱/표기분)으로 `minute` 만 다시 굽는다. 틱·좌표·이벤트 순서는 그대로. */
const LEGACY: Log = {
  ...REAL,
  tickSnapshots: REAL.tickSnapshots.map((s) => ({ ...s, minute: Math.floor(s.tick / 60) })),
  events: REAL.events.map((e) => ({ ...e, minute: Math.floor(e.tick / 60) })),
};

/**
 * 프로브 틱 — **스냅샷이 실제로 있는 틱**만 쓴다(`seek` 은 `tick >= t` 인 첫 스냅샷으로 붙는다).
 * 픽스처는 10틱 간격 + 이벤트 틱이라 10의 배수는 항상 있다.
 */
const ANCHOR_TICK = 600; // 현행 레짐에서 20' 이 시작되는 틱
const MID_TICK = 590; // 19' 안쪽
const CONTRAST_TICK = 560; // 두 레짐이 서로 다른 분·초를 말하는 틱

/** 그 로그가 말하는 시각 — **픽스처에서 유도**한다(구현식을 베끼지 않는다). */
function expectedClock(log: Log, tick: number): string {
  const at = log.tickSnapshots.filter((s) => s.tick <= tick).pop()!;
  const minute = at.minute;
  const anchor = Math.min(...log.tickSnapshots.filter((s) => s.minute === minute).map((s) => s.tick));
  const minutes = log.tickSnapshots.map((s) => s.minute);
  const lo = Math.min(...minutes);
  const hi = Math.max(...minutes);
  const anchorOf = (m: number) => Math.min(...log.tickSnapshots.filter((s) => s.minute === m).map((s) => s.tick));
  const ticksPerMinute = (anchorOf(hi) - anchorOf(lo)) / (hi - lo);
  const second = Math.floor(((tick - anchor) * 60) / ticksPerMinute);
  return `${minute}'${String(second).padStart(2, "0")}"`;
}

async function mockApi(page: Page, matchId: string, log: Log, detail: Record<string, unknown> = {}) {
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
      if (p === `/api/matches/${matchId}`) {
        return route.fulfill({
          json: {
            id: matchId,
            state: "FIRST_HALF",
            createdAt: "2026-08-02T09:00:00Z",
            opponent: { name: "봇 FC" },
            ...detail,
          },
        });
      }
      if (p === `/api/matches/${matchId}/halves/1/log`) return route.fulfill({ json: log });
      if (p === "/api/players") return route.fulfill({ json: [] });
      if (p === "/api/deck") return route.fulfill({ json: { formation: "4-4-2", slots: [] } });
      return route.fulfill({ json: {} });
    },
  );
}

/**
 * 리그 라운드(`리그 R18`)는 URL 이 아니라 **navigation state** 로만 온다 — `LeaguePage` 가
 * `navigate('/match/…', { state: { leagueRound } })` 로 들려 보내고 `MatchPage` 가 `location.state`
 * 에서 읽는다(`MatchDetail` 에는 라운드가 없다). react-router 6 은 그 값을 `history.state.usr` 에
 * 두므로, 같은 자리에 심고 **다시 로드**하면 리그 진입과 같은 헤더가 된다.
 */
async function openStage(
  page: Page,
  matchId: string,
  log: Log,
  opts: { detail?: Record<string, unknown>; leagueRound?: number } = {},
) {
  await mockApi(page, matchId, log, opts.detail);
  await page.goto(`/match/${matchId}`);
  if (opts.leagueRound != null) {
    await page.evaluate((r) => {
      const cur = (window.history.state ?? {}) as Record<string, unknown>;
      window.history.replaceState({ ...cur, usr: { leagueRound: r } }, "");
    }, opts.leagueRound);
    await page.reload();
  }
  await expect(page.getByTestId("stage-shell")).toBeVisible({ timeout: 20_000 });
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

const clockText = async (page: Page) => (await page.getByTestId("stage-clock").textContent())?.trim();

test.describe("#406 W2 헤더 시계 — 초까지", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("초가 그 분의 시작 틱에서 00 이고, 분이 넘어가기 전까지 커진다", async ({ page }) => {
    await openStage(page, "m-p406", REAL);

    await seekTo(page, ANCHOR_TICK);
    // 신선도 가드(#188) — 앵커/중간이 실제로 다른 값이어야 이 계약이 무언가를 검사한다.
    expect(expectedClock(REAL, ANCHOR_TICK)).not.toBe(expectedClock(REAL, MID_TICK));
    expect(await clockText(page), "그 분이 시작된 틱 = 00초").toBe(expectedClock(REAL, ANCHOR_TICK));
    expect(await clockText(page)).toMatch(/^\d+'00"$/);

    await seekTo(page, MID_TICK);
    expect(await clockText(page), "분 안쪽에서는 초가 흐른다").toBe(expectedClock(REAL, MID_TICK));
    const [, mm, ss] = /^(\d+)'(\d\d)"$/.exec((await clockText(page)) ?? "")!;
    expect(Number(ss), "초는 0~59 다 — `19'60\"` 같은 시각은 없다").toBeLessThan(60);
    expect(Number(mm), "분은 앵커 틱보다 앞이다").toBeLessThan(
      Number(/^(\d+)'/.exec(expectedClock(REAL, ANCHOR_TICK))![1]),
    );
  });

  test("초가 붙어도 헤더의 분 == 그 순간 로그줄의 분 (#388 불변식)", async ({ page }) => {
    await openStage(page, "m-p406", REAL);
    await seekTo(page, MID_TICK);

    const header = (await clockText(page))!;
    const headerMinute = Number(/^(\d+)'/.exec(header)![1]);
    expect(header, "통합 표기여야 이 계약이 초 포함 상태를 본다").toMatch(/^\d+'\d\d"$/);

    await page.getByTestId("stage-tab-log").click();
    const rows = page.getByTestId("stage-panel-log").locator("li");
    const lastText = ((await rows.last().textContent()) ?? "").trim();
    const logMinute = Number(/^(\d+)'/.exec(lastText)?.[1]);
    expect(Number.isFinite(logMinute), `로그줄에서 분을 읽었다: ${lastText}`).toBe(true);
    // 재생 위치까지의 줄만 보이므로 로그줄 ≤ 헤더, 그리고 **절반이 아니다**(구 규칙의 지문).
    expect(logMinute).toBeLessThanOrEqual(headerMinute);
    expect(logMinute).toBeGreaterThan(Math.floor(MID_TICK / 60));
    await page.screenshot({ path: "test-results/p406-header-seconds.png" });
  });

  /**
   * ★ **변이체 킬** — 화면이 스케일을 알고 있으면(예: `30` 을 상수로) 여기가 죽는다.
   * 같은 경기·같은 틱인데 로그의 표기 레짐만 다르다: 현행 `18'40"` vs 구 레짐 `9'20"`.
   */
  test("같은 틱이라도 로그의 표기 레짐이 다르면 시계가 다르다 (스케일 하드코딩 사망)", async ({ page }) => {
    const realExpected = expectedClock(REAL, CONTRAST_TICK);
    const legacyExpected = expectedClock(LEGACY, CONTRAST_TICK);
    // 신선도 가드 — 두 레짐이 같은 값이면 이 대조는 아무것도 증명하지 않는다.
    expect(legacyExpected).not.toBe(realExpected);

    await openStage(page, "m-p406", REAL);
    await seekTo(page, CONTRAST_TICK);
    expect(await clockText(page), "현행 레짐(30틱/표기분)").toBe(realExpected);

    await page.context().clearCookies();
    await openStage(page, "m-p406-legacy", LEGACY);
    await seekTo(page, CONTRAST_TICK);
    expect(await clockText(page), "구 레짐(60틱/표기분) — 화면이 로그를 따라간다").toBe(legacyExpected);
  });

  /**
   * 초가 붙으면 헤더가 그만큼 넓어진다(`20'` → `20'40"`, 3자). 시계가 잘리거나 헤더가 가로로
   * 넘치지 않는지 **실측**한다 — #322 가 "DOM 엔 있는데 화면엔 없다"로 당한 자리다.
   *
   * ⚠️ **표본은 가장 좁은 상태여야 한다**(`apps/web/CLAUDE.md` §322: *"계약은 가장 좁은 상태에서
   * 재라"*). 처음엔 **비리그** 매치로 쟀는데, 실제 최협 헤더는 **리그 뱃지(`리그 R18`) + 시계 +
   * 상태 태그 + 내 팀 표식**이 한 줄을 나눠 갖는 **리그 관전 중**이다(#322 어웨이 라운드 = 리그
   * 유저의 절반). 결함이 아니라 **커버 갭**이었으므로 기대는 그대로 두고 표본만 최협으로 옮긴다.
   * 전제(뱃지·상태·표식이 실제로 떠 있다)를 먼저 단언한다 — 안 그러면 "최협에서 쟀다"고 써 놓고
   * 조용히 넓은 헤더를 재게 된다.
   */
  test("가장 좁은 헤더(리그 관전 중, 390px)에서도 시계가 잘리지 않고 가로로 넘치지 않는다", async ({ page }) => {
    await openStage(page, "m-p406-league", REAL, {
      // 어웨이 라운드 형상(#322): 홈이 봇, 어웨이가 나 → 내 팀 표식이 붙어 슬롯이 더 좁아진다.
      detail: { mode: "league", leagueFixtureId: 77, homeName: "Thunder Bay United", awayName: "테스터" },
      leagueRound: 18,
    });
    await seekTo(page, MID_TICK);

    await expect(page.getByTestId("match-league-badge"), "리그 뱃지가 폭을 먹는 상태").toHaveText("리그 R18");
    await expect(page.getByTestId("match-state"), "관전 중 상태 태그").toHaveText("전반 진행 중");
    await expect(page.getByTestId("scorebar-my-team"), "내 팀 표식(#322)").toBeVisible();
    expect(await clockText(page), "초까지 붙은 상태에서 재야 의미가 있다").toMatch(/^\d+'\d\d"$/);

    const clock = page.getByTestId("stage-clock");
    const box = (await clock.boundingBox())!;
    expect(box.width, "시계 폭이 0 이면 잘린 것이다").toBeGreaterThan(40);
    expect(box.x + box.width, "시계 끝이 뷰포트 밖 = 화면엔 없다").toBeLessThanOrEqual(390.5);
    const clipped = await clock.evaluate((el) => el.scrollWidth - el.clientWidth > 1);
    expect(clipped, "시계 자체가 잘렸다").toBe(false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "헤더가 넓어져 페이지가 가로로 스크롤된다").toBeLessThanOrEqual(1);
  });
});
