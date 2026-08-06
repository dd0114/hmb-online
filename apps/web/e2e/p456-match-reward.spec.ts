import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * #456 S4 · B3 웨이브 1 — **경기 종료 보상이 결과 화면 앞에 순차로 선다**(AC1) + **모드별 두 번째
 * 카드**(AC2).
 *
 * 무엇이 새로 배선됐나: `matchEndContinuation` 은 #424 가 만들어 두고 **프로덕션 호출부가 0** 이던
 * 확장점이다(`App.tsx` 가 인자 없이 `MatchPage` 를 렌더했다). 그래서 브릿지 CTA 를 누르면 오버레이가
 * 그냥 닫혔고, 보상은 그 뒤에 오는 `StageShell` 소유 시트가 **탭으로** 보여 줬다.
 *
 * 이 스펙이 지키는 것:
 *  ⓐ 브릿지 CTA 라벨이 `보상 받기` 이고, 누르면 **같은 층에서** 보상 스택이 뜬다(C3).
 *  ⓑ 카드 순서 = **골드 → 모드별**. 리그 = 오늘의 보상 칸(잼) · 원정 = 레이팅 · 연습 = 없음.
 *  ⓒ **금액은 서버를 따라온다**(#232 · hero "예 30잼" 은 economy 값이지 코드 상수가 아니다) —
 *     같은 화면을 다른 값으로 두 번 재서 하드코딩이 통과할 수 없게 한다.
 *  ⓓ 마지막 카드를 닫으면 **결과 화면**에 도달한다. 보상 조회가 실패해도 도달한다(C5 축).
 *  ⓔ 보상 스택이 떠 있는 동안 #405 시트와 **겹치지 않는다**(포커스 트랩 2겹 금지) — 그리고
 *     닫으면 미확인 봉투는 그 시트가 여전히 회수한다(미루기지 삼키기가 아니다).
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다(glob `**\/api\/**` 는 vite 소스까지 잡아 흰 화면).
 * ⚠️ 전이는 **`GEN2 → FINISHED`** 로 만든다 — 캔버스를 띄우지 않아 `match-log.json` 신선도(#464)에
 *    의존하지 않는다. 이 전이도 경기 종료 브릿지를 연다(`p424` ⑧ 이 그 계약).
 */

const MATCH_ID = "m-p456r";
const PHONE = { width: 390, height: 844 };

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

interface Harness {
  state: string;
  mode: "practice" | "league" | "away" | undefined;
  /** 봉투 재화 줄. 빈 배열이면 재화 카드가 없다. */
  currency: { code: string; amount: number }[];
  /** 리그 매치가 소비한 오늘의 보상 칸(#368). 리그가 아니면 서버가 안 준다. */
  daily: Record<string, unknown> | null;
  /** `/api/me` 의 원정 레이팅(#245 additive). `undefined` = 구 서버. */
  rating: number | undefined;
  /** `/result` 를 500 으로 떨어뜨린다(보상 조회 실패 갈래). */
  resultFails: boolean;
  /** `/result` 응답을 늦춘다 — **도착 전에 카드 수를 세는** 경주를 재현하는 유일한 손잡이. */
  resultDelayMs: number;
  acked: string[];
}

function detailOf(h: Harness) {
  const finished = h.state === "FINISHED";
  return {
    id: MATCH_ID,
    state: h.state,
    ...(h.mode ? { mode: h.mode } : {}),
    scoreHome: finished ? 2 : null,
    scoreAway: finished ? 1 : null,
    result: finished ? "WIN" : null,
    clock: null,
    createdAt: "2026-08-06T09:00:00Z",
    opponent: { name: "붉은늑대 FC" },
  };
}

async function mockApi(page: Page, h: Harness) {
  await page.route("**/*", async (route) => {
    const req: Request = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();

    if (url.pathname === "/api/me") {
      return route.fulfill(
        json({
          user: { id: "u1", nickname: "테스터", isAdmin: false },
          wallet: { points: 20000, gems: 50 },
          records: { wins: 1, draws: 0, losses: 0 },
          ...(h.rating === undefined ? {} : { rating: h.rating }),
        }),
      );
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill(json(detailOf(h)));
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      if (h.resultFails) {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) });
      }
      if (h.resultDelayMs > 0) await new Promise((r) => setTimeout(r, h.resultDelayMs));
      return route.fulfill(
        json({
          matchId: MATCH_ID,
          result: "WIN",
          scoreHome: 2,
          scoreAway: 1,
          pointsAwarded: 1200,
          ...(h.daily ? { dailyReward: h.daily } : {}),
          rewardBundle:
            h.currency.length > 0
              ? {
                  bundleId: "b-p456r",
                  source: "MATCH",
                  sourceRef: MATCH_ID,
                  acknowledgedAt: null,
                  sections: [{ kind: "CURRENCY", entries: h.currency }],
                }
              : null,
        }),
      );
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill(json({ events: [] }));
    if (/^\/api\/rewards\/[^/]+\/ack$/.test(url.pathname)) {
      h.acked.push(url.pathname);
      return route.fulfill(json({}));
    }
    if (url.pathname === "/api/players") return route.fulfill(json([]));
    if (url.pathname === "/api/me/active-match") {
      return route.fulfill(json({ match: detailOf(h), locked: true, abandonable: false }));
    }
    return route.fulfill(json({}));
  });
  await mockAppConfig(page);
}

