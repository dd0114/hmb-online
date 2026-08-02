import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #421 W4 — **후반 디폴트 경기 화면 = 하이라이트 #1부터 주요 장면 순 재생**을 백엔드 없이 박제한다.
 *
 * 계약(hero 요구 ③ + 이 웨이브가 반드시 죽여야 하는 결함):
 *  a. 디폴트가 하이라이트고 **#1부터** 시작한다(전체 재생이 아니다).
 *  b. 장면이 끝나면 **다음 장면으로 이어진다**(사이의 지루한 구간은 건너뛴다).
 *  c. **전체 재생으로 돌아갈 수 있다** — 끄면 시퀀서가 손을 뗀다.
 *  d. 🔴 **라이브 상한을 넘는 미래 장면으로 뛰지 않는다**(스포일러 계약 #233/#238).
 *  e. 따라잡으면 **멈추지도 에러도 아니고** 라이브를 이어 재생한다.
 *  f. 🔴 **라이브 게이트가 항상 이긴다** — 시퀀서가 켜져 있어도 앞서보기 회수가 그대로 작동한다.
 *  g. 전반은 디폴트가 전체 재생이다(적용 범위 = 후반).
 *  ⚠️ **진행 중인 하프도 디폴트는 전체 재생**이다 — 되감기가 서버 권위 시계의 seek-to-now 규율과
 *     부딪히기 때문(`highlight-sequencer.DEFAULT_ON_WHILE_LIVE` 주석 · `match-live-clock` h).
 *     하프가 끝나 상한이 풀리면(FINISHED = 스킵의 종착 화면) 그 자리에서 하이라이트로 바뀐다.
 *  h. 장면이 0개여도 화면이 성립하고 토글은 사라지지 않는다(복귀 경로).
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면.
 * ⚠️ 이 스펙은 **기존 e2e 를 한 줄도 고치지 않는다**(#406 재작성 중 — 새 spec 파일로만).
 */

const MATCH_ID = "m-p421hl";
const DEMO = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
) as {
  tickSnapshots: { tick: number }[];
  events: { tick: number; type: string; detail?: string; team?: string; playerId?: string }[];
};

/**
 * **장면 판정은 여기서 다시 쓴다** — 앱 모듈(`highlight-reel`)을 import 하면 필터를 바꾸는 변이가
 * 계약을 그대로 통과한다(apps/web CLAUDE.md "초록으로 거짓말하는 방식" ②). 규칙 원문:
 * 장면 = `goal` ∪ `shot(detail==="saved")` ∪ `save`.
 */
function sceneTicksOf(events: readonly { tick: number; type: string; detail?: string }[]): number[] {
  const ticks = events
    .filter((e) => e.type === "goal" || e.type === "save" || (e.type === "shot" && e.detail === "saved"))
    .map((e) => e.tick);
  return [...new Set(ticks)].sort((a, b) => a - b);
}

/**
 * 남겨 둘 장면 두 개 — **멀리 떨어져 있어야** "건너뛰었다"가 자연 재생과 구분된다(아래 신선도 계약).
 *
 * ⚠️ **엔진이 움직이면 이 두 값을 다시 고른다**(시드 재선정 — 루트 CLAUDE.md 가 반복해 기록한 유형).
 * 데모 로그는 gitignore 생성물이고 `npm test` 의 `generate-demo.test.ts` 가 **현재 엔진으로** 다시
 * 굽는다. main 이 `packages/engine` 을 옮기면(#407 볼륨 재보정 + 골든 이동) 장면 틱이 통째로 바뀐다 —
 * 실제로 구 값 `799`/`1220` 은 engine@0.41.0-showcase 에 **존재하지 않는다**.
 *
 * ⚠️ 그때 이 스펙은 **조용히 초록이 되지 않는다** — `reelLog()` 가 "남길 틱"을 못 찾아 장면을 전부
 * 지우고, 그러면 d2·f·h 같은 계약이 **공허하게 통과**한다. 그걸 막는 것이 아래 신선도 계약이고,
 * 실제로 그것이 이 재선정을 잡았다(리베이스 직후 `장면 == []`).
 *
 * 고르는 기준(= 신선도 계약이 그대로 단언한다): `S1 > 720` · `S2 − S1 > 320` · `S2 + 100 < TICKS`.
 * 모양도 맞춘다 — S1 은 `shot:saved + save`(같은 틱), S2 는 `goal`.
 */
const S1 = 764; // shot:saved + save (같은 틱)
const S2 = 1238; // goal

/**
 * 데모 로그에서 **그 둘만 장면으로 남긴** 로그. 나머지 장면 이벤트는 지운다.
 *
 * 왜 이렇게까지 하나: 원본 데모 로그는 장면이 21개라 서로 30~150틱 간격이다. 그 간격은 자연 재생
 * (크루즈 4x ≈ 8틱/초)으로도 몇 초면 지나가서, "시퀀서가 건너뛴 것"과 "그냥 재생된 것"을 **구분할 수
 * 없다** — 그런 계약은 시퀀서를 통째로 지워도 통과한다. 764 → 1238 은 자연 재생으로 **50초 이상**이라
 * 테스트 창(≤20초) 안에 도달하면 그건 점프뿐이다.
 */
function reelLog(offsetTick = 0) {
  const keep = new Set([S1, S2]);
  const events = DEMO.events
    .filter((e) => keep.has(e.tick) || !sceneTicksOf([e]).length)
    .map((e) => ({ ...e, tick: e.tick + offsetTick }));
  return {
    ...DEMO,
    tickSnapshots: DEMO.tickSnapshots.map((s) => ({ ...s, tick: s.tick + offsetTick })),
    events,
  };
}

/** 장면이 **하나도 없는** 로그(계약 h). */
function scenelessLog() {
  return { ...DEMO, events: DEMO.events.filter((e) => !sceneTicksOf([e]).length) };
}

const TICKS = DEMO.tickSnapshots.length;
/** 후반 로그는 엔진이 하프를 이어 붙인 그대로 **틱이 오프셋부터** 시작한다 — 인덱스 ≠ 틱. */
const H2_OFFSET = 2700;
const HALF_REAL_MS = 420_000;
const HALFTIME_MS = 180_000;

function clockFor(phase: "FIRST_HALF" | "SECOND_HALF", elapsedFrac: number) {
  const now = Date.now();
  const startAt = new Date(now - HALF_REAL_MS * elapsedFrac).toISOString();
  return {
    phase,
    kickoffAt: startAt,
    phaseStartAt: startAt,
    phaseEndsAt: new Date(now - HALF_REAL_MS * elapsedFrac + HALF_REAL_MS).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: HALFTIME_MS,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
  };
}

const PLAYERS = Array.from({ length: 16 }, (_, i) => ({
  id: `p${i + 1}`,
  name: `선수${i + 1}`,
  position: i === 0 ? "GK" : "MF",
  grade: "B",
}));
const DECK = {
  formation: "4-3-3",
  slots: PLAYERS.slice(0, 11).map((p, i) => ({ slotIndex: i, playerId: p.id, role: "starter" as const })),
};

interface Setup {
  state: string;
  clock: ReturnType<typeof clockFor> | null;
  log: unknown;
}

async function mockApi(page: Page, s: Setup) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();

    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      const fresh = s.clock ? { ...s.clock, serverNow: new Date().toISOString() } : null;
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state: s.state,
          clock: fresh,
          scoreH1Home: s.state === "FIRST_HALF" ? null : 1,
          scoreH1Away: s.state === "FIRST_HALF" ? null : 0,
          scoreHome: s.state === "FINISHED" ? 2 : null,
          scoreAway: s.state === "FINISHED" ? 1 : null,
          result: s.state === "FINISHED" ? "WIN" : null,
          auto: false,
          createdAt: "2026-08-02T09:00:00Z",
          opponent: { name: "봇 FC" },
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: { matchId: MATCH_ID, result: "WIN", scoreHome: 2, scoreAway: 1, rewardPoints: 500 },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: s.log });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    if (url.pathname === "/api/me/active-match") {
      return route.fulfill({ json: { match: { id: MATCH_ID, state: s.state }, locked: false, abandonable: false } });
    }
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, s: Setup) {
  await mockApi(page, s);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
    /*
     * ⚠️ **플레이헤드는 페이지 안에서 50ms 격자로 기록한다.** 처음엔 테스트 쪽에서 500ms 마다
     * `cur()` 를 읽었는데, 그 표본은 **상한 위반을 놓친다** — 시퀀서가 미래로 뛰어도 라이브 게이트가
     * 250ms 안에 회수해 버려서, 두 주인이 서로 seek 를 미는 그 왕복이 표본 사이에 통째로 들어간다.
     * 실제로 "시퀀서가 상한을 무시한다" 변이가 그 방식으로는 **살아남았다**(#421 W4 변이 검증).
     * 기록은 로드 **전**부터 걸어 첫 점프까지 포함한다.
     */
    const w = window as unknown as { __hl?: number[]; __viewer?: { cur(): { tick: number } } };
    w.__hl = [];
    setInterval(() => {
      const v = w.__viewer;
      if (v) w.__hl!.push(Number(v.cur().tick));
    }, 50);
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
  await expect(page.locator('[data-testid^="viewer-canvas-half"]')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => Boolean((window as unknown as { __viewer?: { ready(): boolean } }).__viewer?.ready()),
    undefined,
    { timeout: 30_000 },
  );
}

