import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * #456 S4 · B3 **AC5 — 전 구간 E2E**.
 *
 * ## 이 스펙이 처음으로 덮는 것 (조각 계약과의 차이)
 *
 * S4 가 만든 계약은 전부 **한 층씩**이다:
 *  · `p424` = 브릿지가 뜨는가(그 뒤는 `flow-continuation` 이 사라졌나까지만)
 *  · `p456-match-reward` = **보상 오버레이 안**(브릿지 CTA 클릭으로 시작해 오버레이가 닫히면 끝)
 *  · `p456-result-cta` = **결과 화면에 착지한 상태에서 시작**(`state: "FINISHED"` 로 goto)
 *
 * 그래서 **경기 종료부터 다음 행동까지 한 사람이 끊기지 않고 걷는** 계약이 없었다. 세 조각이 각자
 * 초록이어도 이음매가 끊기면(예: 시트가 안 뜬다 · ack 뒤 결과가 안 보인다 · CTA 가 화면 밖) 아무도
 * 모른다 — 특히 `p456-result-cta` 는 **결과 화면으로 직행**하므로 그 앞의 오버레이 두 겹을
 * **원리적으로** 지나지 않는다(`p405` 가 `GEN2`/브릿지를 안 덮는 것과 같은 구조적 사각).
 *
 * 여기서 처음 걸리는 이음매 넷:
 *  ⓐ 브릿지 CTA → **보상 오버레이가 같은 층에서 열린다**(라우트 무신설 · C3)
 *  ⓑ 선수 카드를 **실제로 통과**한 뒤 오버레이가 닫힌다 — 한 명은 `[이 스탯 선택]`, 한 명은
 *     `[다음에]`. 두 갈래를 **한 흐름 안에서** 섞어야 "적용이 다음 장을 삼키지 않는다"가 걸린다.
 *  ⓒ 오버레이가 닫히면 **#405 시트가 봉투를 회수**하고, 그 `[확인]`(ack) 뒤에 **결과 화면**이 선다
 *  ⓓ 결과 화면의 **모드별 CTA 가 화면 안에 있고 눌리며, 실제로 다음 행동으로 간다**
 *
 * ## ⚠️ 상태를 갈아끼워 단계를 건너뛰지 않는다
 *
 * `p424` 의 구멍이 그것이었다 — `h.state` 를 대입하고 "카드가 뜬다"만 봤다. 여기서 서버 상태를
 * 바꾸는 것은 **경기가 끝났다는 서버 이벤트 한 번뿐**이고(그건 유저가 만드는 것이 아니다),
 * 그 뒤 모든 단계는 **실제 클릭**이다. 그 규율을 사람이 지키는 것이 아니라 **하니스가 강제한다** —
 * `finish()` 는 두 번 부르면 던지고, 각 여정 끝에서 `h.finishes === 1` 을 단언한다.
 *
 * ## ⚠️ `GEN2` 에서 시작하는 이유
 *
 * 캔버스를 띄우지 않아 `packages/engine/dev-viewer/match-log.json` 신선도(**#464**)에 의존하지
 * 않는다. `GEN2 → FINISHED` 는 지어낸 경로가 아니라 **시계 롤백 실경로**이고 `p424` ⑧ 이 그
 * 전이를 계약으로 갖고 있다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로(glob `**\/api\/**` 는 vite 소스까지 잡아 흰 화면).
 */

const MATCH_ID = "m-p456j";
const NEXT_ID = "m-p456j-next";
const PHONE = { width: 390, height: 844 };

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** 이 경기가 레벨업시킨 두 선수 — 한 명은 고르고 한 명은 미룬다(ⓑ). */
const PLAYERS = [
  { playerId: "P001", name: "김수비", level: 4 },
  { playerId: "P002", name: "박미드", level: 7 },
];

/**
 * 후보 3장 — **gain 내림차순이 아니다**(서버는 `positionBaseline × gain` 으로 정렬한다).
 * 재정렬 변이는 이 픽스처에서 죽는다: `pace` 가 gain 최대인데 마지막이다.
 */
const CANDIDATES = [
  { stat: "tackling", gain: 2.1, core: true },
  { stat: "physical", gain: 1.4, core: true },
  { stat: "pace", gain: 3.6, core: false },
];

const choiceIdOf = (playerId: string) => `ch-${playerId}`;

interface Harness {
  mode: "practice" | "league" | "away";
  /** 서버가 말하는 매치 상태. **`finish()` 로만 바뀐다.** */
  state: string;
  /** `finish()` 호출 횟수 — 여정 끝에서 **1** 이어야 한다(단계 건너뛰기 금지의 집행). */
  finishes: number;
  finish: () => void;
  /** 정산 후 레이팅(`/api/me`) — 원정 카드의 값. */
  ratingAfter: number;
  /** 이미 고른 선택권 id — `GET /api/growth/choices` 에서 빠진다. */
  chosen: string[];
  /** ack 된 봉투 경로 — 시트 `[확인]` 이 실제로 쳤는지 본다. */
  acked: string[];
  /** `POST /api/league/next-match` 호출 수. */
  nextCalls: number;
  /** `POST /api/away/*` 호출 수 — **0 이어야 한다**(원정 CTA 는 이동만 한다, #245 E2). */
  awayPosts: number;
}

function makeHarness(mode: Harness["mode"]): Harness {
  const h: Harness = {
    mode,
    state: "GEN2",
    finishes: 0,
    finish: () => {
      /*
       * ⚠️ **두 번째 호출은 던진다.** 단계를 건너뛰려면 상태를 한 번 더 갈아끼워야 하는데,
       * 그 순간 테스트가 죽는다 = "클릭으로 걸었다"가 사람의 약속이 아니라 기계 검사가 된다.
       */
      if (h.finishes > 0) throw new Error("상태를 두 번 갈아끼웠다 — 단계를 클릭으로 걸어라");
      h.finishes += 1;
      h.state = "FINISHED";
    },
    ratingAfter: 1102,
    chosen: [],
    acked: [],
    nextCalls: 0,
    awayPosts: 0,
  };
  return h;
}

function detailOf(h: Harness, id = MATCH_ID) {
  const finished = h.state === "FINISHED";
  return {
    id,
    state: h.state,
    mode: h.mode,
    scoreHome: finished ? 2 : null,
    scoreAway: finished ? 1 : null,
    result: finished ? "WIN" : null,
    auto: false,
    clock: null,
    createdAt: "2026-08-06T09:00:00Z",
    opponent: { name: "붉은늑대 FC" },
  };
}

const pendingChoiceOf = (p: (typeof PLAYERS)[number]) => ({
  choiceId: choiceIdOf(p.playerId),
  playerId: p.playerId,
  level: p.level,
  candidates: CANDIDATES,
});

/** 봉투 `GROWTH` 섹션 = `GET /api/growth/report` 와 **같은 자료**(서버가 한 함수로 만든다). */
const growthEntries = () =>
  PLAYERS.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    position: "DF",
    grade: "GOLD",
    xpGained: 120,
    levelBefore: p.level,
    levelAfter: p.level + 1,
    cardXp: 10,
    xpToNext: 200,
    minutes: "starter",
    pendingChoices: [pendingChoiceOf(p)],
  }));

