import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { appConfigPayload, mockAppConfig } from "./app-config-mock";

/**
 * #408 원정 데일리 미션 — **백엔드 없이** vite dev + `page.route` 전면 목킹.
 *
 * 박제하는 계약:
 *  (1) 원정 페이지에 미션 섹션이 뜬다 — 제목 · 티어 배지 · 진행도 · 금액 · 상태 · 초기화 안내
 *  (2) **클라는 아무것도 계산하지 않는다** — 티어→금액 / 달성 여부 / 리롤 가능 여부를 서버 값이
 *      뒤집어도 화면이 서버를 따라간다(재계산 변이체를 죽이는 표본)
 *  (3) 수령 — 성공(지갑 갱신) · 이미 수령(409) · 미달성(409)이 각각 다른 말을 한다
 *  (4) 리롤 — 성공(새 미션) · 소진(409)
 *  (5) **구 서버 폴백** — 404 면 섹션이 통째로 없고 원정 화면은 그대로 살아 있다
 *  (6) 손상 응답(`{}` · 배열 · 깨진 필드)에도 흰 화면이 되지 않는다
 *  (7) 390px 가로 스크롤 0
 *  (8) 홈 "받을 보상 N건" 한 줄 — `claimableCount > 0` 일 때만
 *  (9) 결과 화면 — `missions` 를 그리고, 없으면 아예 안 그린다
 *
 * ⚠️ 표기는 목의 `/api/config` 를 따른다(#232) — 심볼을 단언하지 않고 **서버 값이 화면에 오는지**만 본다.
 * ⚠️ 라우트는 **pathname** 으로 잡는다(글롭을 오리진 없이 쓰면 vite 에셋까지 걸려 흰 화면).
 * ⚠️ `viewport` 는 반드시 명시한다 — 빠뜨리면 Playwright 가 조용히 데스크탑으로 돌리고
 *    폭 계약이 넓은 창에서 전부 초록이 된다(#386 실적).
 */

test.use({ viewport: { width: 390, height: 844 } });

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const err = (status: number, code: string, message: string, detail?: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ code, message, detail: detail ?? null }),
});

interface MissionSpec {
  id: string;
  missionId?: string;
  title: string;
  tier: string;
  currency?: string;
  amount: number;
  progress: number;
  target: number;
  state: "IN_PROGRESS" | "COMPLETED" | "CLAIMED";
  rerollable: boolean;
}

/**
 * 기본 미션 2개. **발행 금액(100/200/300)과 일부러 다르게** 둔다 — 같게 두면 클라가 티어→금액을
 * 재계산해도 관측값이 같아서 그 변이체가 살아남는다(server 웨이브에서 실제로 그랬다).
 */
function defaultMissions(): MissionSpec[] {
  return [
    {
      id: "MS1", missionId: "away_streak_2", title: "원정 2연승", tier: "NORMAL",
      amount: 777, progress: 1, target: 2, state: "IN_PROGRESS", rerollable: true,
    },
    {
      id: "MS2", missionId: "away_goals_4", title: "원정 한 경기에서 4골", tier: "HARD",
      amount: 888, progress: 4, target: 4, state: "COMPLETED", rerollable: false,
    },
  ];
}

/** 지난 날짜 달성·미수령 한 건. **`progress`/`target`/`rerollable` 이 없다**(서버 계약). */
interface PendingSpec {
  id: string;
  day: string;
  title: string;
  tier: string;
  amount: number;
}

interface DailyOpts {
  missions?: MissionSpec[];
  pendingClaims?: PendingSpec[];
  claimableCount?: number;
  claimableAmount?: number;
  /** 구 서버 재현 — `/api/missions/daily` 자체가 404. */
  legacyServer?: boolean;
  /** 손상 응답 그대로 흘려보낸다(정규화 방어 검증용). */
  rawBody?: unknown;
}