/** 뷰어 플레이헤드(원시 스냅샷 틱). */
async function playhead(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = (window as unknown as { __viewer?: { cur(): { tick: number } } }).__viewer;
    return v ? Number(v.cur().tick) : -1;
  });
}

/**
 * `ms` 동안 페이지가 기록한 플레이헤드 표본(50ms 격자, 위 `openMatch` 주석).
 * 이전 구간을 지우고 새로 모은다 — "이 조작 **이후**"를 재는 계약(토글 끄기 등)에 필요하다.
 */
async function sample(page: Page, ms: number): Promise<number[]> {
  await page.evaluate(() => {
    (window as unknown as { __hl: number[] }).__hl.length = 0;
  });
  await page.waitForTimeout(ms);
  return page.evaluate(() => [...(window as unknown as { __hl: number[] }).__hl]);
}

/** 로드 시점부터의 **전 구간** 표본 — 첫 점프까지 포함해 상한 위반을 잰다. */
async function allSamples(page: Page): Promise<number[]> {
  return page.evaluate(() => [...(window as unknown as { __hl: number[] }).__hl]);
}

const toggle = (page: Page) => page.getByTestId("highlight-toggle");

/**
 * 이 시점에 화면이 **보여도 되는 최대 틱**. = 경과분(서버 창 진행률 × 스냅샷 수)
 * + 라이브 게이트가 눈감아 주는 자유재생 앞섬(하프의 12% — `live-pace.PACE_DRIFT_FRAC`) + 여유.
 * 값을 앱에서 import 하지 않는 것은 의도다(임계 변이가 계약을 통과하지 않게, apps/web CLAUDE.md ②).
 */
