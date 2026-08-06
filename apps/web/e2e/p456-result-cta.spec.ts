import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * #456 B5 — *"경기 종료 후 각각 리그는 다음 경기 시작 버튼과 원정은 다음 원정 떠나기 버튼이
 * 있어야 해"*(hero verbatim).
 *
 * 구 동작: 결과 화면 바닥 CTA 는 **모드와 무관하게 `[로비로]` 하나**였다. 리그를 한 판 두고
 * 다음 라운드를 하려면 로비 → 리그 → [다음 경기] 세 번을 눌러야 했다.
 *
 * ## 이 스펙이 지키는 것 (세 가지, 전부 되돌리기 쉬운 실수의 자리다)
 *
 * 1. **`[로비로]` 는 어느 모드에서도 사라지지 않는다.** 다음 경기 CTA 가 실패하는 갈래가
 *    실재하므로(시즌 마지막 라운드 = `LEAGUE_INVALID`) 그 버튼을 대체하면 유저가 갇힌다.
 *    게다가 `to-lobby` 는 #348/#355 세로 예산 계약이 **좌표로 재는 앵커**라 없애면 그쪽이 깨진다.
 * 2. **원정은 뮤테이션을 직접 부르지 않는다** — `/away` 로 **이동만** 한다. 서버의 상대 제시는
 *    유저당 1개라 여기서 갱신시키면 유저가 앞서 받아 둔 목록이 조용히 무효가 된다
 *    (#245 hero E2 — apps/web CLAUDE.md 의 "원정은 [원정 떠나기]에서 막는다"와 같은 이유).
 * 3. **모드를 모르면(구 서버 · 필드 부재) 구 동작 그대로**다. 없는 값을 리그로 추측하면
 *    연습 경기 뒤에 "다음 경기 시작"이 떠서 엉뚱한 리그 라운드를 연다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다(glob 은 vite 소스 `/src/api/*.ts` 까지 잡아 흰 화면).
 */

const MATCH_ID = "m-p456";
const NEXT_ID = "m-p456-next";
const RESUME_ID = "m-p456-resume";

interface Harness {
  mode?: "practice" | "league" | "away";
  /** `POST /api/league/next-match` 가 실제로 불린 횟수 — "이동만" 계약의 증거. */
  nextCalls: number;
  /** 원정 제시 갱신(`POST /api/away/offers`) 호출 — **0 이어야 한다**. */
  awayOfferCalls: number;
  /** 다음 경기 요청에 돌려줄 실패(없으면 성공). */
  nextFailure?: { status: number; code: string; message: string; detail?: unknown };
}

function detailOf(h: Harness, id = MATCH_ID) {
  return {
    id,
    state: "FINISHED",
    scoreH1Home: 1,
    scoreH1Away: 0,
    scoreHome: 2,
    scoreAway: 1,
    result: "WIN",
    auto: false,
    createdAt: "2026-08-06T09:00:00Z",
    opponent: { name: "봇 FC" },
    ...(h.mode ? { mode: h.mode } : {}),
  };
}

async function mockApi(page: Page, h: Harness) {
  await page.route("**/*", async (route) => {
    const req: Request = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();

    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: { id: "u1", nickname: "테스터", points: 100, wins: 1, draws: 0, losses: 0, isAdmin: false },
        },
      });
    }
    if (url.pathname === "/api/league/next-match" && req.method() === "POST") {
      h.nextCalls++;
      if (h.nextFailure) {
        const { status, ...body } = h.nextFailure;
        return route.fulfill({ status, json: body });
      }
      return route.fulfill({
        json: { match: detailOf(h, NEXT_ID), fixture: { round: 7 } },
      });
    }
    // 원정 제시 갱신 — 이 스펙에서는 **한 번도 불리면 안 된다**(계약 2).
    if (url.pathname.startsWith("/api/away/") && req.method() === "POST") {
      h.awayOfferCalls++;
      return route.fulfill({ json: {} });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill({ json: detailOf(h) });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: { matchId: MATCH_ID, result: "WIN", scoreHome: 2, scoreAway: 1, rewardPoints: 300 },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) {
      return route.fulfill({ json: { events: [], tickSnapshots: [] } });
    }
    if (url.pathname === "/api/me/active-match") {
      return route.fulfill({ json: { match: null, locked: false, abandonable: false } });
    }
    return route.fulfill({ json: {} });
  });
}