function dailyPayload(o: DailyOpts = {}) {
  const missions = (o.missions ?? defaultMissions()).map((m) => ({
    id: m.id,
    missionId: m.missionId ?? "away_play_1",
    title: m.title,
    tier: m.tier,
    currency: m.currency ?? "GEM",
    amount: m.amount,
    progress: m.progress,
    target: m.target,
    state: m.state,
    rerollable: m.rerollable,
  }));
  const pendingClaims = (o.pendingClaims ?? []).map((p) => ({
    id: p.id,
    day: p.day,
    missionId: "away_win_2",
    title: p.title,
    tier: p.tier,
    currency: "GEM",
    amount: p.amount,
  }));
  return {
    day: "2026-08-02",
    resetAtKst: "2026-08-03T00:00:00+09:00",
    missions,
    pendingClaims,
    // 서버는 이 둘을 **화면 데이터에서 파생**시킨다(missions 의 COMPLETED + pendingClaims 전부).
    // 목도 같은 규칙을 지켜야 계약이 자기가 만든 세계를 검사하지 않는다(#342 규율).
    claimableCount:
      o.claimableCount ??
      missions.filter((m) => m.state === "COMPLETED").length + pendingClaims.length,
    claimableAmount: o.claimableAmount ?? 0,
  };
}

function mePayload(gems = 100) {
  return {
    user: { id: "U1", nickname: "테스터", isAdmin: false, tutorialDone: true },
    wallet: { points: 10000, gems },
    records: { wins: 0, draws: 0, losses: 0 },
    rating: 1200,
  };
}

/** 목 상태 — 수령·리롤이 다음 GET 의 답을 바꿔야 "화면이 갱신되는가"를 실제로 볼 수 있다. */
interface MockState {
  daily: ReturnType<typeof dailyPayload>;
  gems: number;
  /** `/api/me` 요청 수 — 수령이 `["me"]` 를 무효화했는지의 **직접 관측**(지갑 배지가 이 화면엔 없다). */
  meHits: number;
  claimStatus?: { code: string; message: string; status: number; detail?: unknown };
  rerollStatus?: { code: string; message: string; status: number };
  /** 리롤이 성공하면 이 미션으로 갈아끼운다. */
  rerolled?: MissionSpec;
}

async function bootstrapAway(page: Page, o: DailyOpts = {}, state?: Partial<MockState>) {
  const s: MockState = {
    daily: dailyPayload(o),
    gems: 100,
    meHits: 0,
    ...state,
  };

  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page, appConfigPayload());
  await page.route((url) => url.pathname === "/api/me", (route) => {
    s.meHits += 1;
    return route.fulfill(json(mePayload(s.gems)));
  });

  await page.route((url) => url.pathname === "/api/missions/daily", (route) => {
    if (o.legacyServer) {
      return route.fulfill(err(404, "NOT_FOUND", "not found"));
    }
    if (o.rawBody !== undefined) {
      return route.fulfill(json(o.rawBody));
    }
    return route.fulfill(json(s.daily));
  });

  await page.route((url) => /^\/api\/missions\/[^/]+\/claim$/.test(url.pathname), (route) => {
    const id = decodeURIComponent(route.request().url().split("/api/missions/")[1].split("/")[0]);
    if (s.claimStatus) {
      return route.fulfill(err(s.claimStatus.status, s.claimStatus.code, s.claimStatus.message, s.claimStatus.detail));
    }
    // 수령은 **하나의 엔드포인트**다 — 오늘 것/지난 것을 서버가 구분하지 않는다(계약).
    const row = s.daily.missions.find((m) => m.id === id);
    if (row) {
      s.gems += row.amount;
      row.state = "CLAIMED";
    } else {
      const idx = s.daily.pendingClaims.findIndex((p) => p.id === id);
      if (idx < 0) return route.fulfill(err(404, "NOT_FOUND", "미션을 찾을 수 없습니다"));
      s.gems += s.daily.pendingClaims[idx].amount;
      // 받은 지난 보상은 목록에서 빠진다(서버가 `claimed_at` 을 채우면 다음 조회에 안 온다).
      s.daily.pendingClaims.splice(idx, 1);
    }
    s.daily.claimableCount = Math.max(0, s.daily.claimableCount - 1);
    const claimed = row ?? { currency: "GEM", amount: 0 };
    return route.fulfill(json({
      claimed: { currency: claimed.currency, amount: claimed.amount },
      wallet: { points: 10000, gems: s.gems },
    }));
  });

  await page.route((url) => /^\/api\/missions\/[^/]+\/reroll$/.test(url.pathname), (route) => {
    const id = decodeURIComponent(route.request().url().split("/api/missions/")[1].split("/")[0]);
    if (s.rerollStatus) {
      return route.fulfill(err(s.rerollStatus.status, s.rerollStatus.code, s.rerollStatus.message));
    }
    const next = s.rerolled ?? {
      id: "MS9", missionId: "away_play_1", title: "원정 경기를 1회 치른다", tier: "EASY",
      currency: "GEM", amount: 111, progress: 0, target: 1,
      state: "IN_PROGRESS" as const, rerollable: false,
    };
    const idx = s.daily.missions.findIndex((m) => m.id === id);
    s.daily.missions[idx] = { currency: "GEM", ...next } as (typeof s.daily.missions)[number];
    return route.fulfill(json({ mission: s.daily.missions[idx] }));
  });

  await page.goto("/away");
  await expect(page.getByTestId("away-page")).toBeVisible();
  return s;
}