function liveBound(elapsedFrac: number, testWindowMs: number): number {
  const elapsed = ((elapsedFrac * HALF_REAL_MS + testWindowMs) / HALF_REAL_MS) * TICKS;
  return Math.ceil(elapsed + TICKS * 0.12) + 40;
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe("#421 W4 하이라이트 순서 재생", () => {
  test("픽스처 신선도 — 두 장면이 자연 재생으로는 못 건너올 만큼 떨어져 있어야 계약이 성립한다", () => {
    const scenes = sceneTicksOf(reelLog().events);
    expect(scenes, "남긴 장면은 정확히 둘이어야 한다").toEqual([S1, S2]);
    // 자연 재생 상한(크루즈 4x ≈ 8틱/초)으로도 이 간격은 40초 이상이다 = 테스트 창 안엔 못 온다.
    expect((S2 - S1) / 8).toBeGreaterThan(40);
    expect(S1 / 8).toBeGreaterThan(90);
    expect(sceneTicksOf(scenelessLog().events), "장면 0개 표본").toEqual([]);
    expect(TICKS).toBeGreaterThan(S2 + 100);
  });

  test("a·b. 종료된 경기 — 디폴트가 하이라이트고 #1 → #2 로 이어진다", async ({ page }) => {
    await openMatch(page, { state: "FINISHED", clock: null, log: reelLog() });

    await expect(toggle(page)).toHaveAttribute("data-highlight", "on");

    // #1 — 자연 재생이면 여기 오는 데 100초가 걸린다(위 신선도). 15초 안에 왔다 = 점프했다.
    await expect
      .poll(() => playhead(page), { message: "하이라이트 #1 로 바로 들어가야 한다", timeout: 15_000 })
      .toBeGreaterThan(S1 - 20);
    expect(await playhead(page), "장면을 지나쳐 버리면 안 된다").toBeLessThan(S1 + 40);
    await expect(page.getByTestId("highlight-status")).toContainText("#1");

    // #2 — 사이 421틱(≈50초)을 건너뛴다.
    await expect
      .poll(() => playhead(page), { message: "다음 장면으로 이어져야 한다", timeout: 20_000 })
      .toBeGreaterThan(S2 - 20);
    await expect(page.getByTestId("highlight-status")).toContainText("#2");
  });

  test("c. 전체 재생 복귀 — 끄면 시퀀서가 손을 뗀다", async ({ page }) => {
    await openMatch(page, { state: "FINISHED", clock: null, log: reelLog() });
    await expect.poll(() => playhead(page), { timeout: 15_000 }).toBeGreaterThan(S1 - 20);

    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("data-highlight", "off");
    // 상태 줄은 재생 중인 하이라이트가 없을 때 렌더 자체가 없다.
    await expect(page.getByTestId("highlight-status")).toHaveCount(0);

    /*
     * ⚠️ 12초를 재는 것이 조건이다. 6초면 **"끈 것을 무시하고 시퀀서가 다시 도는" 변이가 살아남는다** —
     * 재시작한 시퀀서는 커서가 -1 이라 먼저 지금 자리(#1)로 되돌아가는데, 그 이동이 몇 틱뿐이라
     * "큰 점프 없음"을 통과한다. 다음 장면(#2)으로 건너뛰는 데까지 봐야 죽는다(실측 ~7초).
     */
    const ticks = await sample(page, 12_000);
    expect(ticks.length).toBeGreaterThan(4);
    // 자연 재생만 남는다 = 큰 점프가 없다(0.5초에 8틱 안팎, 넉넉히 60).
    for (let i = 1; i < ticks.length; i++) {
      expect(Math.abs(ticks[i]! - ticks[i - 1]!), "끈 뒤에도 시퀀서가 점프하고 있다").toBeLessThan(60);
    }
    expect(Math.max(...ticks), "#2 로 건너뛰면 안 된다").toBeLessThan(S2 - 100);
    // 토글은 남는다 — 다시 켤 수 있어야 한다(복귀는 양방향이다).
    await expect(toggle(page)).toBeVisible();
  });

  test("d·e. 라이브 후반 — 상한 밖 장면으로 뛰지 않고, 따라잡으면 라이브를 이어 재생한다", async ({ page }) => {
    // 후반 10% 경과 = 상한 ≈ 144틱. 두 장면(764·1238)은 **아직 미래**다.
    await openMatch(page, {
      state: "SECOND_HALF",
      clock: clockFor("SECOND_HALF", 0.1),
      log: reelLog(H2_OFFSET),
    });
    /*
     * 라이브 하프의 **디폴트는 전체 재생**이다(`DEFAULT_ON_WHILE_LIVE=false`) — 하이라이트 #1로
     * 되감으면 서버 권위 시계의 seek-to-now 규율과 부딪히고 그 계약이 이미 있다
     * (`match-live-clock.spec.ts` h: 후반 라이브 되감기 표본 0). 유저가 **켜면** 그때 돈다.
     */
    await expect(toggle(page)).toHaveAttribute("data-highlight", "off");
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("data-highlight", "on");

    await page.waitForTimeout(8_000);
    // 로드 시점부터의 **전 구간**을 본다 — 시퀀서가 미래로 뛰었다가 게이트에 회수되는 250ms 왕복은
    // 성긴 표본으로는 안 잡힌다(위 `openMatch` 주석).
    const ticks = (await allSamples(page)).map((t) => t - H2_OFFSET);
    /*
     * 🔴 스포일러 계약. 임계는 **"장면 근처"가 아니라 상한**이다 — 장면 기준(`S1 - 8`)으로 잡으면
     * 리드인 착지(764−8−3스냅 = 753)가 그 아래라 **상한을 무시하는 변이가 그대로 통과한다**
     * (실제로 처음 그렇게 썼다가 H1 변이가 살아남았다). 상한 = 경과분 + 게이트가 눈감아 주는
     * 자유재생 앞섬(`live-pace.PACE_DRIFT_FRAC` 12%)이고, 그 밖은 어느 것도 화면에 오면 안 된다.
     */
    expect(Math.max(...ticks), "라이브 상한 밖으로 뛰었다").toBeLessThan(liveBound(0.1, 9_000));
    // 정지도 에러도 아니다 — 라이브가 그대로 흐른다.
    expect(Math.max(...ticks)).toBeGreaterThan(Math.min(...ticks));
    await expect(page.locator('[data-testid^="viewer-visual-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="viewer-canvas-half"]')).toBeVisible();
  });

  test("d2. 라이브 상한 **안**의 장면은 재생하고, 그다음 장면은 열릴 때까지 안 뛴다", async ({ page }) => {
    // 후반 60% 경과 = 상한 ≈ 1153틱 → 764 는 열렸고 1238 은 아직이다.
    await openMatch(page, {
      state: "SECOND_HALF",
      clock: clockFor("SECOND_HALF", 0.6),
      log: reelLog(H2_OFFSET),
    });
    await toggle(page).click(); // 라이브 디폴트는 전체 재생 — 유저가 켠다(위 d·e 주석).

    await expect
      .poll(() => playhead(page).then((t) => t - H2_OFFSET), {
        message: "상한 안 장면은 하이라이트 #1 로 재생해야 한다",
        timeout: 15_000,
      })
      .toBeGreaterThan(S1 - 20);

    /*
     * ⚠️ 12초를 기다리는 것이 이 계약의 조건이다. 6초로 줄이면 **상한을 무시하는 변이가 살아남는다** —
     * 장면 근처에서 코어가 연출 페이싱을 1x 로 늦추고 데드볼 홀드까지 걸어서, 그 사이엔 아직
     * "다음 장면"으로 넘어갈 시점이 오지 않는다(실측: #1 구간을 빠져나오는 데만 ~7초).
     */
    await page.waitForTimeout(12_000);
    const ticks = (await allSamples(page)).map((t) => t - H2_OFFSET);
    // 임계는 상한 기준이다(위 d·e 주석 — 장면 기준으로 잡으면 리드인 착지가 그 아래로 숨는다).
    expect(Math.max(...ticks), "아직 안 열린 장면으로 뛰었다").toBeLessThan(liveBound(0.6, 22_000));
    expect(liveBound(0.6, 22_000), "이 계약이 #2 를 실제로 배제해야 한다").toBeLessThan(S2 - 8);
  });

  test("f. 라이브 게이트가 이긴다 — 하이라이트가 켜져 있어도 앞서보기는 그대로 막힌다", async ({ page }) => {
    await openMatch(page, {
      state: "SECOND_HALF",
      clock: clockFor("SECOND_HALF", 0.6),
      log: reelLog(H2_OFFSET),
    });
    await toggle(page).click(); // 하이라이트를 **켜 둔 채로** 앞서보기를 시도한다.
    await expect(toggle(page)).toHaveAttribute("data-highlight", "on");
    await expect.poll(() => playhead(page), { timeout: 15_000 }).toBeGreaterThan(H2_OFFSET);

    // 로그 끝으로 앞서가기 시도 → 게이트가 상한으로 회수한다(AC-W3-1). 시퀀서는 그 창에서 손을 뗀다.
    // ⚠️ **seek 이 실제로 먹었는지 같은 호출 안에서 확인한다** — 안 그러면 seek 이 무시돼도 "회수됐다"로
    //    읽혀 계약이 공허하게 통과한다(apps/web CLAUDE.md "초록으로 거짓말하는 방식" ⑥).
    const afterSeek = await page.evaluate((t) => {
      const v = (window as unknown as { __viewer?: { seek(tick: number): void; cur(): { tick: number } } }).__viewer;
      v?.seek(t);
      return v ? Number(v.cur().tick) : -1;
    }, H2_OFFSET + TICKS - 2);
    expect(afterSeek - H2_OFFSET, "앞서가기가 적용돼야 회수 계약이 성립한다").toBeGreaterThan(TICKS * 0.9);
    await expect
      .poll(() => playhead(page).then((t) => t - H2_OFFSET), {
        message: "앞서보기 회수가 시퀀서 때문에 무력해지면 안 된다",
        timeout: 15_000,
      })
      .toBeLessThan(TICKS * 0.75);
  });

  test("g. 전반은 디폴트가 전체 재생이다(적용 범위 = 후반)", async ({ page }) => {
    /*
     * ⚠️ 경과를 **70%** 로 잡는 것이 이 계약의 핵심이다. 10% 로 잡으면 상한이 두 장면 앞이라
     * "디폴트가 켜져 있어도" 뛸 곳이 없어 계약이 공허하게 통과한다(#421 W4 자체 변이 확인).
     * 70% 면 하이라이트 #1(764)이 상한 안이고 seek-to-now 는 그 뒤(≈1008)라, 시퀀서가 돌았다면
     * 플레이헤드가 **뒤로** 끌려간다 — 그 뒷걸음질이 없다는 것으로 디폴트 OFF 를 잰다.
     */
    await openMatch(page, { state: "FIRST_HALF", clock: clockFor("FIRST_HALF", 0.7), log: reelLog() });
    await expect(toggle(page)).toHaveAttribute("data-highlight", "off");
    await expect(page.getByTestId("highlight-status")).toHaveCount(0);

    const start = await playhead(page);
    expect(start, "seek-to-now 가 장면 #1 보다 뒤에 서 있어야 계약이 성립한다").toBeGreaterThan(S1 + 100);
    const ticks = await sample(page, 5_000);
    expect(Math.min(...ticks), "전반에서 하이라이트가 저절로 돌면 안 된다").toBeGreaterThan(start - 60);

    /*
     * 그리고 **켜면 전반에서도 돈다** — 이 두 단언이 한 쌍이라야 "디폴트 OFF"가 "기능 없음"과
     * 구분된다(하나만 두면 시퀀서를 통째로 지워도 앞 단언이 통과한다).
     */
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("data-highlight", "on");
    await expect
      .poll(() => playhead(page), { message: "켜면 하이라이트 #1 로 되돌아간다", timeout: 15_000 })
      .toBeLessThan(S1 + 40);
    expect(await playhead(page)).toBeGreaterThan(S1 - 20);
  });

  test("h. 장면이 0개여도 화면이 성립하고 토글은 사라지지 않는다", async ({ page }) => {
    await openMatch(page, { state: "FINISHED", clock: null, log: scenelessLog() });

    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("data-highlight", "on");
    await expect(page.getByTestId("highlight-status")).toHaveCount(0);

    const ticks = await sample(page, 5_000);
    // 평범한 재생이 돈다 — 멈추지도, 엉뚱한 데로 뛰지도 않는다.
    expect(Math.max(...ticks)).toBeGreaterThan(Math.min(...ticks));
    for (let i = 1; i < ticks.length; i++) {
      expect(Math.abs(ticks[i]! - ticks[i - 1]!)).toBeLessThan(60);
    }
    await expect(page.locator('[data-testid^="viewer-visual-error"]')).toHaveCount(0);
  });
});
