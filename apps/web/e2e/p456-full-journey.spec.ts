import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * #456 S4 · B3 **AC5 — 전 구간 E2E**.
 *
 * ## 이 스펙이 처음으로 덮는 것 (조각 계약과의 차이)
 *
 * S4 가 만든 계약은 전부 **한 층씩**이다:
 *  · `p424` = 브릿지가 뜨는가(⑥) + **CTA → 카드 → 시트까지**(⑨ `:411-418`)
 *  · `p456-match-reward` = **보상 오버레이 안**(브릿지 CTA 클릭으로 시작해 오버레이가 닫히면 끝)
 *  · `p456-result-cta` = **결과 화면에 착지한 상태에서 시작**(`state: "FINISHED"` 로 goto)
 *
 * 그래서 **경기 종료부터 다음 행동까지 한 사람이 끊기지 않고 걷는** 계약이 없었다. 세 조각이 각자
 * 초록이어도 이음매가 끊기면 아무도 모른다 — 특히 `p456-result-cta` 는 **결과 화면으로 직행**하므로
 * 그 앞의 오버레이 두 겹을 **원리적으로** 지나지 않는다(`p405` 가 `GEN2`/브릿지를 안 덮는 것과 같은
 * 구조적 사각).
 *
 * ## ⚠️ 이 스펙이 **새로 잡는다고 실증된 것은 하나**다 — 나머지는 "잇는 것"이다
 *
 * 초판 헤더는 *"여기서 처음 걸리는 이음매 **넷**"* 이라고 적었고 **그건 측정 범위를 4배로 부풀린
 * 거짓이다**(AC5 스켑틱 패널 ③ B-1). 정직한 구분:
 *
 * | | 무엇 | 조각이 이미 잡나 |
 * |---|---|---|
 * | ⓐ | 브릿지 CTA → 보상 오버레이가 **같은 층**에서 열린다(C3) | **잡는다** — `p456-match-reward` a(`:313-322`) · `p424` ⑨(`:411-418`) |
 * | ⓑ | 선수 카드 두 갈래(`[이 스탯 선택]` + `[다음에]`)를 **한 흐름에서** 통과 | 조각은 갈래를 **따로** 잰다(`p456` k·l) — 섞는 것은 여기뿐 |
 * | ⓒ | 오버레이 닫힘 → 시트가 봉투 회수 → `[확인]`(ack) → 결과 화면 | 부분적(`p405` a 가 시트→결과, `p456` h 가 오버레이→시트) |
 * | ⓓ | 결과 화면 모드별 CTA 가 화면 안 · 눌림 · 다음 행동 | **거의 잡는다** — `p456-result-cta`(`:140-175`)가 좌표+클릭+`nextCalls===1`. 여기가 더한 것은 `elementFromPoint` 자기 히트 한 축 |
 *
 * **조각이 못 잡는다고 실행으로 실증된 것은 `MUT-J1` 하나다** — `ResultPanel.nextCtaLabel` 을
 * `hasRewardSheet` 로 잠그면 이 스펙만 죽고(2 failed) `p456-result-cta` 9 · `p456-match-reward` 21 ·
 * `p348` 103 · `p405` 18 = **151건이 전부 green** 이다. 이유는 구조적이다: `p456-result-cta` 의 목은
 * `rewardBundle` 이 **없어서** `hasRewardSheet === true` 상태에 도달할 수 없다.
 *
 * ⚠️ **그러니 "조각이 중복이니 걷어내도 된다"로 읽지 마라.** 위 표에서 "잡는다"인 칸의 근거는
 * **그 조각들**이고, 이 스펙은 그것을 대체하지 않는다.
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
            /*
             * ⚠️ **ack 을 목이 반영해야 한다.** `useAckReward` 가 `["matchResult"]` 를 무효화하고
             * 그 응답의 `acknowledgedAt` 이 곧 "다시 띄울까"의 판정이다(`shouldShowRewardSheet`).
             * 계속 `null` 을 주면 회수 문으로 다시 연 시트가 **미확인 봉투로 보여** 계약이
             * 서버가 하지 않는 일을 단언하게 된다(#342 가 admin 에서 당한 형태).
             */
            acknowledgedAt: h.acked.length > 0 ? "2026-08-06T09:30:00Z" : null,
            sections: [
              { kind: "CURRENCY", entries: [{ code: "POINT", amount: 1200 }] },
              { kind: "GROWTH", entries: growthEntries() },
            ],
          },
        }),
      );
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill(json({ events: [] }));
    /*
     * ⚠️ **이걸 캐치올 `{}` 로 두면 결과 화면에 성장 리포트가 구조적으로 없다**(AC5 스켑틱 ② minor-1).
     * `GrowthReportSection` 은 `entries.length === 0` 이면 `null` 을 돌려주므로, 여정이 P002 를
     * `[다음에]` 로 **미뤄 놓고 그 미룬 선택의 회수 경로를 한 번도 안 보는** 상태가 된다 —
     * 제품 결함이 아니라 **계약 사각**이었다. 부수로 결과 패널 세로 예산도 실물에 가까워진다
     * (오버플로 124px → 프로덕션형 1037px).
     */
    if (url.pathname.startsWith("/api/growth/report/")) {
      return route.fulfill(json({ matchId: MATCH_ID, entries: growthEntries() }));
    }
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

