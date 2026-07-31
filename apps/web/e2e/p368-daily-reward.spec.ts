import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { appConfigPayload, mockAppConfig } from "./app-config-mock";

/**
 * #368 오늘의 보상 트랙 — **백엔드 없이** vite dev + `page.route` 전면 목킹.
 *
 * 박제하는 계약:
 *  (1) 트랙이 그려진다 — 칸 상태(수령/소멸/다음) · 대량 칸 · **상대팀 마크가 칸 아래** · 헤더의 "n회 받음"
 *  (2) **규칙은 서버 값을 따라간다** — 응답의 `big`/금액/`next` 를 바꾸면 화면이 따라 움직인다
 *      (클라가 "9·18이 대박"을 기억하고 있으면 안 된다 — #262 BL-1 과 같은 부류)
 *  (3) **소진** — `next: null` 이면 "오늘 완료" + 다음 칸 안내가 사라진다
 *  (4) **구 서버 폴백** — `dailyReward` 가 없으면 트랙 구역이 통째로 사라지고 기존 화면은 그대로
 *  (5) 결과 화면 — 수령 / **소멸** / 소진 후 세 경우가 각각 다른 말을 한다
 *
 * ⚠️ 표기는 목의 `/api/config` 를 따른다(#232) — 심볼을 단언하지 않고 **서버 값이 화면에 오는지**만 본다.
 * ⚠️ 라우트는 **pathname** 으로 잡는다(glob 을 오리진 없이 쓰면 vite 에셋까지 걸려 흰 화면).
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const TEAM_IDS = ["USER", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"];

interface SlotSpec {
  slotNo: number;
  amount: number;
  big: boolean;
  state: "WON" | "MISSED" | "PENDING";
  opponentName?: string | null;
}

/** 기본 트랙: 6칸(3·6 대량) · 1승 1패 소비 · 다음은 3번(대량). 발행값 18칸과 **일부러 다르게** 둔다. */
function defaultSlots(): SlotSpec[] {
  return [
    { slotNo: 1, amount: 30, big: false, state: "WON", opponentName: "Ironclad FC" },
    { slotNo: 2, amount: 30, big: false, state: "MISSED", opponentName: "Shadow Wolves" },
    { slotNo: 3, amount: 300, big: true, state: "PENDING", opponentName: "Azure Sentinels" },
    { slotNo: 4, amount: 30, big: false, state: "PENDING", opponentName: "Crimson Vanguard" },
    { slotNo: 5, amount: 30, big: false, state: "PENDING", opponentName: null },
    { slotNo: 6, amount: 300, big: true, state: "PENDING", opponentName: null },
  ];
}

interface TrackOpts {
  slots?: SlotSpec[];
  nextSlotNo?: number | null;
  awardedCount?: number;
  earned?: number;
  currency?: string;
  /** true 면 `dailyReward` 필드 자체를 빼서 **구 서버**를 재현한다. */
  legacyServer?: boolean;
}

function trackPayload(o: TrackOpts = {}) {
  const slots = (o.slots ?? defaultSlots()).map((s) => ({
    slotNo: s.slotNo,
    currency: o.currency ?? "GEM",
    amount: s.amount,
    big: s.big,
    state: s.state,
    opponentName: s.opponentName ?? null,
  }));
  const nextNo = o.nextSlotNo === undefined ? 3 : o.nextSlotNo;
  return {
    day: "2026-07-31",
    slotsPerDay: slots.length,
    consumed: slots.filter((s) => s.state !== "PENDING").length,
    awardedCount: o.awardedCount ?? slots.filter((s) => s.state === "WON").length,
    earned: o.earned ?? 30,
    currency: o.currency ?? "GEM",
    slots,
    next: nextNo == null ? null : slots.find((s) => s.slotNo === nextNo) ?? null,
  };
}