function cardEffectiveOf(playerId: string) {
  const attrs = {
    pace: 44, shooting: 40, passing: 41, technical: 42,
    tackling: 44, positioning: 43, physical: 45, stamina: 46, mental: 47,
  };
  return {
    playerId,
    grade: "GOLD",
    star: 2,
    attributes: attrs,
    prePotential: attrs,
    base: attrs,
    caps: Object.fromEntries(Object.keys(attrs).map((k) => [k, 73])),
    statLevels: {},
    startLo: 32,
    potential: { unlocked: true, tier: "RARE", maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 5 },
    ovr: 44,
    completion: 0.2,
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
          rating: h.ratingAfter,
        }),
      );
    }
    if (url.pathname === "/api/deck") return route.fulfill(json({ formation: "4-3-3", slots: [] }));
    if (url.pathname === "/api/league/next-match" && req.method() === "POST") {
      h.nextCalls += 1;
      return route.fulfill(json({ match: { ...detailOf(h, NEXT_ID), state: "BRIEFING" }, fixture: { round: 7 } }));
    }
    // 원정 CTA 는 **이동만** 한다 — 제시 갱신(POST)이 한 번이라도 가면 계약이 죽는다(#245 E2).
    if (url.pathname.startsWith("/api/away/") && req.method() === "POST") {
      h.awayPosts += 1;
      return route.fulfill(json({}));
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill(json(detailOf(h)));
    if (url.pathname === `/api/matches/${NEXT_ID}`) {
      return route.fulfill(json({ ...detailOf(h, NEXT_ID), state: "BRIEFING" }));
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill(
        json({
          matchId: MATCH_ID,
          result: "WIN",
          scoreHome: 2,
          scoreAway: 1,
          pointsAwarded: 1200,
          // 서버는 **리그 매치에만** 오늘의 보상 칸을 싣는다(#368).
          ...(h.mode === "league"
            ? { dailyReward: { slotNo: 3, currency: "GEM", amount: 30, result: "WIN", awarded: true } }
            : {}),
          rewardBundle: {
            bundleId: "b-p456j",
            source: "MATCH",
            sourceRef: MATCH_ID,
            acknowledgedAt: null,
            sections: [
              { kind: "CURRENCY", entries: [{ code: "POINT", amount: 1200 }] },
              { kind: "GROWTH", entries: growthEntries() },
            ],
          },
        }),
      );
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill(json({ events: [] }));
    if (url.pathname === "/api/growth/choices") {
      return route.fulfill(
        json({ choices: PLAYERS.filter((p) => !h.chosen.includes(choiceIdOf(p.playerId))).map(pendingChoiceOf) }),
      );
    }
    if (url.pathname.startsWith("/api/growth/card/")) {
      return route.fulfill(json(cardEffectiveOf(url.pathname.split("/").pop()!)));
    }
    if (req.method() === "POST" && /^\/api\/growth\/choices\/[^/]+$/.test(url.pathname)) {
      const choiceId = url.pathname.split("/").pop()!;
      const src = PLAYERS.find((p) => choiceIdOf(p.playerId) === choiceId);
      h.chosen.push(choiceId);
      const stat = (req.postDataJSON() as { stat: string }).stat;
      return route.fulfill(
        json({
          choiceId,
          playerId: src?.playerId ?? "",
          level: src?.level ?? 1,
          stat,
          gain: CANDIDATES.find((c) => c.stat === stat)?.gain ?? 0,
          card: cardEffectiveOf(src?.playerId ?? ""),
        }),
      );
    }
    if (/^\/api\/rewards\/[^/]+\/ack$/.test(url.pathname)) {
      h.acked.push(url.pathname);
      return route.fulfill(json({}));
    }
    if (url.pathname === "/api/players") return route.fulfill(json([]));
    if (url.pathname === "/api/me/active-match") {
      const live = h.state !== "FINISHED";
      return route.fulfill(json({ match: live ? detailOf(h) : null, locked: live, abandonable: false }));
    }
    return route.fulfill(json({}));
  });
  await mockAppConfig(page);
}

