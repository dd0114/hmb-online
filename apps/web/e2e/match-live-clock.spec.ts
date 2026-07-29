import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * P4-E2 W3 (#170) — **서버 권위 시계**를 화면이 소비하는 계약. AC = PRD-v5 AC-W3-1 / AC-W2-1.
 *
 * 백엔드 없이 route-mock 으로 박제한다(라이브 백엔드에 붙으면 :8080 데모를 건드린다 —
 * 프로젝트 기지식 web-e2e-live-specs-hit-demo). 서버가 내려주는 `clock` 블록만 바꿔가며
 * 화면이 그 시각을 어떻게 해석하는지 본다.
 *
 * 계약:
 *  a. 늦게 접속하면 **경과 시점부터** 재생한다(seek-to-now) — 처음부터 다시 틀지 않는다.
 *  b. 라이브에서 앞으로 스크럽해도 **지금**으로 되돌아온다. 되감기는 자유.
 *  c. 감독시간에는 남은 시간이 카운트다운으로 보이고, 만료되면 제출이 닫힌다.
 *  d. 전반 중에도 후반 지시를 미리 저장할 수 있다(POST /prompts phase=halftime).
 *
 * ⚠️ 라우트 매칭은 pathname 술어로(glob 은 vite 소스 /src/api/*.ts 까지 잡아 흰 화면이 된다).
 */

const MATCH_ID = "m-clock";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);
const TICKS: number = MATCH_LOG.tickSnapshots.length;
/** 후반 로그(틱 오프셋 2700) — 서버 시계의 **인덱스**와 뷰어의 **절대 틱**을 섞으면 여기서 깨진다. */
const H2_TICK_OFFSET = 2700;
const H2_LOG = {
  ...MATCH_LOG,
  tickSnapshots: MATCH_LOG.tickSnapshots.map((s: { tick: number }) => ({ ...s, tick: s.tick + H2_TICK_OFFSET })),
  events: MATCH_LOG.events.map((e: { tick: number }) => ({ ...e, tick: e.tick + H2_TICK_OFFSET })),
};

// 서버 config 현행값(#216: 하이라이트 켬 모드 실측 재생 길이 정합 + 감독시간 3분).
const HALF_REAL_MS = 420_000;
const HALFTIME_MS = 180_000;

interface ClockOptions {
  phase: "FIRST_HALF" | "HALFTIME" | "SECOND_HALF";
  /** 이 단계가 시작된 지 몇 ms 지났는가(음수 없음). */
  elapsedMs: number;
  /** 창 길이 오버라이드(#216 페이스 계약용 — 데모 로그는 리얼 하프보다 짧다). */
  windowMs?: number;
}

function clockFor({ phase, elapsedMs, windowMs: windowOverride }: ClockOptions) {
  const now = Date.now();
  const windowMs = windowOverride ?? (phase === "HALFTIME" ? HALFTIME_MS : HALF_REAL_MS);
  const startAt = new Date(now - elapsedMs).toISOString();
  return {
    phase,
    kickoffAt: startAt,
    phaseStartAt: startAt,
    phaseEndsAt: new Date(now - elapsedMs + windowMs).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: phase === "HALFTIME" ? HALF_REAL_MS : windowMs,
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

/** 화면이 실제로 보낸 프롬프트 요청 기록 — 계약 d 검증용. */
type PromptPost = { phase: string; scope: string; text: string };

async function mockApi(page: Page, state: string, clock: ReturnType<typeof clockFor> | null, posts: PromptPost[]) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();

    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/prompts`) {
      posts.push(route.request().postDataJSON() as PromptPost);
      return route.fulfill({ json: { id: MATCH_ID, state, clock, createdAt: "2026-07-25T09:00:00Z" } });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      // 폴링마다 serverNow 가 갱신되는 실제 서버를 흉내낸다(스큐 보정 경로가 실제로 돈다).
      const fresh = clock ? { ...clock, serverNow: new Date().toISOString() } : null;
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          clock: fresh,
          scoreH1Home: state === "FIRST_HALF" ? null : 1,
          scoreH1Away: state === "FIRST_HALF" ? null : 0,
          createdAt: "2026-07-25T09:00:00Z",
          opponent: { name: "봇 FC" },
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) {
      // 후반 로그는 엔진이 하프를 이어 붙인 그대로 **틱이 2700 부터** 시작한다(인덱스 ≠ 틱).
      return route.fulfill({ json: url.pathname.endsWith("/halves/2/log") ? H2_LOG : MATCH_LOG });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, state: string, clock: ReturnType<typeof clockFor> | null) {
  const posts: PromptPost[] = [];
  await mockApi(page, state, clock, posts);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);

  await expect(page.getByTestId("stage-shell")).toBeVisible();
  return posts;
}

/** 뷰어 플레이헤드(원시 스냅샷 틱) — window.__viewer 는 코어가 노출하는 QA 훅이다. */
async function playhead(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = (window as unknown as { __viewer?: { cur(): { tick: number } } }).__viewer;
    return v ? Number(v.cur().tick) : -1;
  });
}

async function waitForViewer(page: Page) {
  /*
   * #244: 감독시간에는 무대가 **`경기장면` 탭 뒤**에 있다(hero 결정 — 그 상태의 화면은 덱 편성과
   * 같은 레이아웃이어야 한다). 이 파일의 계약(라이브 상한·되감기)은 뷰어가 떠 있어야 잴 수 있으므로
   * 탭이 있으면 먼저 연다. 관전(전·후반)에서는 탭이 없고 무대가 상시다.
   */
  const tab = page.getByTestId("stage-tab-stage");
  if (await tab.count()) await tab.click();
  await expect(page.locator('[data-testid^="viewer-canvas-half"]')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const v = (window as unknown as { __viewer?: { ready(): boolean } }).__viewer;
    return Boolean(v?.ready());
  }, undefined, { timeout: 20_000 });
}

test.describe("AC-W3-1 seek-to-now — 늦게 접속하면 경과 시점부터", () => {
  test("a. 전반 절반이 지난 뒤 접속하면 로그 중간부터 재생한다(0부터 아님)", async ({ page }) => {
    await openMatch(page, "FIRST_HALF", clockFor({ phase: "FIRST_HALF", elapsedMs: HALF_REAL_MS / 2 }));
    await waitForViewer(page);

    const expected = Math.floor(TICKS / 2);
    await expect
      .poll(() => playhead(page), { message: "경과 실시간에 해당하는 틱부터 시작해야 한다", timeout: 15_000 })
      .toBeGreaterThan(expected * 0.8);

    const tick = await playhead(page);
    expect(tick, "라이브 상한을 넘어 미래를 보여주면 안 된다").toBeLessThan(expected * 1.2);
  });

  test("b. 앞으로 스크럽해도 지금으로 되돌아온다 / 되감기는 유지된다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF", clockFor({ phase: "FIRST_HALF", elapsedMs: HALF_REAL_MS / 2 }));
    await waitForViewer(page);
    await expect.poll(() => playhead(page), { timeout: 15_000 }).toBeGreaterThan(10);

    // 끝까지 앞서가기 시도 → 상한(=지금)으로 회수.
    // #216: 자유 재생의 앞섬(연출 페이싱의 크루즈 구간)은 회수하지 않는다 — 드리프트 폭(하프의 12%)을
    // 넘는 **의도적 점프**만 되돌린다. 로그 끝으로 뛰는 건 그 폭을 한참 넘는다.
    await page.evaluate((t) => {
      (window as unknown as { __viewer?: { seek(tick: number): void } }).__viewer?.seek(t - 1);
    }, TICKS);
    await expect
      .poll(() => playhead(page), { message: "앞서가기는 막힌다(AC-W3-1)", timeout: 10_000 })
      .toBeLessThan(TICKS * 0.75);

    // 되감기는 자유 — 되돌린 지점이 유지된다(라이브 상한은 위쪽에만 있다).
    await page.evaluate(() => {
      (window as unknown as { __viewer?: { seek(tick: number): void }; }).__viewer?.seek(5);
    });
    expect(await playhead(page), "뒤로 감기까지 막으면 다시보기가 불가능해진다").toBeLessThan(60);
  });

  test("c. 지나간 하프(감독시간의 전반)는 상한 없이 끝까지 볼 수 있다", async ({ page }) => {
    await openMatch(page, "HALFTIME", clockFor({ phase: "HALFTIME", elapsedMs: 5_000 }));
    await waitForViewer(page);

    await page.evaluate((t) => {
      (window as unknown as { __viewer?: { seek(tick: number): void } }).__viewer?.seek(t - 2);
    }, TICKS);
    await page.waitForTimeout(600); // 라이브 게이트가 있었다면 이 사이에 되돌렸을 시간
    expect(await playhead(page), "감독시간에는 전반 전체가 리뷰 가능해야 한다").toBeGreaterThan(TICKS * 0.9);
  });
});

test.describe("AC-W2-1 감독시간 — 카운트다운(#216: 3분)", () => {
  test("d. 남은 시간이 보이고, 만료되면 제출이 닫힌다", async ({ page }) => {
    await openMatch(page, "HALFTIME", clockFor({ phase: "HALFTIME", elapsedMs: HALFTIME_MS - 5_000 }));

    const countdown = page.getByTestId("halftime-countdown");
    await expect(countdown).toBeVisible();
    await expect(countdown).toContainText("감독시간");
    // 3분 창의 마지막 5초 = 0:05 이하로 보인다(서버 값 파생 — 웹에 상수 복제 금지).
    await expect(countdown).toContainText(/0:0[0-5]/);
    await expect(page.getByTestId("resume-button")).toBeEnabled();

    // 5초 뒤 만료 → 버튼이 닫히고 "전반 지시로 진행" 안내로 바뀐다.
    await expect(countdown).toContainText("감독시간 종료", { timeout: 20_000 });
    await expect(page.getByTestId("resume-button")).toBeDisabled();
  });

  test("e. 전반 중에도 후반 지시를 미리 저장한다(phase=halftime UPSERT)", async ({ page }) => {
    const posts = await openMatch(page, "FIRST_HALF", clockFor({ phase: "FIRST_HALF", elapsedMs: 10_000 }));

    // #284: 토글이 사라져 탭이 상시다. 저장 버튼도 없다 — 타이핑이 멎으면 자동으로 나간다.
    await page.getByTestId("stage-tab-brief").click();
    const input = page.getByTestId("brief-team-prompt");
    await expect(input).toBeEnabled();
    await input.fill("후반은 라인 내리고 역습");

    await expect(page.getByTestId("brief-save-status")).toHaveAttribute("data-status", "saved");
    expect(posts, "전반 중 저장도 halftime 프롬프트로 나가야 한다").toContainEqual(
      expect.objectContaining({ phase: "halftime", scope: "team", text: "후반은 라인 내리고 역습" }),
    );
  });
});

/**
 * #216 AC2 — **재생 페이스가 서버 창에 맞물린다**.
 *
 * 구 구현은 라이브에서 연출(autoPace)을 끄고 압축비를 speed 에 그대로 꽂은 뒤, 250ms 마다 넘친
 * 플레이헤드를 `jumpToTick` 으로 끌어내렸다. 그 점프는 코어에서 **3 스냅샷 되감기 + resetStops +
 * clearCaptions** 를 동반한다 — 초당 4회 되감기·자막 소거·정지연출 재발화 = hero 가 본 "렌더링이
 * 버그 수준". 지금은 배율(paceRate)로 맞추고, 되감기는 드리프트 폭을 넘는 의도적 점프에만 남는다.
 *
 * 데모 로그(1440틱)의 연출 자연 재생 길이 = 229.6s(코어 페이싱 모델 실측) → 창을 그 값으로 잡으면
 * 배율이 1 근처에 머문다. 리얼 config 하프(2700틱)의 실측 420s ↔ `half-real-ms: 420000` 과 같은 관계다.
 */
const DEMO_NATURAL_MS = 230_000;

/** 브라우저 안에서 플레이헤드를 일정 간격으로 샘플링한다(왕복 지연이 섞이지 않게). */
async function samplePlayhead(page: Page, count: number, everyMs: number): Promise<number[]> {
  return page.evaluate(
    async ({ count, everyMs }) => {
      const v = (window as unknown as { __viewer?: { cur(): { tick: number } } }).__viewer!;
      const out: number[] = [];
      for (let i = 0; i < count; i++) {
        out.push(Number(v.cur().tick));
        await new Promise((r) => setTimeout(r, everyMs));
      }
      return out;
    },
    { count, everyMs },
  );
}

test.describe("#216 AC2 — 라이브 재생 페이스", () => {
  test("f. 플레이헤드가 되감기지 않는다(고무줄 회귀 가드)", async ({ page }) => {
    // **재생이 창을 앞지르는** 창을 잡아야 이 가드가 성립한다(앞섬이 없으면 회수 조건 자체가
    // 발화하지 않아 구 동작으로 되돌려도 통과한다 — 독립검증 major-2). 데모 로그 실측 재생은
    // 홀드 때문에 모델치(6.27틱/s)보다 느린 5틱/s 대라, 창을 자연 페이스의 1.35배로 늘려
    // 창 평균속도(≈4.6틱/s)를 재생보다 낮춘다. 실측 최속 경기(하프 392s vs 창 420s)의 확대판이다.
    const looseWindow = Math.round(DEMO_NATURAL_MS * 1.35);
    await openMatch(
      page,
      "FIRST_HALF",
      clockFor({ phase: "FIRST_HALF", elapsedMs: looseWindow * 0.3, windowMs: looseWindow }),
    );
    await waitForViewer(page);
    await expect.poll(() => playhead(page), { timeout: 15_000 }).toBeGreaterThan(TICKS * 0.2);

    const samples = await samplePlayhead(page, 40, 150); // ≈6초
    // 자연 재생의 뒤걸음은 정지 연출이 원인 틱으로 되짚는 것뿐이라 **한 프레임 미만**(<1틱)이다.
    // 회수 점프(jumpToTick)는 코어에서 3 스냅샷 되감기를 동반하므로 2틱 문턱이면 확실히 갈린다.
    const bigBacksteps = samples.filter((t, i) => i > 0 && t < samples[i - 1]! - 2);
    expect(bigBacksteps, `되감기 샘플: ${JSON.stringify(samples)}`).toHaveLength(0);
    expect(samples.at(-1)! - samples[0]!, "6초 동안 실제로 진행해야 한다").toBeGreaterThan(15);
  });

  test("g. 창에 맞춰 진행한다 — 재생 속도가 창의 평균속도를 따라간다", async ({ page }) => {
    await openMatch(
      page,
      "FIRST_HALF",
      clockFor({ phase: "FIRST_HALF", elapsedMs: DEMO_NATURAL_MS * 0.3, windowMs: DEMO_NATURAL_MS }),
    );
    await waitForViewer(page);
    await expect.poll(() => playhead(page), { timeout: 15_000 }).toBeGreaterThan(TICKS * 0.2);

    const samples = await samplePlayhead(page, 34, 150); // ≈5초
    const rate = (samples.at(-1)! - samples[0]!) / ((samples.length - 1) * 0.15);
    const windowRate = TICKS / (DEMO_NATURAL_MS / 1000); // 창이 요구하는 평균 속도(틱/실초)
    console.log(`[#216] 재생 ${rate.toFixed(2)} tick/s · 창 ${windowRate.toFixed(2)} tick/s`);
    // 하이라이트 슬로우·데드볼 홀드가 섞이므로 순간속도는 흔들린다 — 배(倍) 단위로 벗어나지만 않으면 된다.
    expect(rate).toBeGreaterThan(windowRate * 0.4);
    expect(rate).toBeLessThan(windowRate * 1.8);
  });

  test("h. 후반도 경과 지점부터 돌아간다 — 인덱스/절대틱 혼용 회귀 가드", async ({ page }) => {
    // 후반 로그는 틱이 2700 부터다. 서버 시계가 주는 **인덱스**를 그대로 jumpToTick 에 넘기면
    // 항상 로그 맨 앞으로 가고(=후반이 늘 0분부터), 상한 비교가 늘 참이라 매 250ms 되감긴다.
    await openMatch(
      page,
      "SECOND_HALF",
      clockFor({ phase: "SECOND_HALF", elapsedMs: DEMO_NATURAL_MS * 0.3, windowMs: DEMO_NATURAL_MS }),
    );
    await waitForViewer(page);

    const expected = H2_TICK_OFFSET + TICKS * 0.3;
    await expect
      .poll(() => playhead(page), { message: "후반도 경과 시점부터 시작해야 한다", timeout: 15_000 })
      .toBeGreaterThan(expected * 0.95);

    const samples = await samplePlayhead(page, 30, 150); // ≈4.5초
    expect(samples[0]!, "로그 맨 앞(2700 근처)에 갇히면 안 된다").toBeGreaterThan(H2_TICK_OFFSET + TICKS * 0.2);
    const bigBacksteps = samples.filter((t, i) => i > 0 && t < samples[i - 1]! - 2);
    expect(bigBacksteps, `후반 되감기 샘플: ${JSON.stringify(samples)}`).toHaveLength(0);
    expect(samples.at(-1)! - samples[0]!, "후반도 실제로 진행해야 한다").toBeGreaterThan(10);
  });
});