function seasonPayload() {
  return {
    id: "SEASON1",
    seasonNo: 4,
    state: "ACTIVE",
    teams: TEAM_IDS.map((t) => ({ teamId: t, name: t === "USER" ? "내 팀" : `봇 ${t}`, isUser: t === "USER" })),
    standings: TEAM_IDS.map((t, i) => ({
      teamId: t, name: t === "USER" ? "내 팀" : `봇 ${t}`,
      played: 2, won: 2 - i > 0 ? 2 - i : 0, drawn: 0, lost: i,
      goalsFor: 5, goalsAgainst: 3, goalDiff: 2, points: 6 - i > 0 ? 6 - i : 0,
      rank: i + 1, isUser: t === "USER",
    })),
    fixtures: [],
    nextUserFixture: { id: "F1", round: 3, homeTeam: "USER", awayTeam: "T2", isUser: true, state: "SCHEDULED" },
    division: 8,
    divisionName: "브론즈 리그",
    promoteRankMax: 2,
    relegateRankMin: 9,
  };
}

async function bootstrapLeague(page: Page, o: TrackOpts = {}) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page, appConfigPayload());
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: { id: "U1", nickname: "테스터", isAdmin: false, tutorialDone: true },
        wallet: { points: 10000, gems: 100 },
        records: { wins: 0, draws: 0, losses: 0 },
        rating: 0,
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/league", (route) =>
    route.fulfill(
      json(o.legacyServer
        ? { season: seasonPayload() }
        : { season: seasonPayload(), dailyReward: trackPayload(o) }),
    ),
  );
  await page.goto("/league");
}

// ── (1) 트랙이 그려진다 ──────────────────────────────────────────────────

test.describe("#368 트랙 렌더", () => {
  test("칸 상태 · 대량 칸 · 상대 마크 · 오늘 받은 횟수", async ({ page }) => {
    await bootstrapLeague(page);

    const rail = page.getByTestId("daily-reward-rail");
    await expect(rail).toBeVisible();
    await expect(rail.locator("[data-slot]")).toHaveCount(6);

    // 상태 — 수령/소멸/다음이 각각 다르게 표시된다.
    await expect(rail.locator('[data-slot="1"]')).toHaveAttribute("data-state", "WON");
    await expect(rail.locator('[data-slot="2"]')).toHaveAttribute("data-state", "MISSED");
    await expect(rail.locator('[data-slot="3"]')).toHaveAttribute("data-next", "1");
    await expect(rail.locator('[data-slot="4"]')).toHaveAttribute("data-next", "0");

    // 대량 칸은 서버가 말한 자리(3·6)에만.
    await expect(rail.locator('[data-slot="3"]')).toHaveAttribute("data-big", "1");
    await expect(rail.locator('[data-slot="6"]')).toHaveAttribute("data-big", "1");
    await expect(rail.locator('[data-slot="1"]')).toHaveAttribute("data-big", "0");

    // hero 채택 시안 A 의 핵심 — **상대팀 마크가 칸 아래에** 있다.
    const crest = rail.locator('[data-slot="1"] [data-testid="team-crest"]');
    await expect(crest).toHaveAttribute("data-team", "Ironclad FC");
    const rewardBox = await rail.locator('[data-slot="1"] [data-currency]').first().boundingBox();
    const crestBox = await crest.boundingBox();
    expect(crestBox!.y).toBeGreaterThan(rewardBox!.y);

    // 상대가 없는 칸(잔여 일정 밖)은 마크를 안 그린다 — 물음표를 띄우면 "못 읽었다"로 보인다.
    await expect(rail.locator('[data-slot="5"] [data-testid="team-crest"]')).toHaveCount(0);

    // 헤더 요약 = 오늘 받은 **횟수**(hero 요구).
    await expect(page.getByTestId("daily-reward-count")).toContainText("1회");
    await expect(page.getByTestId("daily-reward-progress")).toHaveText("2 / 6");

    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}p368-track-active.png`, fullPage: true });
  });

  test("18칸이어도 리그 화면이 가로로 넘치지 않는다 — 레일 안에서만 스크롤한다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const slots: SlotSpec[] = Array.from({ length: 18 }, (_, i) => ({
      slotNo: i + 1,
      amount: [9, 18].includes(i + 1) ? 300 : 30,
      big: [9, 18].includes(i + 1),
      state: i < 7 ? (i % 3 === 2 ? "MISSED" : "WON") : "PENDING",
      opponentName: `봇 ${i + 1}`,
    }));
    await bootstrapLeague(page, { slots, nextSlotNo: 8 });

    await expect(page.getByTestId("daily-reward-rail").locator("[data-slot]")).toHaveCount(18);
    // 문서가 가로로 밀리면 리그 화면 전체가 흔들린다(#284 가 겪은 부류).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // 다음 칸이 화면 안으로 들어와 있어야 한다 — 18칸이라 기본 위치에서는 밖이다.
    const rail = page.getByTestId("daily-reward-rail");
    const railBox = (await rail.boundingBox())!;
    const nextBox = (await rail.locator('[data-slot="8"]').boundingBox())!;
    expect(nextBox.x).toBeGreaterThanOrEqual(railBox.x - 1);
    expect(nextBox.x + nextBox.width).toBeLessThanOrEqual(railBox.x + railBox.width + 1);

    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}p368-track-18.png`, fullPage: true });
  });
});