async function openMatch(page: Page, over: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = {
    state: "GEN2",
    mode: "league",
    currency: [{ code: "POINT", amount: 1200 }],
    daily: { slotNo: 3, currency: "GEM", amount: 30, result: "WIN", awarded: true },
    rating: 1043,
    resultFails: false,
    resultDelayMs: 0,
    acked: [],
    ...over,
  };
  await mockApi(page, h);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("genwait-panel")).toBeVisible({ timeout: 20_000 });
  return h;
}

/** 종료 전이를 만들고 브릿지를 연다. */
async function finish(page: Page, h: Harness) {
  h.state = "FINISHED";
  await expect(page.getByTestId("flow-bridge")).toBeVisible({ timeout: 20_000 });
}

/** 보임(visible)과 눌림(hit)은 다르다 — 겹친 층이 CTA 를 덮지 않는지 좌표로 잰다(#294·#355 실적). */
async function hitTestId(page: Page, target: Locator): Promise<string | null> {
  const box = await target.boundingBox();
  expect(box, "CTA 가 레이아웃에 존재해야 한다").not.toBeNull();
  return page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return el ? (el.getAttribute("data-testid") ?? el.tagName) : null;
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2],
  );
}

test.use({ viewport: PHONE });

test.describe("#456 B3 W1 — 경기 종료 보상 순차 (AC1·AC2)", () => {
  test("a. 리그 — 브릿지 `보상 받기` → 골드 → 오늘의 보상 칸 → 결과 화면", async ({ page }) => {
    const h = await openMatch(page, { mode: "league" });
    await finish(page, h);

    // ⓐ 라벨이 continuation 유무의 파생이다 — 배선 전에는 `보상과 결과 보기` 였다.
    const bridgeCta = page.getByTestId("flow-bridge-next");
    await expect(bridgeCta).toHaveText("보상 받기");
    await bridgeCta.click();

    // C3 — 라우트가 아니라 **같은 오버레이 안**이다.
    await expect(page.getByTestId("flow-continuation")).toBeVisible();
    const card = page.getByTestId("match-reward-card");
    await expect(card).toHaveAttribute("data-card", "currency");
    await expect(page.getByTestId("match-reward-pager")).toHaveText("1 / 2");

    // 금액·재화 이름은 **서버 표기 메타**를 따라온다(#232) — 화면에 심볼을 적지 않는다.
    const gold = page.getByTestId("match-reward-currency-POINT");
    await expect(gold).toHaveAttribute("data-amount", "1200");
    await expect(gold).toContainText("골드");

    const next = page.getByTestId("match-reward-next");
    expect(await hitTestId(page, next), "보상 CTA 를 덮는 층이 없어야 한다").toBe("match-reward-next");
    await next.click();

    await expect(card).toHaveAttribute("data-card", "daily");
    const gem = page.getByTestId("match-reward-daily-amount");
    await expect(gem).toHaveAttribute("data-amount", "30");
    await expect(gem).toHaveAttribute("data-currency", "GEM");
    await expect(card).toContainText("3번째 칸");

    // ⓓ 마지막 장을 닫으면 결과 화면이다.
    await page.getByTestId("match-reward-next").click();
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
    await expect(page.getByTestId("result-page")).toBeVisible();
  });

  test("a-2. 보상 응답이 늦게 와도 카드를 건너뛰지 않는다(0장으로 읽는 경주)", async ({ page }) => {
    /*
     * ⚠️ 이 경주는 **평소 표본에서 안 보인다** — `StageShell` 이 `FINISHED` 에서 `/result` 를 이미
     * 받아 두고 `staleTime: Infinity` 라 캐시가 대개 따뜻하다. 그런데 `GEN2 → FINISHED`(시계 롤백,
     * `p424` ⑧) 처럼 셸이 **그 순간에 마운트되는** 경로에서는 따뜻하지 않다. 도착 전에 카드 수를
     * 세면 `[]` 이고, 그러면 "보여 줄 게 없다"로 읽혀 **보상이 통째로 건너뛰어진다**.
     * 지연을 넣어야만 그 상태를 밟을 수 있으므로 하니스에 손잡이를 뒀다.
     */
    const h = await openMatch(page, { mode: "practice", daily: null, resultDelayMs: 900 });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    await expect(page.getByTestId("match-reward-loading")).toBeVisible();
    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "currency");
    await expect(page.getByTestId("match-reward-currency-POINT")).toHaveAttribute("data-amount", "1200");
  });

  test("b. 리그 — 칸 금액이 서버 값을 따라온다(하드코딩 30 이면 죽는다)", async ({ page }) => {
    /*
     * hero 확정값은 "예 30잼" 이지만 그 30 은 `data/players/economy.v3.json`
     * (`league.dailyReward.small`)의 값이다 — 운영이 무배포로 돌리는 노브다. 화면이 그 값을
     * 따라오지 않으면 #232 의 `DICE_BUY_COST = 500` 사고(지갑이 10배로 줄었다)와 같은 자리가 된다.
     */
    const h = await openMatch(page, {
      mode: "league",
      currency: [],
      daily: { slotNo: 9, currency: "GEM", amount: 300, result: "WIN", awarded: true },
    });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    const card = page.getByTestId("match-reward-card");
    await expect(card).toHaveAttribute("data-card", "daily");
    // 재화 카드가 없으므로 한 장짜리 스택 = 페이저가 없다.
    await expect(page.getByTestId("match-reward-pager")).toHaveCount(0);
    await expect(page.getByTestId("match-reward-daily-amount")).toHaveAttribute("data-amount", "300");
  });

  test("c. 리그 — 진 판은 칸이 **소멸**했다고 말한다(칸이 소비된 사실을 숨기지 않는다)", async ({ page }) => {
    const h = await openMatch(page, {
      mode: "league",
      currency: [],
      daily: { slotNo: 4, currency: "GEM", amount: 30, result: "LOSS", awarded: false },
    });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    const card = page.getByTestId("match-reward-card");
    await expect(card).toHaveAttribute("data-card", "daily");
    await expect(card).toHaveAttribute("data-awarded", "0");
    await expect(page.getByTestId("match-reward-daily-vanished")).toBeVisible();
  });

  test("d. 원정 — 두 번째 카드가 레이팅이다(서버 `/api/me` 값 그대로)", async ({ page }) => {
    const h = await openMatch(page, { mode: "away", daily: null, rating: 1043 });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "currency");
    await expect(page.getByTestId("match-reward-pager")).toHaveText("1 / 2");
    await page.getByTestId("match-reward-next").click();

    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "rating");
    await expect(page.getByTestId("match-reward-rating-value")).toHaveText("1043");
  });

  test("d-2. 원정 — 레이팅 축이 없는 구 서버면 두 번째 카드를 지어내지 않는다", async ({ page }) => {
    const h = await openMatch(page, { mode: "away", daily: null, rating: undefined });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "currency");
    await expect(page.getByTestId("match-reward-pager")).toHaveCount(0);
    await expect(page.getByTestId("match-reward-rating-value")).toHaveCount(0);
  });

  test("e. 연습 — 두 번째 카드가 없다(골드 한 장으로 끝난다)", async ({ page }) => {
    const h = await openMatch(page, { mode: "practice", daily: null });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "currency");
    await expect(page.getByTestId("match-reward-pager")).toHaveCount(0);
    await expect(page.getByTestId("match-reward-next")).not.toHaveText("다음");

    await page.getByTestId("match-reward-next").click();
    await expect(page.getByTestId("result-page")).toBeVisible();
  });

  test("f. 보여 줄 보상이 하나도 없으면 흐름이 멈추지 않는다(그대로 결과 화면)", async ({ page }) => {
    // W2b 이전 매치 = 봉투 없음 + 연습. 카드가 0장이면 **오버레이가 스스로 끝난다**.
    const h = await openMatch(page, { mode: "practice", currency: [], daily: null });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();
    await expect(page.getByTestId("result-page")).toBeVisible();
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
  });

  test("g. 보상 조회가 실패해도 결과 화면에 도달한다(연출이 동선을 막지 않는다)", async ({ page }) => {
    /*
     * `StarterReveal` 과 같은 규율 — *"연출이 없다고 동선이 막히면 안 된다"*. 여기서 화면이 굳으면
     * 유저는 끝난 경기의 결과를 영영 못 본다(오버레이는 백드롭 닫기가 없다, `dismissable={false}`).
     */
    const h = await openMatch(page, { mode: "league", resultFails: true });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();
    /*
     * ⚠️ **`result-page` 가 보인다는 것만으로는 부족하다** — 결과 패널은 오버레이 **뒤에** 이미
     * 그려져 있어서 오버레이가 걸린 채로도 `toBeVisible()` 이 통과한다(CLAUDE.md 표 #3).
     * 변이 검증에서 실제로 그 형태가 살아남았다: `nothingToShow → onDone` 을 지워도 이 단언만
     * 있으면 green 이었다. **오버레이가 사라졌나**를 같이 봐야 계약이 성립한다.
     */
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("result-page")).toBeVisible();
  });

  test("h. #405 시트와 겹치지 않고, 닫으면 시트가 미확인 봉투를 회수한다", async ({ page }) => {
    /*
     * ⚠️ 이 웨이브는 보상 시트를 **대체하지 않는다**(웨이브 2 = 선수별 순차 + 정보 감량). 지금
     * 확인해야 할 것은 두 가지다: ① 두 오버레이가 같은 순간에 뜨지 않는다(`common/Modal` 포커스
     * 트랩 2겹 = 설계가 기각한 사고 유형) ② 그렇다고 시트를 **삼키지 않는다** — 미션(#408)처럼
     * `[받기]` 를 눌러야 지급되는 섹션이 봉투에 섞이면 시트를 건너뛰는 것이 곧 **실제 손실**이다.
     */
    const h = await openMatch(page, { mode: "practice", daily: null });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    await expect(page.getByTestId("match-reward-card")).toBeVisible();
    await expect(page.getByTestId("reward-sheet")).toHaveCount(0);
    expect(await page.locator('[role="dialog"]').count()).toBe(1);

    await page.getByTestId("match-reward-next").click();
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
    await expect(page.getByTestId("reward-sheet")).toBeVisible();
    // 아직 ack 를 치지 않았다 = 보상 카드가 봉투를 대신 확인해 주지 않는다.
    expect(h.acked).toEqual([]);
  });
});