// ── (1) 섹션이 그려진다 ──────────────────────────────────────────────────

test("#408 원정 페이지에 오늘의 미션 2개가 뜬다 — 제목·티어·진행도·금액·상태·초기화 안내", async ({ page }) => {
  await bootstrapAway(page);

  const section = page.getByTestId("daily-mission-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("mission-card")).toHaveCount(2);

  const first = section.locator('[data-mission-id="MS1"]');
  await expect(first.getByTestId("mission-title")).toHaveText("원정 2연승");
  await expect(first.getByTestId("mission-tier")).toHaveText("보통");
  await expect(first.getByTestId("mission-progress")).toHaveText("1 / 2");
  await expect(first.locator("[data-currency]")).toHaveAttribute("data-amount", "777");
  await expect(first).toHaveAttribute("data-state", "IN_PROGRESS");

  const second = section.locator('[data-mission-id="MS2"]');
  await expect(second.getByTestId("mission-tier")).toHaveText("어려움");
  await expect(second).toHaveAttribute("data-state", "COMPLETED");

  // 초기화 안내는 서버의 `resetAtKst` 에서 온다 — "자정"을 코드에 적지 않는다.
  await expect(section.getByTestId("mission-reset")).toContainText("8월 3일 00:00");

  // 상태를 색으로만 말하지 않는다 — 텍스트 + aria-label 병기(#262 규율).
  await expect(first.getByTestId("mission-state")).toHaveText(/진행 중/);
  await expect(first.getByTestId("mission-state")).toHaveAttribute("aria-label", /진행 중/);

  mkdirSync(SMOKE_DIR, { recursive: true });
  await page.screenshot({ path: `${SMOKE_DIR}p408-away-missions.png`, fullPage: true });
});

test("#408 390px 에서 가로로 넘치지 않는다", async ({ page }) => {
  await bootstrapAway(page, {
    missions: [
      { ...defaultMissions()[0], title: "원정 한 경기에서 4골을 넣고 무실점으로 승리한다" },
      defaultMissions()[1],
    ],
  });

  await expect(page.getByTestId("daily-mission-section")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

// ── (2) 클라는 아무것도 계산하지 않는다 ─────────────────────────────────

test("#408 달성 여부는 **서버 state** 다 — 진행도가 목표에 닿아도 서버가 아니라면 못 받는다", async ({ page }) => {
  // ⚠️ 이 두 카드가 `progress >= target` 재계산 변이체를 죽인다(양방향 표본).
  await bootstrapAway(page, {
    missions: [
      { id: "A", title: "닿았지만 미달성", tier: "EASY", amount: 100, progress: 2, target: 2, state: "IN_PROGRESS", rerollable: true },
      { id: "B", title: "못 닿았지만 달성", tier: "EASY", amount: 100, progress: 0, target: 3, state: "COMPLETED", rerollable: true },
    ],
  });

  await expect(page.locator('[data-mission-id="A"]').getByTestId("mission-claim")).toBeDisabled();
  await expect(page.locator('[data-mission-id="B"]').getByTestId("mission-claim")).toBeEnabled();
});

test("#408 리롤 가능 여부는 **서버 rerollable** 이다 — 상태로 추론하지 않는다", async ({ page }) => {
  await bootstrapAway(page, {
    missions: [
      // 진행 중인데 서버가 잠갔다(1회 소진) → 잠긴다.
      { id: "A", title: "리롤 소진", tier: "EASY", amount: 100, progress: 0, target: 1, state: "IN_PROGRESS", rerollable: false },
      // 달성했는데 서버가 열어 뒀다 → 열린다(클라가 "달성했으니 잠가야지"로 덮으면 안 된다).
      { id: "B", title: "서버가 열어 둠", tier: "EASY", amount: 100, progress: 1, target: 1, state: "COMPLETED", rerollable: true },
    ],
  });

  const a = page.locator('[data-mission-id="A"]');
  await expect(a.getByTestId("mission-reroll")).toBeDisabled();
  await expect(a.getByTestId("mission-reroll-reason")).toContainText("이미 썼습니다");
  await expect(page.locator('[data-mission-id="B"]').getByTestId("mission-reroll")).toBeEnabled();
});

test("#408 금액은 서버 값이다 — 티어에서 다시 만들지 않는다", async ({ page }) => {
  // 발행 곡선은 쉬움 100 인데 서버가 555 를 줬다 → 화면은 555 다.
  await bootstrapAway(page, {
    missions: [{ id: "A", title: "쉬운 미션", tier: "EASY", amount: 555, progress: 0, target: 1, state: "IN_PROGRESS", rerollable: true }],
  });
  await expect(page.locator('[data-mission-id="A"] [data-currency]')).toHaveAttribute("data-amount", "555");
});

// ── (3) 수령 ─────────────────────────────────────────────────────────────

test("#408 [받기] 성공 — 상태가 수령 완료로 바뀌고 **지갑 조회가 다시 나간다**", async ({ page }) => {
  const s = await bootstrapAway(page);
  // 첫 로드분이 안정될 때까지 기다린 뒤 기준을 잡는다.
  await expect(page.getByTestId("daily-mission-section")).toBeVisible();
  const before = s.meHits;

  const card = page.locator('[data-mission-id="MS2"]');
  await card.getByTestId("mission-claim").click();

  await expect(card).toHaveAttribute("data-state", "CLAIMED");
  await expect(card.getByTestId("mission-claim")).toBeDisabled();
  await expect(card.getByTestId("mission-claim")).toHaveText("수령 완료");

  // ⚠️ 수령은 **다이아를 움직인다** — `["me"]` 를 무효화하지 않으면 헤더 잔액과 실제가 어긋난
  // 화면이 남는다(가챠·우편함 선례). 이 화면엔 지갑 배지가 없으므로 재조회로 관측한다.
  await expect.poll(() => s.meHits, { timeout: 5000 }).toBeGreaterThan(before);
});

test("#408 [받기] 실패 — 이미 수령 / 미달성이 각각 다른 말을 한다", async ({ page }) => {
  await bootstrapAway(page, {}, {
    claimStatus: { status: 409, code: "MISSION_ALREADY_CLAIMED", message: "이미 수령했습니다" },
  });

  const card = page.locator('[data-mission-id="MS2"]');
  await card.getByTestId("mission-claim").click();
  await expect(card.getByTestId("mission-error")).toContainText("이미 받은 보상입니다");
});

test("#408 미달성 409 는 **서버 detail 의 진행도**를 인용한다", async ({ page }) => {
  await bootstrapAway(page, {}, {
    claimStatus: {
      status: 409, code: "MISSION_NOT_COMPLETED", message: "아직", detail: { progress: 1, target: 4 },
    },
  });

  const card = page.locator('[data-mission-id="MS2"]');
  await card.getByTestId("mission-claim").click();
  // 화면이 들고 있던 값(4 / 4)이 아니라 서버가 말한 값(1 / 4)이 뜬다.
  await expect(card.getByTestId("mission-error")).toContainText("1 / 4");
});

// ── (4) 리롤 ─────────────────────────────────────────────────────────────

test("#408 [다시 뽑기] 성공 — 새 미션으로 갈리고 진행도가 0 으로 돌아간다", async ({ page }) => {
  await bootstrapAway(page);

  const section = page.getByTestId("daily-mission-section");
  await section.locator('[data-mission-id="MS1"]').getByTestId("mission-reroll").click();

  await expect(section.locator('[data-mission-id="MS9"]')).toBeVisible();
  await expect(section.locator('[data-mission-id="MS9"]').getByTestId("mission-progress")).toHaveText("0 / 1");
  await expect(section.locator('[data-mission-id="MS1"]')).toHaveCount(0);
});

test("#408 [다시 뽑기] 소진 409 — 이유를 말한다", async ({ page }) => {
  await bootstrapAway(page, {}, {
    rerollStatus: { status: 409, code: "MISSION_REROLL_USED", message: "이미 리롤함" },
  });

  const card = page.locator('[data-mission-id="MS1"]');
  await card.getByTestId("mission-reroll").click();
  await expect(card.getByTestId("mission-error")).toContainText("이미 다시 뽑았습니다");
});

// ── (4.5) 받지 않은 보상 — 지난 날짜 (#408 갭1) ─────────────────────────

const PENDING: PendingSpec[] = [
  { id: "PC1", day: "2026-08-01", title: "원정에서 2승", tier: "NORMAL", amount: 222 },
  { id: "PC2", day: "2026-07-31", title: "원정 3연승", tier: "HARD", amount: 333 },
];

test("#408 지난 보상 묶음이 뜬다 — 날짜·금액·[받기], **진행도와 리롤은 없다**", async ({ page }) => {
  await bootstrapAway(page, { pendingClaims: PENDING });

  const group = page.getByTestId("pending-claims");
  await expect(group).toBeVisible();
  await expect(group.getByTestId("pending-claim")).toHaveCount(2);

  const first = group.locator('[data-mission-id="PC1"]');
  await expect(first.getByTestId("mission-title")).toHaveText("원정에서 2승");
  await expect(first.getByTestId("pending-claim-day")).toHaveText("8월 1일");
  await expect(first.locator("[data-currency]")).toHaveAttribute("data-amount", "222");
  await expect(first.getByTestId("pending-claim-claim")).toBeEnabled();

  // 없는 데이터를 0 으로 그리지 않는다 — "0 / 0" 이나 잠긴 [다시 뽑기]가 뜨면 거짓말이다.
  await expect(first.getByTestId("mission-progress")).toHaveCount(0);
  await expect(first.getByTestId("mission-reroll")).toHaveCount(0);

  // 오늘 미션 묶음과 **섞이지 않는다**(두 축이다).
  await expect(page.getByTestId("daily-mission-section").getByTestId("mission-card")).toHaveCount(2);

  mkdirSync(SMOKE_DIR, { recursive: true });
  await page.screenshot({ path: `${SMOKE_DIR}p408-pending-claims.png`, fullPage: true });
});

test("#408 지난 보상도 **같은 엔드포인트**로 받는다 — 받으면 목록에서 빠진다", async ({ page }) => {
  const s = await bootstrapAway(page, { pendingClaims: PENDING });
  await expect(page.getByTestId("pending-claims")).toBeVisible();
  const before = s.meHits;

  await page.locator('[data-mission-id="PC1"]').getByTestId("pending-claim-claim").click();

  await expect(page.locator('[data-mission-id="PC1"]')).toHaveCount(0);
  await expect(page.getByTestId("pending-claim")).toHaveCount(1);
  // 지갑이 움직였으니 `["me"]` 도 다시 나가야 한다.
  await expect.poll(() => s.meHits, { timeout: 5000 }).toBeGreaterThan(before);
});

test("#408 ⚠️ 오늘 미션이 없어도(롤백 스위치) 받지 않은 보상은 받을 수 있다", async ({ page }) => {
  // 설계 §9 — 끄기가 지갑을 뺏지 않는다. 여기서 섹션을 통째로 감추면 W3 이 잡은 버그
  // ("홈은 받을 보상 1건이라는데 원정 화면엔 받을 카드가 없다")가 롤백 경로에서 되살아난다.
  await bootstrapAway(page, { missions: [], pendingClaims: [PENDING[0]] });

  await expect(page.getByTestId("daily-mission-section")).toBeVisible();
  await expect(page.getByTestId("mission-card")).toHaveCount(0);
  await expect(page.getByTestId("pending-claim")).toHaveCount(1);
  await expect(page.locator('[data-mission-id="PC1"]').getByTestId("pending-claim-claim")).toBeEnabled();
});

test("#408 받지 않은 보상이 없으면 그 묶음 자체가 없다", async ({ page }) => {
  await bootstrapAway(page);
  await expect(page.getByTestId("daily-mission-section")).toBeVisible();
  await expect(page.getByTestId("pending-claims")).toHaveCount(0);
});

test("#408 홈 숫자와 원정 화면이 **같은 것을 가리킨다** — 홈이 세는 건수만큼 받을 자리가 있다", async ({ page }) => {
  // 이게 W3 이 잡은 버그의 직접 계약이다. 오늘 COMPLETED 1 + 지난 2 = 3 건.
  await bootstrapAway(page, { pendingClaims: PENDING });
  const today = await page.getByTestId("mission-claim").evaluateAll(
    (els) => els.filter((e) => !(e as HTMLButtonElement).disabled).length,
  );
  const past = await page.getByTestId("pending-claim-claim").count();
  expect(today + past).toBe(3); // = 목이 계산한 claimableCount(오늘 COMPLETED 1 + pending 2)
});

// ── (5)(6) 구 서버 폴백 · 손상 응답 ─────────────────────────────────────

test("#408 구 서버(404)면 미션 섹션만 사라지고 원정 화면은 그대로", async ({ page }) => {
  await bootstrapAway(page, { legacyServer: true });

  await expect(page.getByTestId("daily-mission-section")).toHaveCount(0);
  // 앵커 — "아직 안 그려짐"이 아니라 **화면은 살아 있는데 섹션만 없다**를 본다(공허한 count(0) 방지).
  await expect(page.getByTestId("away-start")).toBeVisible();
  await expect(page.getByTestId("away-rating-card")).toBeVisible();
});

test("#408 롤백 스위치(missions: [])도 섹션을 안 그린다 — 빈 껍데기 금지", async ({ page }) => {
  await bootstrapAway(page, { missions: [], claimableCount: 0 });
  await expect(page.getByTestId("daily-mission-section")).toHaveCount(0);
  await expect(page.getByTestId("away-start")).toBeVisible();
});

for (const [name, body] of [
  ["빈 객체", {}],
  ["배열", [{ id: "X" }]],
  ["깨진 필드", { missions: [{ id: "X", title: 42, amount: "많이", progress: null, target: {}, tier: 7, state: 1, rerollable: "yes" }] }],
  ["missions 가 배열이 아님", { missions: { id: "X" } }],
] as const) {
  test(`#408 손상 응답(${name})에도 원정 화면이 죽지 않는다`, async ({ page }) => {
    await bootstrapAway(page, { rawBody: body });
    // 흰 화면이 아니다 = 원정 화면의 앵커가 살아 있다.
    await expect(page.getByTestId("away-start")).toBeVisible();
  });
}

// ── (8) 홈 한 줄 ─────────────────────────────────────────────────────────

async function bootstrapHome(page: Page, o: DailyOpts) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page, appConfigPayload());
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json(mePayload())));
  await page.route((url) => url.pathname === "/api/missions/daily", (route) =>
    o.legacyServer ? route.fulfill(err(404, "NOT_FOUND", "not found")) : route.fulfill(json(dailyPayload(o))),
  );
  await page.goto("/home");
  await expect(page.getByTestId("home-page")).toBeVisible();
}

