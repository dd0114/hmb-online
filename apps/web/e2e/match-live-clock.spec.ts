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

const HALF_REAL_MS = 240_000;
const HALFTIME_MS = 60_000;

interface ClockOptions {
  phase: "FIRST_HALF" | "HALFTIME" | "SECOND_HALF";
  /** 이 단계가 시작된 지 몇 ms 지났는가(음수 없음). */
  elapsedMs: number;
}

function clockFor({ phase, elapsedMs }: ClockOptions) {
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
      return route.fulfill({ json: MATCH_LOG });
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

    // 끝까지 앞서가기 시도 → 상한(=지금)으로 회수
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

test.describe("AC-W2-1 감독시간 — 60초 카운트다운", () => {
  test("d. 남은 시간이 보이고, 만료되면 제출이 닫힌다", async ({ page }) => {
    await openMatch(page, "HALFTIME", clockFor({ phase: "HALFTIME", elapsedMs: HALFTIME_MS - 5_000 }));

    const countdown = page.getByTestId("halftime-countdown");
    await expect(countdown).toBeVisible();
    await expect(countdown).toContainText("감독시간");
    await expect(page.getByTestId("resume-button")).toBeEnabled();

    // 5초 뒤 만료 → 버튼이 닫히고 "전반 지시로 진행" 안내로 바뀐다.
    await expect(countdown).toContainText("감독시간 종료", { timeout: 20_000 });
    await expect(page.getByTestId("resume-button")).toBeDisabled();
  });

  test("e. 전반 중에도 후반 지시를 미리 저장한다(phase=halftime UPSERT)", async ({ page }) => {
    const posts = await openMatch(page, "FIRST_HALF", clockFor({ phase: "FIRST_HALF", elapsedMs: 10_000 }));

    await page.getByTestId("stage-toggle-brief").click();
    const input = page.getByTestId("brief-team-prompt");
    await expect(input).toBeEnabled();
    await input.fill("후반은 라인 내리고 역습");
    await page.getByTestId("brief-save").click();

    await expect(page.getByTestId("brief-saved")).toBeVisible();
    expect(posts, "전반 중 저장도 halftime 프롬프트로 나가야 한다").toContainEqual(
      expect.objectContaining({ phase: "halftime", scope: "team", text: "후반은 라인 내리고 역습" }),
    );
  });
});