// ── (2) 규칙은 서버 것이다 ───────────────────────────────────────────────

test("#368 대량 칸·금액·다음 칸은 서버 값을 따라간다 — 클라가 기억하고 있으면 안 된다", async ({ page }) => {
  // 서버가 규칙을 바꾼 상황: **2번이 대량**(999), 3번은 평범. 다음 칸도 2번.
  await bootstrapLeague(page, {
    slots: [
      { slotNo: 1, amount: 30, big: false, state: "WON", opponentName: "Ironclad FC" },
      { slotNo: 2, amount: 999, big: true, state: "PENDING", opponentName: "Shadow Wolves" },
      { slotNo: 3, amount: 30, big: false, state: "PENDING", opponentName: "Azure Sentinels" },
    ],
    nextSlotNo: 2,
  });

  const rail = page.getByTestId("daily-reward-rail");
  await expect(rail.locator('[data-slot="2"]')).toHaveAttribute("data-big", "1");
  await expect(rail.locator('[data-slot="3"]')).toHaveAttribute("data-big", "0");
  await expect(rail.locator('[data-slot="2"]')).toHaveAttribute("data-next", "1");
  // 금액도 서버 값 — 표기(심볼)는 목 config 가 정한다.
  await expect(rail.locator('[data-slot="2"] [data-currency]')).toHaveAttribute("data-amount", "999");
  await expect(page.getByTestId("daily-reward-next")).toContainText("999");
});

// ── (3) 소진 ─────────────────────────────────────────────────────────────

test("#368 오늘 칸을 다 쓰면 '오늘 완료' + 다음 안내가 사라진다", async ({ page }) => {
  await bootstrapLeague(page, {
    slots: defaultSlots().map((s) => ({ ...s, state: s.state === "PENDING" ? "WON" : s.state })),
    nextSlotNo: null,
    awardedCount: 5,
    earned: 720,
  });

  await expect(page.getByTestId("daily-reward-exhausted")).toBeVisible();
  await expect(page.getByTestId("daily-reward-next")).toHaveCount(0);
  // 카드를 지우지 않는다 — 다 채운 트랙이 "오늘 얼마 받았나"를 말한다.
  await expect(page.getByTestId("daily-reward-rail").locator("[data-slot]")).toHaveCount(6);
  await expect(page.getByTestId("daily-reward-count")).toContainText("5회");

  mkdirSync(SMOKE_DIR, { recursive: true });
  await page.screenshot({ path: `${SMOKE_DIR}p368-track-exhausted.png`, fullPage: true });
});

// ── (4) 구 서버 폴백 ─────────────────────────────────────────────────────

test("#368 구 서버(dailyReward 부재)면 트랙만 사라지고 리그 화면은 그대로", async ({ page }) => {
  await bootstrapLeague(page, { legacyServer: true });

  await expect(page.getByTestId("daily-reward-track")).toHaveCount(0);
  // 앵커 — "아직 안 그려짐"이 아니라 **화면은 살아 있는데 트랙만 없다**를 본다(공허한 count(0) 방지).
  await expect(page.getByTestId("division-tag")).toBeVisible();
  await expect(page.getByTestId("season-tag")).toBeVisible();
});

// ── (5) 결과 화면 ────────────────────────────────────────────────────────