test("#408 홈 — 받을 보상이 있으면 한 줄이 뜨고 누르면 원정으로 간다", async ({ page }) => {
  await bootstrapHome(page, { claimableCount: 2, claimableAmount: 500 });

  const row = page.getByTestId("home-notif");
  await expect(row).toContainText("받을 보상 2건");
  await row.click();
  await expect(page).toHaveURL(/\/away$/);
});

test("#408 홈 — 받을 게 없으면 줄이 아예 없다(빈 줄은 '고장'으로 읽힌다)", async ({ page }) => {
  await bootstrapHome(page, { claimableCount: 0 });
  await expect(page.getByTestId("home-notif")).toHaveCount(0);
  await expect(page.getByTestId("home-tiles")).toBeVisible(); // 앵커
});

test("#408 홈 — 구 서버면 미션 몫이 0 이라 줄이 안 뜬다", async ({ page }) => {
  await bootstrapHome(page, { legacyServer: true });
  await expect(page.getByTestId("home-notif")).toHaveCount(0);
  await expect(page.getByTestId("home-tiles")).toBeVisible();
});

// ── (9) 결과 화면 ────────────────────────────────────────────────────────

async function bootstrapResult(page: Page, missions?: unknown) {
  const hits = { me: 0, claim: [] as string[] };
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page, appConfigPayload());
  await page.route((url) => /^\/api\/missions\/[^/]+\/claim$/.test(url.pathname), (route) => {
    hits.claim.push(route.request().url().split("/api/missions/")[1].split("/")[0]);
    return route.fulfill(json({
      claimed: { currency: "GEM", amount: 222 },
      wallet: { points: 10000, gems: 322 },
    }));
  });
  await page.route((url) => url.pathname === "/api/me", (route) => {
    hits.me += 1;
    return route.fulfill(json(mePayload()));
  });
  await page.route((url) => url.pathname === "/api/matches/M1", (route) =>
    route.fulfill(json({
      id: "M1", state: "FINISHED", mode: "away",
      opponent: { name: "Shadow Wolves", players: [] },
      scoreHome: 3, scoreAway: 1, result: "WIN",
      ownerName: "내 팀", homeName: "내 팀", awayName: "Shadow Wolves",
      userDeckSnapshot: { starters: [], bench: [] },
    })),
  );
  await page.route((url) => url.pathname === "/api/matches/M1/result", (route) =>
    route.fulfill(json({
      matchId: "M1", scoreHome: 3, scoreAway: 1, result: "WIN",
      pointsAwarded: 5000, teamStats: {}, playerStats: [],
      ...(missions === undefined ? {} : { missions }),
    })),
  );
  await page.goto("/match/M1");
  await expect(page.getByTestId("result-page")).toBeVisible();
  return hits;
}

