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
  /**
   * **정산 후** 레이팅 — `FINISHED` 관측 뒤의 `/api/me` 응답이 이 값으로 바뀐다(m1).
   *
   * ⚠️ 이 축이 없던 동안 목은 레이팅을 **상수 하나**로만 줬고, 그래서 "정산 전 값을 그린다"는
   * 회귀가 전 계약을 통과했다(apps/web CLAUDE.md 표 **#4** = 픽스처가 두 상태를 뭉갠다).
   * 카드가 읽는 값의 신선도는 `MatchPage` 의 `["me"]` 무효화에 달려 있는데, 두 값이 같으면
   * 그 무효화를 지워도 관측값이 안 변한다. `undefined` 면 정산 전후가 같다(구 표본).
   */
  ratingAfter: number | undefined;
  /**
   * 이 경기가 만든 **레벨업 선택권**(#405) — `[playerId, 이름, level]`. 순서 = 카드 순서.
   * 봉투 `GROWTH` 섹션과 `GET /api/growth/choices` 양쪽에 같은 것이 실린다(서버가 그렇게 준다).
   */
  choices: { playerId: string; name: string; level: number }[];
  /** 이미 고른 선택권 id — `GET /api/growth/choices` 에서 빠진다. */
  chosen: string[];
  /**
   * **권위 조회를 늦춘다** — `/result` 의 `resultDelayMs` 와 짝인 축(BL-1).
   *
   * ⚠️ 이 손잡이가 없던 동안 `n`(이미 고른 선택권은 카드가 되지 않는다)은 코드의 성질이 아니라
   * **두 쿼리의 도착 순서**를 재고 있었다 — 목이 즉답이라 교차가 늘 제때 일어났을 뿐이다
   * (모듈 CLAUDE.md 표 #4: 픽스처가 두 상태를 뭉갠다).
   */
  choicesDelayMs: number;
  /**
   * **첫 응답만 이 매치를 모르는 목록**(`[]`)으로 준다 — 라이브의 **캐시 오염**을 재현한다.
   *
   * `usePendingChoices(undefined, …)` 의 queryKey 는 `growthChoicesKey(undefined)` **전역 하나**라
   * `RewardSheet`·`GrowthReportSection` 이 같은 캐시를 채운다. `staleTime` 이 0 이라 마운트마다
   * 리페치가 돌지만, 그 사이 react-query 는 **낡은 값을 동기로** 돌려준다 — 직전 매치에서 선택을
   * 다 골랐다면 그 값이 `[]` 다.
   */
  choicesFirstEmpty: boolean;
  /** `/api/growth/choices` 가 몇 번 불렸나(위 축의 상태 + m3 발화 여부 관측). */
  choicesHits: number;
  /** 권위 조회를 500 으로 떨어뜨린다 — **스냅샷 폴백** 갈래(m5). */
  choicesFails: boolean;
  /** `/result` 를 500 으로 떨어뜨린다(보상 조회 실패 갈래). */
  resultFails: boolean;
  /** `/result` 응답을 늦춘다 — **도착 전에 카드 수를 세는** 경주를 재현하는 유일한 손잡이. */
  resultDelayMs: number;
  acked: string[];
}

/**
 * 후보 3장 — **gain 내림차순이 아니다**(서버는 `positionBaseline × gain` 으로 정렬한다).
 * 재정렬 변이가 이 픽스처에서 죽는다: `pace` 가 gain 최대인데 마지막이다.
 */
const candidatesOf = (playerId: string) => [
  { stat: "tackling", gain: 2.1, core: true },
  { stat: "physical", gain: 1.4, core: true },
  { stat: "pace", gain: 3.6, core: false, reason: { kind: "EVENT", detail: { playerId } } },
];

const choiceIdOf = (playerId: string) => `ch-${playerId}`;

function pendingChoiceOf(c: Harness["choices"][number]) {
  return {
    choiceId: choiceIdOf(c.playerId),
    playerId: c.playerId,
    level: c.level,
    candidates: candidatesOf(c.playerId),
  };
}