interface ResultOpts {
  result: "WIN" | "LOSS";
  daily?: { slotNo: number; currency: string; amount: number; awarded: boolean } | null;
}

async function bootstrapResult(page: Page, o: ResultOpts) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page, appConfigPayload());
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({
      user: { id: "U1", nickname: "테스터", isAdmin: false, tutorialDone: true },
      wallet: { points: 10000, gems: 100 },
      records: { wins: 0, draws: 0, losses: 0 },
      rating: 0,
    })),
  );
  await page.route((url) => url.pathname === "/api/matches/M1", (route) =>
    route.fulfill(json({
      id: "M1", state: "FINISHED", mode: "league",
      opponent: { name: "Shadow Wolves", players: [] },
      scoreHome: o.result === "WIN" ? 3 : 0, scoreAway: o.result === "WIN" ? 1 : 2,
      result: o.result, ownerName: "내 팀", homeName: "내 팀", awayName: "Shadow Wolves",
      userDeckSnapshot: { starters: [], bench: [] },
    })),
  );
  await page.route((url) => url.pathname === "/api/matches/M1/result", (route) =>
    route.fulfill(json({
      matchId: "M1",
      scoreHome: o.result === "WIN" ? 3 : 0, scoreAway: o.result === "WIN" ? 1 : 2,
      result: o.result,
      pointsAwarded: o.result === "WIN" ? 5000 : 1000,
      teamStats: {}, playerStats: [],
      ...(o.daily === undefined ? {} : { dailyReward: o.daily }),
    })),
  );
  await page.goto("/match/M1");
  await expect(page.getByTestId("result-page")).toBeVisible();
}

test.describe("#368 결과 화면", () => {
  test("승리 — 경기 보상과 오늘의 보상이 나란히 뜬다", async ({ page }) => {
    await bootstrapResult(page, {
      result: "WIN",
      daily: { slotNo: 3, currency: "GEM", amount: 30, awarded: true },
    });

    await expect(page.getByTestId("reward-points")).toContainText("5,000");
    const daily = page.getByTestId("reward-daily");
    await expect(daily).toHaveAttribute("data-awarded", "1");
    await expect(daily).toContainText("3번째 칸");
    await expect(daily.locator("[data-currency]")).toHaveAttribute("data-amount", "30");

    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}p368-result-win.png`, fullPage: true });
  });

  test("패배 — 칸이 소비됐고 얼마를 날렸는지 말한다", async ({ page }) => {
    await bootstrapResult(page, {
      result: "LOSS",
      daily: { slotNo: 9, currency: "GEM", amount: 300, awarded: false },
    });

    const daily = page.getByTestId("reward-daily");
    await expect(daily).toHaveAttribute("data-awarded", "0");
    await expect(page.getByTestId("reward-daily-vanished")).toContainText("소멸");
    // 금액이 남아 있어야 "대량 칸을 날렸다"가 전달된다.
    await expect(page.getByTestId("reward-daily-vanished").locator("[data-currency]"))
      .toHaveAttribute("data-amount", "300");

    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}p368-result-loss.png`, fullPage: true });
  });

  test("소진 후 — 줄은 남기고 이유를 말한다(사라지면 '왜 안 들어왔지'가 된다)", async ({ page }) => {
    await bootstrapResult(page, {
      result: "WIN",
      daily: { slotNo: 19, currency: "GEM", amount: 0, awarded: false },
    });

    await expect(page.getByTestId("reward-daily-exhausted")).toBeVisible();
    await expect(page.getByTestId("reward-daily")).toHaveCount(0);
    // 경기 보상은 그대로 들어온다(두 축은 별개다).
    await expect(page.getByTestId("reward-points")).toContainText("5,000");
  });

  test("연습 매치(dailyReward 부재)면 오늘의 보상 줄이 아예 없다", async ({ page }) => {
    await bootstrapResult(page, { result: "WIN" });

    await expect(page.getByTestId("reward-daily")).toHaveCount(0);
    await expect(page.getByTestId("reward-daily-none")).toHaveCount(0);
    await expect(page.getByTestId("reward-points")).toBeVisible();   // 앵커
  });
});