/** 결과 화면 미션 한 건. `state` 는 **필수**다(#408 갭2) — 빼면 문이 닫힌 쪽으로 떨어진다. */
const rm = (over: Record<string, unknown>) => ({
  id: "R1", missionId: "away_win_2", title: "원정에서 2승", tier: "NORMAL",
  currency: "GEM", amount: 222, progress: 2, target: 2,
  completedNow: true, state: "COMPLETED", ...over,
});

test("#408 결과 화면 — 이 경기가 민 미션이 뜨고, 이번에 달성한 것을 구분한다", async ({ page }) => {
  await bootstrapResult(page, [
    rm({}),
    rm({ id: "R2", title: "원정 경기를 3회 치른다", amount: 333, progress: 1, target: 3, completedNow: false, state: "IN_PROGRESS" }),
  ]);

  const section = page.getByTestId("result-missions");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("result-mission")).toHaveCount(2);

  const done = section.locator('[data-mission-id="R1"]');
  await expect(done).toHaveAttribute("data-completed-now", "1");
  await expect(done).toContainText("원정에서 2승");
  await expect(done.locator("[data-currency]")).toHaveAttribute("data-amount", "222");

  await expect(section.locator('[data-mission-id="R2"]')).toHaveAttribute("data-completed-now", "0");
  await expect(section.locator('[data-mission-id="R2"]').getByTestId("result-mission-progress")).toHaveText("1 / 3");

  // 경기 보상 줄은 그대로 — 두 축은 별개다.
  await expect(page.getByTestId("reward-points")).toBeVisible();

  mkdirSync(SMOKE_DIR, { recursive: true });
  await page.screenshot({ path: `${SMOKE_DIR}p408-result-missions.png`, fullPage: true });
});