async function openResult(page: Page, over: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = { nextCalls: 0, awayOfferCalls: 0, ...over };
  await mockApi(page, h);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("result-page")).toBeVisible({ timeout: 20_000 });
  return h;
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe("#456 B5 — 종료 후 다음 행동 CTA", () => {
  test("전제 — 이 스펙은 폰 세로에서 돈다(뷰포트를 안 걸면 조용히 데스크탑으로 돈다)", async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
  });

  test("a. 연습(모드 없음/practice)은 구 동작 그대로 — [로비로] 하나뿐", async ({ page }) => {
    await openResult(page, { mode: "practice" });
    await expect(page.getByTestId("to-lobby")).toBeVisible();
    await expect(page.getByTestId("result-next-cta")).toHaveCount(0);
  });

  test("a-2. 모드를 모르면(구 서버) 추측하지 않는다 — 역시 [로비로] 하나", async ({ page }) => {
    await openResult(page);
    await expect(page.getByTestId("to-lobby")).toBeVisible();
    await expect(page.getByTestId("result-next-cta")).toHaveCount(0);
  });

  test("b. 리그 = [다음 경기 시작] — 그리고 [로비로]도 남는다", async ({ page }) => {
    await openResult(page, { mode: "league" });
    const cta = page.getByTestId("result-next-cta");
    await expect(cta).toHaveText("다음 경기 시작");
    await expect(page.getByTestId("to-lobby")).toBeVisible();

    /*
     * 두 버튼이 **화면 안에** 있고 서로 겹치지 않는다. `toBeVisible()` 은 뷰포트 밖도 통과하므로
     * (루트 §계약 표 #3) 좌표로 잰다 — #355 가 정확히 이 자리에서 CTA 를 화면 밖에 두고 있었다.
     */
    const geo = await page.evaluate(() => {
      const box = (id: string) => {
        const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
        return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
      };
      return { next: box("result-next-cta"), lobby: box("to-lobby"), h: innerHeight, w: innerWidth };
    });
    expect(geo.next!.bottom).toBeLessThanOrEqual(geo.h);
    expect(geo.lobby!.bottom).toBeLessThanOrEqual(geo.h);
    expect(geo.next!.top).toBeGreaterThanOrEqual(0);
    // 나란히든 위아래든 겹치지만 않으면 된다(배치는 조정 가능 — 겹침만 결함이다).
    const overlaps =
      geo.next!.left < geo.lobby!.right &&
      geo.lobby!.left < geo.next!.right &&
      geo.next!.top < geo.lobby!.bottom &&
      geo.lobby!.top < geo.next!.bottom;
    expect(overlaps, "두 CTA 가 겹친다").toBe(false);
  });

  test("c. 리그 CTA = 서버에 다음 경기를 요청하고 그 매치로 간다", async ({ page }) => {
    const h = await openResult(page, { mode: "league" });
    await page.getByTestId("result-next-cta").click();
    await page.waitForURL(`**/match/${NEXT_ID}`, { timeout: 15_000 });
    expect(h.nextCalls).toBe(1);
  });

  test("d. 원정 = [다음 원정 떠나기] — /away 로 **이동만** 한다(제시를 갱신하지 않는다)", async ({ page }) => {
    const h = await openResult(page, { mode: "away" });
    const cta = page.getByTestId("result-next-cta");
    await expect(cta).toHaveText("다음 원정 떠나기");
    await expect(page.getByTestId("to-lobby")).toBeVisible();

    await cta.click();
    await page.waitForURL("**/away", { timeout: 15_000 });
    /*
     * ⚠️ 이 단언이 이 계약의 핵심이다 — 여기서 상대 제시를 새로 받아 오면(뮤테이션 직접 호출)
     * 유저가 앞서 받아 둔 후보 목록이 무효가 된다(#245 hero E2). 화면 이동만 한다.
     */
    expect(h.awayOfferCalls, "원정 CTA 가 제시를 갱신했다").toBe(0);
  });

  test("e. 마지막 라운드 뒤(LEAGUE_INVALID)는 막다른 길이 아니다 — 안내 + [로비로] 유지", async ({ page }) => {
    await openResult(page, {
      mode: "league",
      nextFailure: { status: 400, code: "LEAGUE_INVALID", message: "남은 라운드가 없습니다" },
    });
    await page.getByTestId("result-next-cta").click();

    const alert = page.getByTestId("result-next-error");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("남은 라운드가 없습니다");
    // 화면에 남되 나갈 길은 열려 있다.
    await expect(page.getByTestId("result-page")).toBeVisible();
    await expect(page.getByTestId("to-lobby")).toBeVisible();
  });

  test("f. 409(이미 진행 중)는 에러가 아니라 이어가기 안내다 — 그 매치로 간다", async ({ page }) => {
    await openResult(page, {
      mode: "league",
      nextFailure: {
        status: 409,
        code: "MATCH_IN_PROGRESS",
        message: "이미 진행 중인 경기가 있습니다",
        detail: { matchId: RESUME_ID },
      },
    });
    await page.getByTestId("result-next-cta").click();
    await page.waitForURL(`**/match/${RESUME_ID}`, { timeout: 15_000 });
  });
});