/** 봉투 `GROWTH` 섹션 = `GET /api/growth/report` 와 **같은 자료**(서버가 한 함수로 만든다). */
function growthEntriesOf(h: Harness) {
  return h.choices.map((c) => ({
    playerId: c.playerId,
    name: c.name,
    position: "DF",
    grade: "GOLD",
    xpGained: 120,
    levelBefore: c.level,
    levelAfter: c.level + 1,
    cardXp: 10,
    xpToNext: 200,
    minutes: "starter",
    pendingChoices: [pendingChoiceOf(c)],
  }));
}

/** `GET /api/growth/card/{playerId}` — 후보 카드가 `from → to` 를 만들 수 있게 하는 최소 모양. */
function cardEffectiveOf(playerId: string) {
  const attrs = {
    pace: 44, shooting: 40, passing: 41, technical: 42,
    tackling: 44, positioning: 43, physical: 45, stamina: 46, mental: 47,
  };
  const caps = Object.fromEntries(Object.keys(attrs).map((k) => [k, 73]));
  return {
    playerId,
    grade: "GOLD",
    star: 2,
    attributes: attrs,
    prePotential: attrs,
    base: attrs,
    caps,
    statLevels: {},
    startLo: 32,
    potential: { unlocked: true, tier: "RARE", maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 5 },
    ovr: 44,
    completion: 0.2,
  };
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
      // 정산 전/후를 **다른 값**으로 준다(m1) — 두 상태를 뭉개면 신선도 회귀가 안 보인다.
      const rating =
        h.state === "FINISHED" && h.ratingAfter !== undefined ? h.ratingAfter : h.rating;
      return route.fulfill(
        json({
          user: { id: "u1", nickname: "테스터", isAdmin: false },
          wallet: { points: 20000, gems: 50 },
          records: { wins: 1, draws: 0, losses: 0 },
          ...(rating === undefined ? {} : { rating }),
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
            h.currency.length > 0 || h.choices.length > 0
              ? {
                  bundleId: "b-p456r",
                  source: "MATCH",
                  sourceRef: MATCH_ID,
                  acknowledgedAt: null,
                  sections: [
                    ...(h.currency.length > 0 ? [{ kind: "CURRENCY", entries: h.currency }] : []),
                    ...(h.choices.length > 0
                      ? [{ kind: "GROWTH", entries: growthEntriesOf(h) }]
                      : []),
                  ],
                }
              : null,
        }),
      );
    }
    if (url.pathname === "/api/growth/choices") {
      // "지금 남은 것"의 권위는 봉투 스냅샷이 아니라 이 조회다(`usePendingChoices` 주석).
      const first = h.choicesHits === 0;
      h.choicesHits += 1;
      if (h.choicesDelayMs > 0) await new Promise((r) => setTimeout(r, h.choicesDelayMs));
      if (h.choicesFails) {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) });
      }
      if (first && h.choicesFirstEmpty) return route.fulfill(json({ choices: [] }));
      return route.fulfill(
        json({
          choices: h.choices
            .filter((c) => !h.chosen.includes(choiceIdOf(c.playerId)))
            .map(pendingChoiceOf),
        }),
      );
    }
    if (url.pathname.startsWith("/api/growth/card/")) {
      return route.fulfill(json(cardEffectiveOf(url.pathname.split("/").pop()!)));
    }
    if (req.method() === "POST" && /^\/api\/growth\/choices\/[^/]+$/.test(url.pathname)) {
      const choiceId = url.pathname.split("/").pop()!;
      const src = h.choices.find((c) => choiceIdOf(c.playerId) === choiceId);
      h.chosen.push(choiceId);
      const stat = (req.postDataJSON() as { stat: string }).stat;
      const cand = candidatesOf(src?.playerId ?? "").find((x) => x.stat === stat);
      return route.fulfill(
        json({
          choiceId,
          playerId: src?.playerId ?? "",
          level: src?.level ?? 1,
          stat,
          gain: cand?.gain ?? 0,
          card: cardEffectiveOf(src?.playerId ?? ""),
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
    ratingAfter: undefined,
    choices: [],
    chosen: [],
    choicesDelayMs: 0,
    choicesFirstEmpty: false,
    choicesHits: 0,
    choicesFails: false,
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

  test("d. 원정 — 두 번째 카드가 **정산 후** 레이팅이다(정산 전 값을 그리면 죽는다)", async ({ page }) => {
    /*
     * ⚠️ **정산 전/후를 다른 값으로 준다**(m1). 레이팅은 서버가 `finishMatch` 에서 갱신하고 화면은
     * `MatchPage` 의 `FINISHED` 최초 관측 → `["me"]` 무효화로 그 값을 받는다. 목이 상수 하나면
     * 그 무효화를 지워도 관측값이 같아서 **회귀가 계약을 그대로 통과한다**(표 #4).
     * 1043 = 정산 전 · 1102 = 정산 후. 카드가 말해야 하는 것은 후자다.
     */
    const h = await openMatch(page, { mode: "away", daily: null, rating: 1043, ratingAfter: 1102 });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "currency");
    await expect(page.getByTestId("match-reward-pager")).toHaveText("1 / 2");
    await page.getByTestId("match-reward-next").click();

    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "rating");
    await expect(page.getByTestId("match-reward-rating-value")).toHaveText("1102");
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

  test("i. 순차 공개의 **정답이 배경에 미리 인쇄돼 있지 않다** (W1 독립검증 major-2)", async ({ page }) => {
    /*
     * 실캡처가 잡은 것: 카드 `1/2 골드 +1,200 G` 를 보는 **동안** 뒤 결과 패널에 `경기 보상
     * +1,200 G` 와 `오늘의 보상 +30 Z` 가 그대로 읽혔다(백드롭 `rgba(0,0,0,0.72)`). 골드 3회 ·
     * 잼 2회 노출이고, 그러면 **순차 공개가 첫 카드에서 이미 무효**다 = B3 의 목적 자체가 사라진다.
     *
     * ⚠️ **`toBeVisible()` 로 재면 안 된다**(표 #3) — 오버레이가 전면을 덮으므로 `elementFromPoint`
     * 도 언제나 오버레이를 돌려준다(0.72 백드롭에서도). 이 결함이 사는 축은 "그 문자열이 화면에
     * 실재하는가"라서, 고치는 방식도 **배경에서 그 줄을 걷는 것**이고 계약도 그것을 잰다.
     * ⚠️ 그리고 **양성 대조가 같이 있어야** 한다(표 #6) — 걷는 것이지 지우는 것이 아니므로,
     * 흐름이 끝나면 같은 줄이 같은 금액으로 돌아와야 한다.
     */
    const h = await openMatch(page, { mode: "league" });
    await finish(page, h);
    /*
     * ⚠️ 앵커를 **여기 둘 수 없다** — 종료 전이 순간부터 브릿지가 이미 떠 있어서 그 줄은 이 시점에도
     * 미뤄져 있다. 그래서 "이 표본에서는 그 줄이 원래 그려진다"를 증명하는 것은 **맨 아래 양성
     * 대조**다(흐름이 끝나면 같은 금액으로 돌아온다). 그게 없으면 위 `toHaveCount(0)` 들은
     * "아직 안 그려짐"도 통과하는 공허한 단언이 된다(표 #6).
     */
    await page.getByTestId("flow-bridge-next").click();
    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "currency");
    await expect(page.getByTestId("match-reward-currency-POINT")).toHaveAttribute("data-amount", "1200");

    // 카드가 떠 있는 동안 배경에 같은 금액 문자열이 **없다**.
    await expect(page.getByTestId("reward-points")).toHaveCount(0);
    await expect(page.getByTestId("reward-daily")).toHaveCount(0);

    await page.getByTestId("match-reward-next").click();
    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "daily");
    await expect(page.getByTestId("reward-points")).toHaveCount(0);
    await expect(page.getByTestId("reward-daily")).toHaveCount(0);

    // 양성 대조 — 흐름이 끝나면 결과 카드의 보상 줄이 그대로 돌아온다(미룬 것이지 지운 것이 아니다).
    await page.getByTestId("match-reward-next").click();
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
    await expect(page.getByTestId("reward-points")).toContainText("1,200");
    await expect(page.getByTestId("reward-daily")).toHaveAttribute("data-slot", "3");
  });

  test("j. `/result` 가 에러 없이 매달려도 **탈출구가 있다** (W1 독립검증 major-3)", async ({ page }) => {
    /*
     * 이 창의 그릇은 `dismissable={false}` 모달이라 ESC·백드롭 클릭이 안 먹고, 로딩 갈래에는
     * 컨트롤이 **0개**였다. `apiFetch` 에 타임아웃이 없으므로(3s 타임아웃은 runtime config 전용)
     * 요청이 **에러 없이** 매달리면 유저는 끝난 경기 결과에 영영 못 간다 — `g` 가 막는 것은
     * 실패(500)뿐이고 무응답은 그 갈래로 떨어지지 않는다.
     */
    const h = await openMatch(page, { mode: "league", resultDelayMs: 30_000 });
    await finish(page, h);
    const t0 = Date.now();
    await page.getByTestId("flow-bridge-next").click();
    await expect(page.getByTestId("match-reward-loading")).toBeVisible();

    // 즉시 뜨면 그건 상한이 아니라 로딩 화면의 버튼이다 — 기다린 뒤에만 나온다.
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("match-reward-pending-exit")).toHaveCount(0);

    const exit = page.getByTestId("match-reward-pending-exit");
    await expect(exit).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - t0, "상한 전에 뜨면 안 된다").toBeGreaterThan(4_000);
    // 그 버튼은 **다이얼로그 안**에 있어야 한다(밖에 있으면 포커스 트랩이 못 닿는다).
    expect(await page.getByTestId("flow-continuation").getByRole("button").count()).toBeGreaterThan(0);

    await exit.click();
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
    await expect(page.getByTestId("result-page")).toBeVisible();
  });
});