test("#408 결과 화면 — 연습/리그 매치(missions 부재)면 구역이 아예 없다", async ({ page }) => {
  await bootstrapResult(page);
  await expect(page.getByTestId("result-missions")).toHaveCount(0);
  await expect(page.getByTestId("reward-points")).toBeVisible(); // 앵커
});

test("#408 결과 화면 — 손상된 missions(배열 아님·깨진 항목)에도 결과가 죽지 않는다", async ({ page }) => {
  await bootstrapResult(page, { nope: true });
  await expect(page.getByTestId("result-missions")).toHaveCount(0);
  await expect(page.getByTestId("reward-points")).toBeVisible();
});

// ── (9.5) 결과 화면 수령 (#408 갭2) ──────────────────────────────────────

test("#408 결과 화면 [받기] — 달성분을 그 자리에서 받는다(지갑 조회가 다시 나간다)", async ({ page }) => {
  const hits = await bootstrapResult(page, [rm({})]);
  const before = hits.me;

  const row = page.locator('[data-mission-id="R1"]');
  await row.getByTestId("result-mission-claim").click();

  // 같은 엔드포인트, 같은 id.
  await expect.poll(() => hits.claim).toEqual(["R1"]);
  await expect.poll(() => hits.me, { timeout: 5000 }).toBeGreaterThan(before);
});