/** 경기가 **아직 진행 중**인 화면에서 시작한다 — 여기가 여정의 0 지점이다. */
async function startInProgress(page: Page, mode: Harness["mode"]): Promise<Harness> {
  const h = makeHarness(mode);
  await mockApi(page, h);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("genwait-panel")).toBeVisible({ timeout: 20_000 });
  // 아직 아무 층도 안 떠 있다(뒤 단계가 "원래 떠 있던 것"을 세지 않게).
  await expect(page.getByTestId("flow-bridge")).toHaveCount(0);
  await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
  await expect(page.getByTestId("reward-sheet")).toHaveCount(0);
  return h;
}

/** 보임(visible)과 눌림(hit)은 다르다 — 겹친 층이 덮지 않는지 좌표로 잰다(표 #3). */
async function hitTestId(page: Page, target: Locator): Promise<string | null> {
  const box = await target.boundingBox();
  expect(box, "대상이 레이아웃에 존재해야 한다").not.toBeNull();
  return page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return el ? (el.getAttribute("data-testid") ?? el.tagName) : null;
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2],
  );
}

/** 그 요소가 **화면 안에 통째로** 있고 자기 중심을 자기가 받나. `toBeVisible()` 로는 못 잰다(표 #3). */
async function geometryOf(page: Page, testId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      vh: window.innerHeight,
      inViewport: r.top >= -1 && r.bottom <= window.innerHeight + 1,
      hitSelf: !!hit && (hit === el || el.contains(hit)),
    };
  }, testId);
}

/**
 * ── 여정의 공통 구간 ─────────────────────────────────────────────────────────────────────
 * 종료 이벤트 → 브릿지 → 보상 카드(골드 → 모드별 → 선수 2명) → 시트 ack → 결과 화면.
 * **모드가 가르는 것은 두 번째 카드뿐**이므로 그 한 장만 콜백으로 받는다.
 */