/**
 * **움직이는 동안 좌표를 재지 마라** (AC5 스켑틱 ① R3).
 *
 * 브릿지 카드는 `bridgeIn 280ms` 로 들어온다(#456 B2). 히트테스트 시점에 그 애니메이션이 아직
 * **running** 이었다(스켑틱 ① 실측 `currentTime` 233~266ms). 깨지면 메시지가 *"CTA 를 덮는 층이
 * 있다"* 라 **원인을 잘못 지목**하므로 명시적으로 기다린다 — 모듈 CLAUDE.md 의 "화면이 움직이는
 * 동안 좌표를 재지 마라"(#318)와 같은 축.
 *
 * ⚠️ **그런데 이 대기가 일하는 것을 변이로 증명하지 못했다 — 정직하게 적는다.** 대기를 지운 채
 * 모션을 **21배(280ms → 5s)** 로 늘려도, **43배(translateY 14px → 600px)** 로 키워도 두 팔 모두
 * **green** 이다. 이유는 우연이 아니라 구조로 보인다: `boundingBox()` 가 **자체 안정화 대기**를
 * 갖고 있어(연속 프레임에서 박스가 같아질 때까지) 이미 정착된 좌표를 돌려준다. 즉 스켑틱이
 * 지목한 *"움직이는 중에 잰다"* 는 `getAnimations()` 상태로는 참이지만 **측정값은 이미 안정**이다.
 * ⇒ 이 한 줄은 **중복 방어**다. 남기는 이유는 하나뿐이다 — 누가 `boundingBox()` 를
 * `evaluate` 기반 좌표로 바꾸면 그 암묵적 보증이 사라지고, 그때 이 줄이 유일한 방어가 된다.
 * **"이게 없으면 깨진다"고 주장하지 마라.**
 */
async function waitForAnimations(page: Page, testId: string) {
  await page
    .locator(`[data-testid="${testId}"]`)
    .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));
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
  // 등장 모션이 끝난 뒤에 좌표를 잰다(위 `waitForAnimations` — 재는 동안 카드가 움직이면 안 된다).
  await waitForAnimations(page, "flow-bridge-card");
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
  // ORDER-ASSERT — 후보 순서는 서버 응답 그대로(재정렬 금지). 자리 수를 세려면 이 마커를 grep 해라.
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

  /*
   * ⓔ **미룬 선택의 회수 문이 결과 화면에 서 있다** (minor-1).
   * 여정은 P002 를 `[다음에]` 로 미뤘다 — 그 선택권이 어디로 갔는지 유저가 볼 수 있어야 흐름이
   * 완결된다. `p405 a` 가 같은 문을 재지만 **보상 오버레이를 지나온 상태에서는** 아무도 안 봤다.
   * ⚠️ 숫자가 `1` 인 것이 이 단언의 핵심이다: 고른 P001 은 빠지고 미룬 P002 만 남는다 =
   * 권위 조회(`GET /api/growth/choices`)와 봉투 스냅샷의 교차가 **여기까지 살아 있다**(BL-1 축).
   */
  const recovery = page.getByTestId("growth-open-rewards");
  await recovery.scrollIntoViewIfNeeded();
  await expect(recovery).toContainText("선택 대기 1");
  await recovery.click();
  await expect(page.getByTestId("reward-sheet")).toBeVisible();
  // 다시 연 시트는 **이미 확인된 봉투**다 — ack 를 또 치지 않는다(위에서 1회만 쳤다).
  await expect(page.getByTestId("reward-sheet")).toHaveAttribute("data-acknowledged", "1");
  expect(h.acked).toHaveLength(1);
  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("reward-sheet")).toHaveCount(0);
  await expect(page.getByTestId("result-page")).toBeVisible();
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

    /*
     * 그리고 실제로 **다음 행동으로 간다** — 폰에서 유저가 실제로 하는 동작은 **더블탭**이다.
     *
     * ⚠️ `disabled={isPending}` 은 **같은 이벤트 버스트의 두 번째를 못 막는다**(실측 `nextCalls 2`).
     * 서버가 막아 주긴 한다(`LeagueService.nextMatch` 가 트랜잭션 안에서 진행 중 매치를 재사용하고,
     * 아니면 409 → 클라가 `matchInProgressIdOf` 로 같은 매치로 보낸다) — **중복 매치는 안 생긴다**.
     * 그래도 클라에서 한 번만 보내는 게 맞다(잃는 것이 없다, AC5 스켑틱 ② minor-2).
     */
    /*
     * ⚠️ **두 클릭이 같은 JS 태스크에서 나가야 한다.** Playwright 왕복으로 두 번 누르면 그 사이에
     * React 가 리렌더해 `disabled` 가 걸려 **통과해 버린다**(그 형태로는 결함이 재현되지 않는다).
     * 실제 더블탭은 한 버스트라 `evaluate` 안에서 동기로 두 번 친다.
     */
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="result-next-cta"]') as HTMLElement;
      el.click();
      el.click();
    });
    await page.waitForURL(`**/match/${NEXT_ID}`, { timeout: 15_000 });
    expect(h.nextCalls, "더블탭이 서버를 두 번 쳤다").toBe(1);
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