test("#408 결과 화면 — ⚠️ **양방향**: 진행도가 닿아도 CLAIMED 면 버튼이 없고, 못 닿아도 COMPLETED 면 있다", async ({ page }) => {
  // 한쪽만 두면 "state 도 보되 progress 도 본다"는 변이가 산다. `2/2 + CLAIMED` 가
  // "수령 후에도 버튼이 남는" 결함을 죽이는 표본이다.
  await bootstrapResult(page, [
    rm({ id: "C", progress: 2, target: 2, state: "CLAIMED", completedNow: false }),
    rm({ id: "D", progress: 0, target: 3, state: "COMPLETED", completedNow: false }),
  ]);

  const claimed = page.locator('[data-mission-id="C"]');
  await expect(claimed.getByTestId("result-mission-claim")).toHaveCount(0);
  // 색이 아니라 **말**로 알린다.
  await expect(claimed.getByTestId("result-mission-claimed")).toContainText("받음");

  await expect(page.locator('[data-mission-id="D"]').getByTestId("result-mission-claim")).toBeEnabled();
});

test("#408 결과 화면 — 진행 중이면 버튼도 '받음'도 없다(누를 것이 없다)", async ({ page }) => {
  await bootstrapResult(page, [rm({ id: "P", progress: 1, target: 3, state: "IN_PROGRESS", completedNow: false })]);
  const row = page.locator('[data-mission-id="P"]');
  await expect(row.getByTestId("result-mission-claim")).toHaveCount(0);
  await expect(row.getByTestId("result-mission-claimed")).toHaveCount(0);
  await expect(row.getByTestId("result-mission-progress")).toHaveText("1 / 3"); // 앵커
});