async function walkToResult(page: Page, h: Harness, modeCard: (() => Promise<void>) | null) {
  // ① 서버가 "끝났다"고 말한다 — 이 여정에서 **상태를 바꾸는 유일한 지점**이다.
  h.finish();

  // ② 브릿지. CTA 라벨은 `matchEndContinuation` 유무의 파생이고, 시안(`424-bridge/index.html:330`)
  //    이 `보상 받기` 다 — B4 시안 정합이 배선으로 해소됐다는 주장을 여기서 매 실행 확인한다.
  const bridgeCta = page.getByTestId("flow-bridge-next");
  await expect(page.getByTestId("flow-bridge")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("flow-bridge-title")).toHaveText("경기 종료");
  await expect(bridgeCta).toHaveText("보상 받기");
  expect(await hitTestId(page, bridgeCta), "브릿지 CTA 를 덮는 층이 있다").toBe("flow-bridge-next");
  await bridgeCta.click();

  // ⓐ 라우트가 아니라 **같은 오버레이 안**에서 보상 층이 열린다(C3).
  await expect(page.getByTestId("flow-continuation")).toBeVisible();
  expect(await page.locator('[role="dialog"]').count(), "한 순간에 다이얼로그는 하나다").toBe(1);

  const card = page.getByTestId("match-reward-card");
  await expect(card).toHaveAttribute("data-card", "currency");
  await expect(page.getByTestId("match-reward-currency-POINT")).toHaveAttribute("data-amount", "1200");
  await page.getByTestId("match-reward-next").click();

  if (modeCard) await modeCard();

  // ⓑ 선수 카드 둘 — **두 갈래를 한 흐름 안에서 섞는다**.
  await expect(card).toHaveAttribute("data-kind", "choice");
  await expect(card).toHaveAttribute("data-player", "P001");
  await expect(card).toContainText("김수비");
  // 후보 순서는 응답 그대로다(gain 최대 `pace` 가 꼴찌인 픽스처 = 재정렬이 여기서 죽는다).
  expect(
    await page
      .getByTestId("choice-candidates")
      .locator("button")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid"))),
  ).toEqual(["choice-cand-tackling", "choice-cand-physical", "choice-cand-pace"]);

  // 한 명은 **고른다**.
  await page.getByTestId("choice-cand-pace").click();
  await expect(page.getByTestId("choice-celebration")).toBeVisible();
  await expect(page.getByTestId("choice-applied")).toHaveAttribute("data-stat", "pace");
  expect(h.chosen).toEqual(["ch-P001"]);
  await expect(page.getByTestId("match-reward-choice-later")).toHaveText("다음");
  await page.getByTestId("match-reward-choice-later").click();

  // 다른 한 명은 **미룬다** — 적용이 다음 장을 삼키지 않았다는 증거이기도 하다.
  await expect(card).toHaveAttribute("data-player", "P002");
  await expect(card).toContainText("박미드");
  await expect(page.getByTestId("match-reward-choice-later")).toHaveText("다음에");
  await page.getByTestId("match-reward-choice-later").click();

  // ⓒ 오버레이가 비키면 시트가 봉투를 회수하고, 그 `[확인]` 이 ack 를 친다.
  await expect(page.getByTestId("flow-continuation")).toHaveCount(0);
  await expect(page.getByTestId("reward-sheet")).toBeVisible();
  expect(h.acked, "보상 카드가 봉투를 대신 확인해 주면 안 된다").toEqual([]);
  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("reward-sheet")).toHaveCount(0);
  expect(h.acked).toHaveLength(1);
  // 미룬 선택권은 **서버에 그대로 남는다**(전체 건너뛰기와 같은 성질).
  expect(h.chosen).toEqual(["ch-P001"]);

  await expect(page.getByTestId("result-page")).toBeVisible();
  // 단계를 건너뛰지 않았다 = 상태 조작 1회.
  expect(h.finishes, "서버 상태를 두 번 이상 갈아끼웠다").toBe(1);
}

test.use({ viewport: PHONE });