/* ───────────────────────────────────────────────────────────────────────────────────────────
 * AC3 — **선수별 순차**. 골드 → 모드별 → 레벨업한 선수를 한 명씩.
 *
 * hero: *"경기 종료 보상 페이지를 순차화하자 — 골드 보상, 레이팅 보상, 그리고 **선수별로**."*
 * 스택·페이저·도트는 `ReportCardStack` 이 이미 갖고 있고(#57 재발명 금지), 후보 3장·적용·축하는
 * `growth/ChoiceCards` 가 갖는다(보상 시트·강화탭과 **같은 컴포넌트** = 설계 §2.10).
 * 이 묶음이 새로 지키는 것은 **순서 · 세 버튼의 의미 · 건너뛴 선택권이 남는가** 셋이다.
 * ─────────────────────────────────────────────────────────────────────────────────────────── */

const TWO_CHOICES = [
  { playerId: "P001", name: "김수비", level: 4 },
  { playerId: "P002", name: "박미드", level: 7 },
];

async function openWithChoices(page: Page, over: Partial<Harness> = {}) {
  const h = await openMatch(page, { mode: "practice", daily: null, choices: TWO_CHOICES, ...over });
  await finish(page, h);
  await page.getByTestId("flow-bridge-next").click();
  return h;
}