test("#408 결과 화면 — `state` 없는 구 서버 응답은 **문이 닫힌다**(fail-closed)", async ({ page }) => {
  const { state: _drop, ...noState } = rm({ progress: 2, target: 2 });
  await bootstrapResult(page, [noState]);
  await expect(page.getByTestId("result-mission")).toHaveCount(1); // 줄은 그린다
  await expect(page.getByTestId("result-mission-claim")).toHaveCount(0); // 버튼은 없다
});

test("#408 결과 화면 — 수령 실패(409)는 그 줄에서 이유를 말한다", async ({ page }) => {
  await bootstrapResult(page, [rm({})]);
  // ⚠️ **bootstrap 뒤에** 얹는다 — Playwright 는 나중에 등록된 핸들러를 먼저 본다.
  // 앞에 등록하면 bootstrap 의 성공 핸들러가 이겨서 이 테스트가 성공 경로를 검사하게 된다.
  await page.route((url) => /^\/api\/missions\/[^/]+\/claim$/.test(url.pathname), (route) =>
    route.fulfill(err(409, "MISSION_ALREADY_CLAIMED", "이미 수령했습니다")),
  );

  const row = page.locator('[data-mission-id="R1"]');
  await row.getByTestId("result-mission-claim").click();
  await expect(row.getByTestId("result-mission-error")).toContainText("이미 받은 보상입니다");
});

test("#408 결과 화면 — '원정 화면에서 받으세요' 안내는 사라졌다(더 이상 사실이 아니다)", async ({ page }) => {
  await bootstrapResult(page, [rm({})]);
  await expect(page.getByTestId("result-missions")).not.toContainText("원정 화면에서");
});