test.describe("#456 S4 · AC5 — 경기 종료부터 다음 행동까지 한 번에", () => {
  test("전제 — 폰 세로에서 돈다(뷰포트를 안 걸면 조용히 데스크탑으로 돈다)", async ({ page }) => {
    expect(page.viewportSize()).toEqual(PHONE);
  });

  test("A. 리그 — 종료 → 브릿지 → 골드 → 오늘의 보상 칸 → 선수 2명 → 결과 → [다음 경기 시작]", async ({ page }) => {
    const h = await startInProgress(page, "league");
    await walkToResult(page, h, async () => {
      const card = page.getByTestId("match-reward-card");
      await expect(card).toHaveAttribute("data-card", "daily");
      // 금액은 서버 값을 옮기기만 한다(#232) — economy `league.dailyReward.small`.
      const gem = page.getByTestId("match-reward-daily-amount");
      await expect(gem).toHaveAttribute("data-amount", "30");
      await expect(gem).toHaveAttribute("data-currency", "GEM");
      await page.getByTestId("match-reward-next").click();
    });

    // ⓓ 모드별 CTA — **화면 안에 있고 자기 중심을 자기가 받는다**(`toBeVisible()` 로는 못 잰다).
    const cta = page.getByTestId("result-next-cta");
    await expect(cta).toHaveText("다음 경기 시작");
    const geo = await geometryOf(page, "result-next-cta");
    expect(geo!.inViewport, `CTA 가 화면 밖 — bottom ${geo!.bottom} > ${geo!.vh}`).toBe(true);
    expect(geo!.hitSelf, "CTA 중심을 다른 것이 받는다").toBe(true);
    // [로비로]도 남는다(다음 경기 CTA 는 실패하는 갈래가 실재한다).
    expect((await geometryOf(page, "to-lobby"))!.inViewport).toBe(true);

    // 그리고 실제로 **다음 행동으로 간다**.
    await cta.click();
    await page.waitForURL(`**/match/${NEXT_ID}`, { timeout: 15_000 });
    expect(h.nextCalls).toBe(1);
  });

  test("B. 원정 — 종료 → 브릿지 → 골드 → 레이팅 → 선수 2명 → 결과 → [다음 원정 떠나기]", async ({ page }) => {
    const h = await startInProgress(page, "away");
    await walkToResult(page, h, async () => {
      const card = page.getByTestId("match-reward-card");
      await expect(card).toHaveAttribute("data-card", "rating");
      // 정산 후 값이다 — `MatchPage` 의 `FINISHED` 최초 관측이 `["me"]` 를 무효화한 결과.
      await expect(page.getByTestId("match-reward-rating-value")).toHaveText("1102");
      await page.getByTestId("match-reward-next").click();
    });

    const cta = page.getByTestId("result-next-cta");
    await expect(cta).toHaveText("다음 원정 떠나기");
    const geo = await geometryOf(page, "result-next-cta");
    expect(geo!.inViewport, `CTA 가 화면 밖 — bottom ${geo!.bottom} > ${geo!.vh}`).toBe(true);
    expect(geo!.hitSelf, "CTA 중심을 다른 것이 받는다").toBe(true);

    await cta.click();
    await page.waitForURL("**/away", { timeout: 15_000 });
    /*
     * ⚠️ 원정은 **이동만** 한다 — 여기서 상대 제시를 새로 받으면 유저가 앞서 받아 둔 후보 목록이
     * 조용히 무효가 된다(제시는 유저당 1개, #245 hero E2).
     */
    expect(h.awayPosts, "원정 CTA 가 제시를 갱신했다").toBe(0);
  });

  test("C. 연습 — 종료 → 브릿지 → 골드 → 선수 2명 → 결과 → [로비로] 하나뿐", async ({ page }) => {
    // 모드별 카드가 **없는** 것이 정상이다(추측하지 않는다) → 골드 다음이 곧 선수 카드다.
    const h = await startInProgress(page, "practice");
    await walkToResult(page, h, null);

    await expect(page.getByTestId("result-next-cta")).toHaveCount(0);
    const geo = await geometryOf(page, "to-lobby");
    expect(geo!.inViewport, `[로비로]가 화면 밖 — bottom ${geo!.bottom} > ${geo!.vh}`).toBe(true);
    expect(geo!.hitSelf, "[로비로] 중심을 다른 것이 받는다").toBe(true);

    await page.getByTestId("to-lobby").click();
    await page.waitForURL("**/home", { timeout: 15_000 });
  });

  test("D. 단계 건너뛰기 금지 장치가 실제로 문다(하니스 자기검사)", async ({ page }) => {
    /*
     * ⚠️ **이 테스트가 없으면 `finishes === 1` 은 장식이다.** 위 세 여정이 초록인 이유가
     * "정말 한 번만 갈아끼웠기 때문"인지, 아니면 그 가드가 애초에 아무것도 안 하기 때문인지
     * 구분할 방법이 있어야 한다(표 #6 과 같은 축 — 앵커 없는 음성 단언은 공허하다).
     */
    const h = await startInProgress(page, "practice");
    h.finish();
    expect(h.finishes).toBe(1);
    expect(() => h.finish()).toThrow(/두 번/);
    expect(h.finishes, "던진 호출이 카운터를 올리면 안 된다").toBe(1);
  });
});