test.describe("#456 B3 W2 — 선수별 순차 선택 (AC3)", () => {
  test("k. 골드 다음에 **선수 카드가 사람 수만큼** 선다 (순서·페이저·본인 확인)", async ({ page }) => {
    await openWithChoices(page);
    const card = page.getByTestId("match-reward-card");

    await expect(card).toHaveAttribute("data-card", "currency");
    // 연습이라 모드별 카드는 없다 → 골드 1 + 선수 2 = 3장.
    await expect(page.getByTestId("match-reward-pager")).toHaveText("1 / 3");
    await page.getByTestId("match-reward-next").click();

    // 첫 선수 — **누구의 무슨 레벨업인지**가 카드에 있어야 "누구 걸 고르는 중이지?"가 안 된다.
    await expect(card).toHaveAttribute("data-kind", "choice");
    await expect(card).toHaveAttribute("data-player", "P001");
    await expect(page.getByTestId("match-reward-pager")).toHaveText("2 / 3");
    await expect(card).toContainText("김수비");
    await expect(card).toContainText("Lv 4 → 5");
    await expect(page.getByTestId("choice-candidates").locator("button")).toHaveCount(3);
    // 🚨 후보 순서는 응답 그대로다 — gain 최대(`pace` 3.6)가 꼴찌인 픽스처라 재정렬이 여기서 죽는다.
    expect(
      await page
        .getByTestId("choice-candidates")
        .locator("button")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid"))),
    ).toEqual(["choice-cand-tackling", "choice-cand-physical", "choice-cand-pace"]);

    // 실화면 증거 — 목적지는 `test-results/`(gitignore). 리포의 `evidence/**` 를 더럽히지 않는다.
    await page.screenshot({ path: "test-results/p456-choice-card-390.png" });

    // [다음에] = 이 선수를 건너뛴다(고르지 않고 넘긴다).
    await page.getByTestId("match-reward-choice-later").click();
    await expect(card).toHaveAttribute("data-player", "P002");
    await expect(card).toContainText("박미드");
    await expect(card).toContainText("Lv 7 → 8");
    await expect(page.getByTestId("match-reward-pager")).toHaveText("3 / 3");
    /*
     * 마지막 장에는 `[전체 건너뛰기]` 가 **없다**(m2) — 남길 것이 없는 자리에서 `[다음에]` 와
     * 완전히 같은 동작을 하는 두 번째 버튼은 "무엇을 건너뛰는가"를 묻게 만든다.
     * 앵커: 같은 장에 `[다음에]` 는 살아 있다(버튼이 통째로 사라진 상태를 통과시키지 않는다).
     */
    await expect(page.getByTestId("match-reward-choice-later")).toBeVisible();
    await expect(page.getByTestId("match-reward-choice-skip-all")).toHaveCount(0);

    await page.getByTestId("match-reward-choice-later").click();
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
  });

  test("l. `[이 스탯 선택]` → 적용·축하 → 다음 선수 (서버로 그 선택이 간다)", async ({ page }) => {
    const h = await openWithChoices(page);
    await page.getByTestId("match-reward-next").click(); // 골드 → 첫 선수

    await page.getByTestId("choice-cand-pace").click();
    await expect(page.getByTestId("choice-celebration")).toBeVisible();
    await expect(page.getByTestId("choice-applied")).toHaveAttribute("data-stat", "pace");
    expect(h.chosen).toEqual(["ch-P001"]);

    /*
     * ⚠️ 적용 뒤에는 이 버튼이 **`다음에`가 아니다** — 미룬 것이 없는데 "다음에"라고 쓰면 방금 한
     * 선택이 취소된 것처럼 읽힌다. 라벨이 곧 그 순간의 뜻이다.
     */
    const later = page.getByTestId("match-reward-choice-later");
    await expect(later).toHaveText("다음");
    await later.click();
    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-player", "P002");

    /*
     * ⚠️ **선택해도 카드가 사라지지 않는다.** 적용은 `["growthChoices"]` 를 무효화하므로 목록을
     * 그대로 따라가면 방금 고른 선수의 카드가 스택에서 빠지고 **인덱스가 밀려 다음 선수를 건너뛴다**.
     * 이 스택은 열린 순간의 목록으로 박제돼 있어야 한다 — `3 / 3` 이 그 증거다(2 / 2 가 되면 죽는다).
     */
    await expect(page.getByTestId("match-reward-pager")).toHaveText("3 / 3");

    // 마지막 장의 버튼은 목적지를 말한다.
    await expect(page.getByTestId("match-reward-choice-later")).toHaveText("다음에");
    await page.getByTestId("choice-cand-tackling").click();
    await expect(page.getByTestId("match-reward-choice-later")).toHaveText("결과 보기");
    await page.getByTestId("match-reward-choice-later").click();
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
    expect(h.chosen).toEqual(["ch-P001", "ch-P002"]);
  });

  test("m. `[전체 건너뛰기]` = **선택권을 남긴다**(서버 자동선택 0)", async ({ page }) => {
    /*
     * hero 게이트 확정사항: 전체 건너뛰기는 *포기*가 아니라 *미룸*이다. 서버는 아무 일도 하지
     * 않고(작업 0), 남은 선택권은 강화탭 `선택 대기 N` 에서 그대로 고를 수 있다.
     * ⚠️ 그래서 여기서 재는 것은 "화면이 닫혔다"가 아니라 **선택권이 서버에 그대로 있다** 이다.
     */
    const h = await openWithChoices(page);
    await page.getByTestId("match-reward-next").click(); // 골드 → 첫 선수
    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-player", "P001");

    await page.getByTestId("match-reward-choice-skip-all").click();
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0);

    // 아무것도 고르지 않았다 = 서버가 대신 골라 주지 않았다.
    expect(h.chosen).toEqual([]);
    expect(h.acked).toEqual([]);
    // 그리고 남은 선택권은 이어지는 시트가 그대로 회수한다(뱃지 = 선택 '횟수').
    await expect(page.getByTestId("reward-sheet")).toBeVisible();
    await expect(page.getByTestId("reward-tab-badge")).toHaveText("2");
  });

  test("n. 이미 고른 선택권은 카드가 되지 않는다(봉투 스냅샷을 그대로 세지 않는다)", async ({ page }) => {
    /*
     * 봉투의 `pendingChoices` 는 **정산 시점 스냅샷**이라 유저가 고른 뒤에도 그대로다(`types.ts`
     * `bundleChoicesOf` 주석). 그것만 세면 강화탭에서 이미 고른 선수가 여기 또 나온다.
     */
    await openWithChoices(page, { chosen: ["ch-P001"] });
    await page.getByTestId("match-reward-next").click();

    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-player", "P002");
    await expect(page.getByTestId("match-reward-pager")).toHaveText("2 / 2");
  });

  /* ─────────────────────────────────────────────────────────────────────────────────────────
   * BL-1 — 스택은 **권위 조회를 기다린 뒤에** 굳는다 (S4-W2 독립검증 blocker)
   *
   * 스택은 열린 순간의 목록으로 **박제**된다(적용이 카드를 지워 인덱스가 밀리는 것을 막는다 —
   * 계약 `l`). 그런데 박제 게이트가 `/result` **하나만** 보고 있었다: `types.openChoicesOf` 는
   * `open` 이 `undefined` 면 **봉투 스냅샷을 그대로** 돌려주므로(`if (!open) return choices;`),
   * 권위 조회가 아직이면 **교차가 일어나지 않은 목록이 그대로 확정**되고 다시는 안 바뀐다.
   *
   * ⚠️ 같은 함수 15줄 위에 이미 이렇게 써 놓고도 `/result` 에만 걸었다 —
   *    *"응답 도착 전에 카드 수를 세지 마라."* 아래 두 표본이 그 구멍의 양쪽 끝이다.
   * ───────────────────────────────────────────────────────────────────────────────────────── */

  test("n-2. 권위 조회가 늦게 와도 **이미 고른 선택권이 카드가 되지 않는다**", async ({ page }) => {
    // 봉투 스냅샷은 2건(고른 것도 남아 있다), 서버가 말하는 남은 것은 1건.
    await openWithChoices(page, { chosen: ["ch-P001"], choicesDelayMs: 1_500 });

    await expect(page.getByTestId("match-reward-pager")).toHaveText("1 / 2");
    await page.getByTestId("match-reward-next").click();
    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-player", "P002");
  });

  test("n-3. 낡은 캐시(`[]`)로 굳지 않는다 — 전역 키를 다른 화면이 먼저 채운다", async ({ page }) => {
    /*
     * `usePendingChoices(undefined, …)` 의 queryKey 는 **전역 하나**이고 `staleTime` 이 0 이다.
     * 그래서 이 화면이 열릴 때 react-query 는 **낡은 값을 동기로** 돌려주면서 리페치를 건다.
     * 직전 매치에서 선택을 다 골랐다면 그 낡은 값은 `[]` → 교차 결과 ∅ → **선수 카드가 통째로
     * 사라지고** 유저는 골드 한 장만 본다. 프로덕션 경로다(`RewardSheet`·`GrowthReportSection`
     * 이 같은 키를 쓴다).
     * ⚠️ 그러므로 게이트는 "값이 왔나"가 아니라 **"이번 열림의 조회가 끝났나"** 여야 한다.
     */
    await openWithChoices(page, { choicesFirstEmpty: true });

    await expect(page.getByTestId("match-reward-pager")).toHaveText("1 / 3");
    await page.getByTestId("match-reward-next").click();
    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-player", "P001");
  });

  test("n-4. 선택권 0 인 경기는 **권위 조회를 기다리지 않는다**", async ({ page }) => {
    /*
     * BL-1 게이트의 `!needChoices ||` 항(m3). 봉투에 선택권이 없으면 이 화면은 그 조회를 구독조차
     * 하지 않으므로 **기다릴 이유도 없다**.
     *
     * ⚠️ **재현 조건은 "연습이면 언제나"가 아니다** — 비활성 관찰자도 **같은 전역 키의 캐시를
     * 읽으므로**, 뒤의 `GrowthReportSection` 이 그 키를 이미 채웠으면 `isPending` 이 내려가 있어
     * 항을 빼도 안 갇힌다(즉답 목에서 실측: 양쪽 다 로딩 0). 갈라지는 것은 **그 공유 키 요청이
     * 아직 비행 중인 동안**(느린 망)이다 — 그래서 이 표본이 지연 30s 다.
     * ⚠️ 그 항을 빼면(변이 MUT-BL1d) 여기서 로딩 1 · 카드 0 이 되고, 유저는 받을 것도 없는 조회를
     * 기다리다 5초 뒤 탈출 버튼을 본다.
     */
    const h = await openMatch(page, {
      mode: "practice",
      daily: null,
      choices: [],
      choicesDelayMs: 30_000,
    });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    // 앵커 — **카드가 실제로 섰다**. 이게 없으면 "로딩이 없다"는 화면 전멸에서도 참이다(표 #6).
    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "currency");
    await expect(page.getByTestId("match-reward-currency-POINT")).toHaveAttribute("data-amount", "1200");
    await expect(page.getByTestId("match-reward-loading")).toHaveCount(0);
  });

  test("n-5. 권위 조회가 **실패**하면 봉투 스냅샷으로 굳는다 — 문서화된 절충이다", async ({ page }) => {
    /*
     * 🚨 **이건 버그가 아니라 박제된 절충이다 — 고치려다 폴백을 없애지 마라**(m5).
     *
     * `types.openChoicesOf` 는 `open` 이 `undefined` 면 봉투 스냅샷을 그대로 돌려준다. 전역 쿼리
     * 클라이언트가 `retry:false` 라(`api/query-client.ts`) 500 은 즉시 확정되고, 그러면 이 화면이
     * 쓸 수 있는 목록은 스냅샷뿐이다 — **이미 고른 선택권까지 카드가 된다**(누르면 서버가 409
     * `CHOICE_ALREADY_MADE` 로 막고 `ChoiceCandidates` 가 목록을 새로 받는다).
     *
     * 왜 그게 최선인가: 대안은 ①선수 카드를 통째로 버린다(= 조회 한 번 실패했다고 이번 경기
     * 레벨업 보상이 화면에서 사라진다) ②무한 로딩(= 막다른 화면, major-3 이 없앤 그 상태)이다.
     * 셋 중 **보여 주고 서버가 막게 하는 쪽**을 골랐다.
     * ⚠️ 이 계약이 재는 것은 "옳은 목록"이 아니라 **"실패해도 흐름이 살아 있다"** 이다.
     */
    await openWithChoices(page, { chosen: ["ch-P001"], choicesFails: true });

    await expect(page.getByTestId("match-reward-pager")).toHaveText("1 / 3");
    await page.getByTestId("match-reward-next").click();
    // 스냅샷 그대로 = 이미 고른 P001 도 선다. 그 사실을 숨기지 않는다.
    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-player", "P001");
    await expect(page.getByTestId("choice-candidates").locator("button")).toHaveCount(3);

    // 그리고 **흐름은 끝까지 간다** — 실패가 결과 화면 도달을 막지 않는다(`g` 와 같은 규율).
    await page.getByTestId("match-reward-choice-later").click();
    await page.getByTestId("match-reward-choice-later").click();
    await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
    await expect(page.getByTestId("result-page")).toBeVisible();
  });

  test("o. 선택권이 없으면 선수 카드가 서지 않는다(빈 장을 만들지 않는다)", async ({ page }) => {
    const h = await openMatch(page, { mode: "practice", daily: null, choices: [] });
    await finish(page, h);
    await page.getByTestId("flow-bridge-next").click();

    await expect(page.getByTestId("match-reward-card")).toHaveAttribute("data-card", "currency");
    await expect(page.getByTestId("match-reward-pager")).toHaveCount(0);
    await expect(page.getByTestId("choice-candidates")).toHaveCount(0);
  });
});
