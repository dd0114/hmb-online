import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mockAppConfig } from "./app-config-mock";

/**
 * **보상 시트 + 성장 선택** 계약 (#405 W3, 설계 §2.9/§2.9.1, 목업 화면 ①~④).
 *
 * 백엔드 없이 `page.route` 로 목킹한다 — 라우트 매칭은 **pathname 술어**로(glob `**\/api\/**` 는
 * vite 소스 `/src/api/*.ts` 까지 잡아 흰 화면이 된다, 프로젝트 기지식).
 *
 * 계약:
 *  a. FINISHED + 확인 전 봉투 → **결과 화면보다 먼저** 보상 시트가 뜬다. `[확인]` 이 ack 를 치고
 *     그제야 결과 화면이 보인다.
 *  b. **`rewardBundle: null`(W2b 이전 매치)은 곧장 결과 화면** — 회귀 금지.
 *  c. 이미 확인한 봉투도 곧장 결과 화면 — 매 진입마다 [확인]을 또 누르게 하지 않는다.
 *  d. 섹션이 비면 **탭 자체가 없다**(§2.9.1 `isPresent`).
 *  e. 탭 뱃지 = 선택 **횟수**(선수 수가 아니다 — 목업 확정).
 *  f. 레벨업 행 → 후보 3장(고정 안내 + 상승폭) → 선택 → 적용·축하 → 남은 대기 유도.
 *  g. 폰·데스크탑 모두 **문서 스크롤 0** + `[확인]` 이 화면 안(#355 — 목록에 상한이 없다).
 *  h. 금액은 **서버 표기 메타를 따라온다**(#232) — config 를 바꾸면 화면이 따라온다.
 */

const CAP_DIR = new URL("../.p405/", import.meta.url).pathname;
const MATCH_ID = "M405";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const STARTERS = [
  ["P001", "강태산", "GK", "SILVER"],
  ["P002", "박정우", "DF", "GOLD"],
  ["P003", "이현수", "DF", "BRONZE"],
  ["P004", "최민재", "DF", "GOLD"],
  ["P005", "윤성호", "DF", "SILVER"],
  ["P006", "김도현", "MF", "GOLD"],
  ["P007", "정우영", "MF", "DIA"],
  ["P008", "한지훈", "MF", "BRONZE"],
  ["P009", "오세훈", "FW", "GOLD"],
  ["P010", "류지호", "FW", "LEGEND"],
  ["P011", "남기웅", "FW", "SILVER"],
  ["P012", "서준혁", "MF", "GOLD"],
] as const;
const BENCH = [
  ["P013", "백승주", "DF", "SILVER"],
  ["P014", "조현탁", "FW", "BRONZE"],
  ["P015", "문세영", "MF", "GOLD"],
  ["P016", "임태경", "GK", "BRONZE"],
] as const;

/** 선택 대기 3건 — 선수는 2명이다(P003 이 2건). 뱃지가 어느 쪽을 세는지 갈라 보기 위한 표본. */
const CHOICES = [
  {
    choiceId: "c-1",
    playerId: "P003",
    level: 11,
    // ⚠️ 세 후보의 `reason.kind` 를 **일부러 다르게** 잡았다 — 목업 화면 ③ 의 확인 포인트가
    // "셋 다 다른 축(그 경기 이벤트 / 지시 / 포지션)"이고, 한 축만 태우면 매핑 구멍이 안 보인다.
    candidates: [
      { stat: "tackling", gain: 3.82, core: true, reason: { kind: "EVENT", detail: { type: "tackle", count: 6 } } },
      { stat: "physical", gain: 3.11, core: true, reason: { kind: "POSITION", detail: { position: "DF" } } },
      { stat: "pace", gain: 2.45, core: false, reason: { kind: "BEHAVIOR", detail: { param: "widthTendency", value: 0.79 } } },
    ],
  },
  {
    choiceId: "c-2",
    playerId: "P003",
    level: 12,
    // ⚠️ 구 박제분 표본 — `core` 키가 **아예 없다**. 화면은 배지를 생략해야 한다(false 로 눕히면
    // "핵심이 아니다"라는 없는 사실을 단언하게 된다).
    candidates: [
      { stat: "positioning", gain: 3.4, reason: { kind: "RESULT", detail: { result: "WIN" } } },
      // `BASE` 와 `reason` 부재(구 행)는 **줄이 없어야** 한다 — 지어내지 않는 성질의 표본.
      { stat: "mental", gain: 2.9, reason: { kind: "BASE", detail: {} } },
      { stat: "stamina", gain: 2.2 },
    ],
  },
  {
    choiceId: "c-3",
    playerId: "P006",
    level: 8,
    // 🚨 **gain 내림차순이 아니다 — 일부러 그렇다**(서버 `619d18b` 실응답 P001 GK 와 같은 모양).
    // `shooting` 은 gain 이 `technical` 보다 큰데(2.9 > 2.4) **맨 뒤**다: 이 포지션에 shooting 은
    // OVR 기여가 거의 없어 서버가 `positionBaseline × gain` 으로 뒤로 보냈다.
    // 클라가 gain 순으로 재정렬하면 1번 자리에 **지는 선택**이 오고, 그게 이 작업의 이유다.
    candidates: [
      { stat: "passing", gain: 2.8, core: true, reason: { kind: "BEHAVIOR", detail: { param: "passRisk", value: 0.7 } } },
      { stat: "technical", gain: 2.4, core: true, reason: { kind: "EVENT", detail: { type: "pass", count: 41 } } },
      // 서버가 축을 늘렸을 때 — 모르는 kind 는 죽지 않고 줄만 생략한다. `core:false` = 비핵심.
      { stat: "shooting", gain: 2.9, core: false, reason: { kind: "MORALE", detail: { value: 1 } } },
    ],
  },
];

function growthEntries() {
  const leveled: Record<string, string[]> = { P003: ["c-1", "c-2"], P006: ["c-3"] };
  const played = STARTERS.map(([id, name, position, grade], i) => {
    const ids = leveled[id] ?? [];
    const lv = 12 - i;
    return {
      playerId: id,
      name,
      position,
      grade,
      xpGained: 90 + i * 7,
      levelBefore: lv,
      // 레벨업 선수는 선택권 수만큼 오른다(레벨업 1회 = 선택 1회) — P003 은 2레벨이다.
      levelAfter: lv + ids.length,
      // 정산 **직후** 진행도. 서버가 계산해 스냅샷에 박는다(클라가 곡선을 미러하지 않는다).
      cardXp: 20 + i * 10,
      // P012(마지막 선발)만 만렙 표본 — `xpToNext: 0` 이면 바가 꽉 차야 한다(나누면 Infinity).
      xpToNext: i === STARTERS.length - 1 ? 0 : 141,
      // 교체 투입 표본 하나 — 목업 ② 의 `교체 투입` 칩.
      minutes: i === STARTERS.length - 1 ? "partial" : "starter",
      pendingChoices: CHOICES.filter((c) => ids.includes(c.choiceId)),
    };
  });
  const bench = BENCH.map(([id, name, position, grade], i) => ({
    playerId: id,
    name,
    position,
    grade,
    xpGained: 0,
    levelBefore: 4 + i,
    levelAfter: 4 + i,
    cardXp: 30,
    xpToNext: 141,
    minutes: "bench",
    pendingChoices: [],
  }));
  return [...played, ...bench];
}

function bundle(over: Record<string, unknown> = {}) {
  return {
    bundleId: "B405",
    source: "MATCH",
    sourceRef: MATCH_ID,
    acknowledgedAt: null,
    sections: [
      { kind: "CURRENCY", entries: [{ code: "POINT", amount: 1200 }] },
      { kind: "GROWTH", entries: growthEntries() },
    ],
    ...over,
  };
}

const CARD_ATTRS: Record<string, number> = {
  shooting: 36, pace: 40, positioning: 41, technical: 38,
  passing: 37, stamina: 39, physical: 42, mental: 38, tackling: 44,
};
const CARD_CAPS: Record<string, number> = Object.fromEntries(
  Object.keys(CARD_ATTRS).map((k) => [k, 73]),
);

/**
 * 결과 응답의 **additive 미션 블록**(#408 §8). 봉투 `sections[]` 안이 아니다 — 미션 섹션의
 * `isPresent`/`render` 가 봉투가 아니라 **응답**을 읽는 이유가 이것이다(`registry.ts`).
 */
const mission = (over: Record<string, unknown> = {}) => ({
  id: "MS1", missionId: "away_win_2", title: "원정에서 2승", tier: "NORMAL",
  currency: "GEM", amount: 222, progress: 2, target: 2,
  completedNow: true, state: "COMPLETED", ...over,
});

interface MockOpts {
  /** 봉투 자체를 안 준다(W2b 이전 매치). */
  noBundle?: boolean;
  /** 이미 확인한 봉투. */
  acknowledged?: boolean;
  /** 재화 섹션을 비운다(§2.9.1 `isPresent` — 탭이 사라지는지). */
  currencyEmpty?: boolean;
  /** 결과 응답의 additive `missions` 블록(#408). 안 주면 원정이 아닌 경기다. */
  missions?: unknown;
  /** ack 호출 기록기. */
  onAck?: (bundleId: string) => void;
  /** 선택 적용 기록기. */
  onChoose?: (choiceId: string, stat: string) => void;
  /** 미션 수령 기록기. */
  onClaim?: (missionId: string) => void;
}

async function mockApi(page: Page, opts: MockOpts = {}) {
  const pending = [...CHOICES];
  const statAdd: Record<string, number> = {};

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page);

  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({ user: { id: "u1", nickname: "내 팀" }, wallet: { points: 20000, gems: 50 }, records: { wins: 1, draws: 0, losses: 0 } })),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) =>
    route.fulfill(json({
      id: MATCH_ID,
      state: "FINISHED",
      opponent: { name: "붉은늑대 FC", analysisText: "", deck: [] },
      scoreHome: 2,
      scoreAway: 1,
      result: "WIN",
      createdAt: "2026-08-02T00:00:00Z",
    })),
  );
  await page.route((url) => new RegExp(`/api/matches/${MATCH_ID}/halves/[12]/log$`).test(url.pathname), (route) =>
    route.fulfill(json({ events: [] })),
  );
  // 결과 화면의 성장 리포트 — 봉투와 **같은 자료**를 서버가 한 함수로 만든다(GrowthService.growthEntries).
  await page.route((url) => url.pathname === `/api/growth/report/${MATCH_ID}`, (route) =>
    route.fulfill(json({ matchId: MATCH_ID, entries: growthEntries() })),
  );

  let acked = Boolean(opts.acknowledged);
  /**
   * ⚠️ 수령하면 서버는 그 행을 `CLAIMED` 로 바꾼다 — **다음 결과 조회부터 그 값이 온다**.
   * 목이 정적이면 "받고 나면 경고가 사라지나"를 **구조적으로 못 잡는다**(#408 blocker-1 교훈).
   */
  let servedMissions = opts.missions;
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}/result`, (route) => {
    const sections = opts.currencyEmpty
      ? [{ kind: "GROWTH", entries: growthEntries() }]
      : bundle().sections;
    route.fulfill(json({
      matchId: MATCH_ID,
      scoreHome: 2,
      scoreAway: 1,
      result: "WIN",
      pointsAwarded: 1200,
      ...(servedMissions === undefined ? {} : { missions: servedMissions }),
      rewardBundle: opts.noBundle
        ? null
        : { ...bundle({ acknowledgedAt: acked ? "2026-08-02T01:00:00Z" : null }), sections },
    }));
  });

  await page.route((url) => /^\/api\/missions\/[^/]+\/claim$/.test(url.pathname), (route) => {
    const id = route.request().url().split("/api/missions/")[1]!.split("/")[0]!;
    opts.onClaim?.(id);
    // 받은 줄은 CLAIMED 가 된다 → `unclaimed` 가 줄고, 다 받으면 경고가 사라져야 한다.
    if (Array.isArray(servedMissions)) {
      servedMissions = (servedMissions as Record<string, unknown>[]).map((m) =>
        m.id === id ? { ...m, state: "CLAIMED" } : m,
      );
    }
    route.fulfill(json({ claimed: { currency: "GEM", amount: 222 }, wallet: { points: 20000, gems: 272 } }));
  });

  await page.route((url) => /^\/api\/rewards\/[^/]+\/ack$/.test(url.pathname), (route) => {
    const id = route.request().url().split("/").slice(-2)[0]!;
    acked = true;
    opts.onAck?.(id);
    route.fulfill(json({ ...bundle({ acknowledgedAt: "2026-08-02T01:00:00Z" }) }));
  });

  await page.route((url) => url.pathname === "/api/growth/choices", (route) =>
    route.fulfill(json({ choices: pending })),
  );
  await page.route((url) => /^\/api\/growth\/card\/[^/]+$/.test(url.pathname), (route) => {
    const playerId = route.request().url().split("/").pop()!;
    const attrs: Record<string, number> = {};
    for (const [k, v] of Object.entries(CARD_ATTRS)) attrs[k] = Math.min(73, v + (statAdd[k] ?? 0));
    route.fulfill(json({
      playerId,
      grade: "BRONZE",
      star: 2,
      attributes: attrs,
      prePotential: attrs,
      base: CARD_ATTRS,
      caps: CARD_CAPS,
      statAdd: { ...statAdd },
      cardLevel: 12,
      cardXp: 60,
      xpToNext: 346,
      maxLevel: 40,
      // caps(73) = growCeil(72) + starCeilBonus(★2 → 1), 하드캡 99 미만이라 덧셈이 성립한다.
      growCeil: 72,
      starCeilBonus: 1,
      attrHardCap: 99,
      startLo: 32, // BRONZE 시작 밴드 하한 — 후보 막대의 좌측 앵커
      pendingChoices: pending.filter((c) => c.playerId === playerId),
      statLevels: {},
      potential: { unlocked: true, tier: "RARE", maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 9 },
      ovr: 40,
      completion: 0.1,
    }));
  });
  await page.route((url) => /^\/api\/growth\/choices\/[^/]+$/.test(url.pathname), (route) => {
    if (route.request().method() !== "POST") return route.fulfill(json({ choices: pending }));
    const id = route.request().url().split("/").pop()!;
    const idx = pending.findIndex((c) => c.choiceId === id);
    const body = route.request().postDataJSON() as { stat: string };
    const cand = pending[idx]?.candidates.find((c) => c.stat === body.stat);
    if (idx < 0 || !cand) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "CHOICE_ALREADY_MADE", message: "이미 선택한 성장입니다" }) });
    }
    const row = pending[idx]!;
    pending.splice(idx, 1);
    statAdd[body.stat] = (statAdd[body.stat] ?? 0) + cand.gain;
    opts.onChoose?.(id, body.stat);
    const attrs: Record<string, number> = {};
    for (const [k, v] of Object.entries(CARD_ATTRS)) attrs[k] = Math.min(73, v + (statAdd[k] ?? 0));
    route.fulfill(json({
      choiceId: id,
      playerId: row.playerId,
      level: row.level,
      stat: body.stat,
      gain: cand.gain,
      card: {
        playerId: row.playerId,
        grade: "BRONZE",
        star: 2,
        attributes: attrs,
        prePotential: attrs,
        base: CARD_ATTRS,
        caps: CARD_CAPS,
        statAdd: { ...statAdd },
        cardLevel: 12,
        cardXp: 60,
        xpToNext: 346,
        maxLevel: 40,
        growCeil: 72,
        starCeilBonus: 1,
        attrHardCap: 99,
        startLo: 32,
        pendingChoices: pending.filter((c) => c.playerId === row.playerId),
        statLevels: {},
        potential: { unlocked: true, tier: "RARE", maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 9 },
        ovr: 40,
        completion: 0.1,
      },
    }));
  });

  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
}

/** 문서가 스크롤하지 않는다(셸 규약). 가로 오버플로도 0. */
async function expectNoDocumentScroll(page: Page) {
  const m = await page.evaluate(() => ({
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(m.y).toBeLessThanOrEqual(0);
  expect(m.x).toBeLessThanOrEqual(0);
}

test("a. 경기 종료 → 보상 시트가 결과 화면보다 먼저 · [확인] 이 ack 를 치고 결과로 넘긴다", async ({ page }) => {
  mkdirSync(CAP_DIR, { recursive: true });
  const acks: string[] = [];
  await mockApi(page, { onAck: (id) => acks.push(id) });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);

  const sheet = page.getByTestId("reward-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("data-acknowledged", "0");
  await expect(page.getByTestId("reward-badge")).toHaveText("승리");
  // 시트가 열려 있는 동안 결과 패널은 그 아래다 — 나가는 문은 [확인] 하나.
  await expect(page.getByTestId("reward-confirm")).toBeVisible();
  await expectNoDocumentScroll(page);
  await page.screenshot({ path: `${CAP_DIR}sheet-currency-390.png` });

  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("reward-sheet")).toHaveCount(0);
  await expect(page.getByTestId("result-page")).toBeVisible();
  await expect(page.getByTestId("final-score")).toBeVisible();
  expect(acks).toEqual(["B405"]);
});

test("b. rewardBundle 이 null(W2b 이전 매치)이면 시트 없이 곧장 결과 화면 — 회귀 금지", async ({ page }) => {
  await mockApi(page, { noBundle: true });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("result-page")).toBeVisible();
  await expect(page.getByTestId("reward-sheet")).toHaveCount(0);
  await expect(page.getByTestId("to-lobby")).toBeVisible();
});

test("c. 이미 확인한 봉투는 다시 안 뜬다", async ({ page }) => {
  await mockApi(page, { acknowledged: true });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("result-page")).toBeVisible();
  await expect(page.getByTestId("reward-sheet")).toHaveCount(0);
});

test("d. 섹션이 비면 탭 자체가 없다 (§2.9.1 isPresent)", async ({ page }) => {
  await mockApi(page, { currencyEmpty: true });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("reward-sheet")).toBeVisible();
  // 성장 섹션은 있고 재화는 없다 → 탭이 하나뿐이므로 탭바를 아예 안 그린다.
  await expect(page.getByTestId("reward-section-GROWTH")).toBeVisible();
  await expect(page.getByTestId("reward-tab-CURRENCY")).toHaveCount(0);
  await expect(page.getByTestId("reward-tab-GROWTH")).toHaveCount(0);
});

test("e. 재화 탭은 서버 표기 메타를 따라오고, 성장 탭 뱃지는 선택 '횟수'다", async ({ page }) => {
  mkdirSync(CAP_DIR, { recursive: true });
  await mockApi(page);
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);

  // 금액·심볼·이름 전부 config 에서 온다(#232) — 화면 코드에 "P"·"포인트" 가 없다.
  const row = page.getByTestId("reward-currency-POINT");
  await expect(row).toContainText("골드");
  await expect(row).toContainText("1,200 G");

  // ⚠️ 뱃지 = 선택 **횟수** 3(대기 선수는 2명이다 — 두 수가 갈리는 표본을 일부러 만들었다).
  await expect(page.getByTestId("reward-tab-badge")).toHaveText("3");

  await page.getByTestId("reward-tab-GROWTH").click();
  // ⚠️ **스코프가 필요하다** — 같은 행 컴포넌트가 시트와 결과 화면 성장 리포트 **양쪽**에 있다
  // (그게 "두 화면이 갈리지 않는다"의 대가다). 스코프 없이 잡으면 strict mode 위반으로 죽는다.
  const growth = page.getByTestId("reward-section-GROWTH");
  await expect(growth).toBeVisible();
  await expect(growth.getByTestId("growth-summary")).toContainText("12명 출전");
  await expect(growth.getByTestId("growth-summary")).toContainText("선택 대기 3회");
  // 미투입 벤치는 구분선 아래 +0 XP.
  await expect(growth.getByTestId("growth-bench-divider")).toBeVisible();
  await expect(growth.getByTestId("growth-row-xp-P016")).toHaveText("+0 XP");
  // 대기 있는 선수만 행 뱃지 — P003 은 2건이다(선수 단위가 아니라 건 단위).
  await expect(growth.getByTestId("growth-pending-P003")).toHaveText("선택 대기 2");
  await expect(growth.getByTestId("growth-pending-P006")).toHaveText("선택 대기 1");
  await expect(growth.getByTestId("growth-pending-P001")).toHaveCount(0);

  // 행 XP 바 = 서버가 준 cardXp / xpToNext (클라가 곡선을 미러하지 않는다).
  // P001: 20 / 141 = 14%. ⚠️ 만렙 표본 P012 는 xpToNext 0 → 꽉 참(나누면 Infinity 다).
  await expect(growth.getByTestId("growth-xpbar-P001")).toHaveAttribute("data-value", "14");
  await expect(growth.getByTestId("growth-xpbar-P012")).toHaveAttribute("data-value", "100");
  // 출전 구분은 `minutes` 가 소유한다 — 교체 투입 칩은 그 값이 `partial` 인 행에만.
  await expect(growth.getByTestId("growth-partial-P012")).toHaveText("교체 투입");
  await expect(growth.getByTestId("growth-partial-P001")).toHaveCount(0);
  await expectNoDocumentScroll(page);
  await page.screenshot({ path: `${CAP_DIR}sheet-growth-390.png` });
  // 교체 투입 칩 · 만렙 바 · 벤치 구분선은 목록 아래쪽이라 스크롤해서 한 장 더 남긴다.
  await growth.getByTestId("growth-row-P016").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${CAP_DIR}sheet-growth-390-bottom.png` });
});

test("f. 레벨업 행 → 후보 3장 → 선택 → 적용·축하 + 남은 대기 유도", async ({ page }) => {
  mkdirSync(CAP_DIR, { recursive: true });
  const chosen: Array<[string, string]> = [];
  await mockApi(page, { onChoose: (id, stat) => chosen.push([id, stat]) });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await page.getByTestId("reward-tab-GROWTH").click();
  await page.getByTestId("reward-section-GROWTH").getByTestId("growth-row-P003").click();

  // 고정 안내(hero 명시 요구) + 후보 3장 + 상승폭 + 현재→적용후 + 천장.
  await expect(page.getByTestId("choice-lock-note")).toContainText("선택지는 고정됩니다");
  await expect(page.getByTestId("choice-candidates").locator("button")).toHaveCount(3);
  await expect(page.getByTestId("choice-gain-tackling")).toHaveText("+3.82");
  // 44 → min(73, 44+3.82) = 47.8. 서버가 박제한 gain 이 화면 숫자와 같아야 한다.
  await expect(page.getByTestId("choice-to-tackling")).toHaveText("47.8");

  // "왜 이 후보인가" — 셋 다 **다른 축**이다(그 경기 이벤트 / 포지션 / 지시). 목업 화면 ③ 확인 포인트.
  await expect(page.getByTestId("choice-why-tackling")).toContainText("이 경기 태클 6회");
  await expect(page.getByTestId("choice-why-physical")).toContainText("포지션 DF 핵심");
  await expect(page.getByTestId("choice-why-pace")).toContainText('지시 "넓게 벌려"');

  // 좌측 앵커 = 서버 `startLo`(BRONZE 32) — 근사치가 아니라 **이름을 붙일 수 있는 값**이다.
  await expect(page.getByTestId("choice-start-tackling")).toHaveText("시작 32");

  // ⚠️ 라벨과 **막대 원점이 실제로 맞물리는가**. 축 = [32, 73] 이므로 44.0 은 (44−32)/41 ≈ 29.3%.
  // 라벨만 맞고 막대가 옛 앵커로 그려지는 상태를 이 단언이 죽인다(숫자 두 개가 같은 축을 말한다).
  const curFrac = await page
    .getByTestId("choice-cand-tackling")
    .locator('[class*="ceilCur"]')
    .evaluate((el) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      const track = (el.parentElement as HTMLElement).getBoundingClientRect();
      return box.width / track.width;
    });
  expect(curFrac).toBeGreaterThan(0.27);
  expect(curFrac).toBeLessThan(0.32);

  // 세 막대가 같은 원점을 쓰므로 `+gain` 이 큰 후보의 초록 구간이 실제로 더 길다.
  const widths = await page
    .getByTestId("choice-candidates")
    .locator('[class*="ceilAdd"]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).getBoundingClientRect().width));
  expect(widths).toHaveLength(3);
  expect(widths[0]).toBeGreaterThan(widths[1]!); // +3.82 > +3.11
  expect(widths[1]).toBeGreaterThan(widths[2]!); // +3.11 > +2.45

  // `core` 배지 — 있는 것만 그린다(pace 는 core:false).
  await expect(page.getByTestId("choice-core-tackling")).toHaveText("포지션 핵심");
  await expect(page.getByTestId("choice-core-physical")).toBeVisible();
  await expect(page.getByTestId("choice-core-pace")).toHaveCount(0);

  await expect(page.getByTestId("reward-pick-later")).toBeVisible();
  await page.screenshot({ path: `${CAP_DIR}sheet-pick-390.png` });

  await page.getByTestId("choice-cand-tackling").click();
  const celebration = page.getByTestId("choice-celebration");
  await expect(celebration).toBeVisible();
  // 목업 화면 ④ — 알약 뱃지가 아니라 **큰 금색 LEVEL UP** + 스탯명 + `44.0 → 47.8 (+3.82)`.
  await expect(celebration).toContainText("LEVEL UP");
  await expect(celebration).toContainText("태클");
  const delta = page.getByTestId("choice-celebration-delta");
  await expect(delta).toHaveText("44.0 → 47.8 (+3.82)");
  // ⚠️ `toBeVisible()` 은 **opacity 를 안 본다** — 스태거가 너무 길면 줄이 뜨기 전에 오버레이가
  // 사라지는데도 계약은 초록이다(실제로 그 상태를 캡처가 잡았다). 실제로 보이는지 opacity 로 잰다.
  await expect
    .poll(async () => Number(await delta.evaluate((el) => getComputedStyle(el.parentElement!).opacity)))
    .toBeGreaterThan(0.9);
  await page.screenshot({ path: `${CAP_DIR}sheet-celebration-390.png` });
  // 크기·색은 `growth` 변이 전용 규칙이다 — 알약(작은 22px)으로 되돌아가면 여기서 죽는다.
  const title = celebration.locator('[class*="badge"]').first();
  expect(Number.parseFloat(await title.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThan(28);
  expect(await title.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
  expect(chosen).toEqual([["c-1", "tackling"]]);
  await expect(page.getByTestId("choice-applied")).toBeVisible();
  // 같은 경기에 남은 대기가 있으면 이어서 찍게 유도한다(한 판에 여러 레벨업이 날 수 있다).
  await expect(page.getByTestId("reward-remaining")).toContainText("선택 대기 2");
  await page.screenshot({ path: `${CAP_DIR}sheet-applied-390.png` });

  await page.getByTestId("reward-pick-next").click();
  await expect(page.getByTestId("choice-candidates")).toBeVisible();
  await expect(page.getByTestId("choice-gain-positioning")).toHaveText("+3.40");

  // 목록으로 돌아오면 뱃지가 줄어 있다 — 대기 수의 권위는 봉투 스냅샷이 아니라 조회다.
  await page.getByTestId("reward-pick-later").click();
  await expect(page.getByTestId("reward-tab-badge")).toHaveText("2");
  await expect(
    page.getByTestId("reward-section-GROWTH").getByTestId("growth-pending-P003"),
  ).toHaveText("선택 대기 1");
});

test("g. 폰·데스크탑 모두 문서 스크롤 0 + [확인] 이 화면 안 (#355)", async ({ page }) => {
  await mockApi(page);
  for (const vp of [PHONE, DESKTOP, { width: 1024, height: 640 }]) {
    await page.setViewportSize(vp);
    await page.goto(`/match/${MATCH_ID}`);
    await expect(page.getByTestId("reward-sheet")).toBeVisible();
    await page.getByTestId("reward-tab-GROWTH").click();
    await expect(page.getByTestId("reward-section-GROWTH").getByTestId("growth-bench-divider")).toBeAttached();
    await expectNoDocumentScroll(page);

    const cta = await page.getByTestId("reward-confirm").boundingBox();
    expect(cta, `CTA 박스 없음 @${vp.width}x${vp.height}`).not.toBeNull();
    expect(cta!.y + cta!.height, `[확인] 이 화면 밖 @${vp.width}x${vp.height}`).toBeLessThanOrEqual(vp.height);
    // 스크롤은 패널 안에만 — 목록이 길어도 시트 자체는 뷰포트를 안 넘는다.
    const sheet = await page.getByTestId("reward-sheet").boundingBox();
    expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(vp.height + 1);
    expect(sheet!.width).toBeLessThanOrEqual(vp.width + 1);
    await page.screenshot({ path: `${CAP_DIR}sheet-growth-${vp.width}x${vp.height}.png` });
  }
});

test("h. 확인 뒤에도 결과 화면에서 남은 선택으로 갈 문이 있다", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("result-page")).toBeVisible();

  const cta = page.getByTestId("growth-open-rewards");
  await expect(cta).toBeAttached();
  await cta.scrollIntoViewIfNeeded();
  await expect(cta).toContainText("선택 대기 3");
  await cta.click();
  await expect(page.getByTestId("reward-sheet")).toBeVisible();
  // 다시 연 시트는 **이미 확인된 봉투**다 — [확인]은 닫기일 뿐 ack 를 또 치지 않는다.
  await expect(page.getByTestId("reward-sheet")).toHaveAttribute("data-acknowledged", "1");
});


test("i. 근거를 못 만들면 줄을 생략한다 — 지어내지 않는다 (BASE · 부재 · 모르는 kind)", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await page.getByTestId("reward-tab-GROWTH").click();
  await page.getByTestId("reward-section-GROWTH").getByTestId("growth-row-P006").click();

  // c-3: passing = BEHAVIOR(있다) · technical = EVENT(있다) · shooting = 모르는 kind(없다)
  await expect(page.getByTestId("choice-why-passing")).toContainText('지시 "과감한 패스"');
  await expect(page.getByTestId("choice-why-technical")).toContainText("이 경기 패스 41회");
  await expect(page.getByTestId("choice-why-shooting")).toHaveCount(0);
  // 후보 카드 자체는 셋 다 멀쩡히 있다 — 줄만 없다(공허한 toHaveCount(0) 방지 앵커).
  await expect(page.getByTestId("choice-candidates").locator("button")).toHaveCount(3);
  await expect(page.getByTestId("choice-cand-shooting")).toBeVisible();

  // c-2 는 P003 의 **두 번째** 선택권이라 c-1 을 소진해야 도달한다 — `BASE`·`reason` 부재 표본.
  await page.getByTestId("reward-pick-later").click();
  await page.getByTestId("reward-section-GROWTH").getByTestId("growth-row-P003").click();
  await page.getByTestId("choice-cand-tackling").click();
  await page.getByTestId("reward-pick-next").click();

  await expect(page.getByTestId("choice-why-positioning")).toContainText("승리 보너스"); // RESULT
  await expect(page.getByTestId("choice-why-mental")).toHaveCount(0); // BASE
  await expect(page.getByTestId("choice-why-stamina")).toHaveCount(0); // reason 부재(구 행)
  await expect(page.getByTestId("choice-cand-mental")).toBeVisible(); // 카드는 멀쩡히 있다
});


test("j. 🚨 후보 순서는 **응답 그대로** — gain 순으로 재정렬하지 않는다 (#405, 서버 619d18b)", async ({ page }) => {
  mkdirSync(CAP_DIR, { recursive: true });
  await mockApi(page);
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await page.getByTestId("reward-tab-GROWTH").click();
  await page.getByTestId("reward-section-GROWTH").getByTestId("growth-row-P006").click();

  /*
   * 목 c-3 은 **gain 내림차순이 아니다**: passing 2.8 · technical 2.4 · shooting 2.9.
   * 서버가 `positionBaseline × gain` 으로 정렬했고 shooting 은 이 포지션에 OVR 기여가 없어 꼴찌다.
   * 클라가 gain 으로 다시 정렬하면 shooting 이 **1번 자리**로 올라온다 = 화면이 지는 선택을 유도한다.
   * 이 단언이 그 재정렬을 죽인다.
   */
  const order = await page
    .getByTestId("choice-candidates")
    .locator("button")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
  expect(order).toEqual(["choice-cand-passing", "choice-cand-technical", "choice-cand-shooting"]);

  // 그리고 그 꼴찌가 **가장 큰 gain** 이다 — 이 표본이 계약을 공허하지 않게 만드는 조건이다.
  await expect(page.getByTestId("choice-gain-shooting")).toHaveText("+2.90");
  await expect(page.getByTestId("choice-gain-passing")).toHaveText("+2.80");
  // 화면은 대신 `포지션 핵심` 으로 판단 근거를 준다(shooting 에는 없다).
  await expect(page.getByTestId("choice-core-passing")).toBeVisible();
  await expect(page.getByTestId("choice-core-shooting")).toHaveCount(0);
  await page.screenshot({ path: `${CAP_DIR}sheet-pick-order-390.png` });
});

test("k. `core` 키가 없는 구 박제분은 배지를 생략한다 — false 로 눕히지 않는다", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await page.getByTestId("reward-tab-GROWTH").click();
  // c-2 는 P003 의 두 번째 선택권 — c-1 을 소진해야 도달한다.
  await page.getByTestId("reward-section-GROWTH").getByTestId("growth-row-P003").click();
  await page.getByTestId("choice-cand-tackling").click();
  await page.getByTestId("reward-pick-next").click();

  // 후보 3장은 멀쩡히 있는데 배지만 0 개다(공허한 toHaveCount(0) 방지 앵커).
  await expect(page.getByTestId("choice-candidates").locator("button")).toHaveCount(3);
  await expect(page.getByTestId("choice-cand-positioning")).toBeVisible();
  await expect(page.getByTestId("choice-candidates").locator('[data-testid^="choice-core-"]')).toHaveCount(0);
});

/* ───────────────────────────────────────────────────────────────────────────────────────────
 * #405 ↔ #408 통합 — 미션 섹션이 보상 탭으로 들어온다 (요구 2 "모든 보상이 이 탭 구조를 쓴다")
 *
 * 🚨 이 묶음의 본체는 **`claim ≠ ack`** 다. 매치 재화·성장은 자동 지급이라 `[확인]`(ack)이
 * *"봤다"* 로 충분하지만, 미션은 **`[받기]` 를 눌러야 지급**된다. 그냥 합치면 유저가
 * *"확인 눌렀으니 다 받았겠지"* 하고 미수령분을 지나치는데 그건 **실제 손실**이다.
 * ─────────────────────────────────────────────────────────────────────────────────────────── */

test("l. 미션이 실려 오면 **보상 탭**에 미션 섹션이 뜬다 — 결과 화면에는 없다(이중 렌더 금지)", async ({ page }) => {
  mkdirSync(CAP_DIR, { recursive: true });
  await mockApi(page, { missions: [mission(), mission({ id: "MS2", title: "원정 3회", progress: 1, target: 3, completedNow: false, state: "IN_PROGRESS" })] });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);

  // ⚠️ `evaluateAll` 은 **기다리지 않는다** — 시트가 붙기 전에 재면 빈 배열이 나와 계약이
  // 자기가 못 본 것을 단언한다. 앵커를 먼저 세운다.
  await expect(page.getByTestId("reward-tab-MISSION")).toBeVisible();

  // 재화·성장 뒤 세 번째 탭(order 30) — 순서가 화면마다 달라지면 근육기억이 깨진다.
  const tabs = await page.locator('[data-testid^="reward-tab-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid")).filter((t) => t !== "reward-tab-badge"),
  );
  expect(tabs).toEqual(["reward-tab-CURRENCY", "reward-tab-GROWTH", "reward-tab-MISSION"]);

  await page.getByTestId("reward-tab-MISSION").click();
  const section = page.getByTestId("result-missions");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("result-mission")).toHaveCount(2);
  // 금액은 서버 표기 메타를 따라온다(#232) — 섹션이 옮겨져도 그 규율은 그대로.
  await expect(section.locator('[data-mission-id="MS1"] [data-currency]')).toHaveAttribute("data-amount", "222");
  await page.screenshot({ path: `${CAP_DIR}sheet-mission-390.png` });

  // 다 받고 나서 결과 화면으로 — 미션 섹션이 **양쪽에 있으면 안 된다**.
  await page.locator('[data-mission-id="MS1"]').getByTestId("result-mission-claim").click();
  await expect(page.locator('[data-mission-id="MS1"]')).toHaveAttribute("data-state", "CLAIMED");
  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("result-page")).toBeVisible();
  await expect(page.getByTestId("result-missions")).toHaveCount(0);
  await page.screenshot({ path: `${CAP_DIR}result-no-mission-390.png` });
});

test("m. 🚨 미수령 미션이 있으면 [확인]이 **조용히 ack 하지 않는다**", async ({ page }) => {
  mkdirSync(CAP_DIR, { recursive: true });
  const acks: string[] = [];
  await mockApi(page, { missions: [mission()], onAck: (id) => acks.push(id) });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("reward-sheet")).toBeVisible();

  // ① 누르기 **전에** 이미 경고가 서 있다 — 사후 통보가 아니라 경고다.
  const warn = page.getByTestId("reward-unclaimed");
  await expect(warn).toBeVisible();
  await expect(warn).toHaveAttribute("data-count", "1");
  await expect(warn).toHaveAttribute("data-armed", "0");
  await expect(warn).toContainText("받지 않은 미션 1개");
  // 막다른 경고 금지 — 지금 안 받아도 어디서 받는지 말한다.
  await expect(page.getByTestId("reward-unclaimed-hint")).toContainText("원정 화면");
  // ⚠️ `toBeVisible()` 은 opacity 를 안 본다(#405 f 의 교훈) — 실제로 읽히는지 computed 로 잰다.
  await expect
    .poll(async () => Number(await warn.evaluate((el) => getComputedStyle(el).opacity)))
    .toBeGreaterThan(0.9);

  // ② 첫 [확인] — ack 가 나가지 않고 시트도 안 닫힌다. 미션 탭으로 데려간다.
  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("reward-sheet")).toBeVisible();
  await expect(page.getByTestId("reward-sheet")).toHaveAttribute("data-acknowledged", "0");
  await expect(page.getByTestId("result-missions")).toBeVisible();
  await expect(warn).toHaveAttribute("data-armed", "1");
  await expect(page.getByTestId("reward-confirm")).toHaveText("받지 않고 확인");
  expect(acks, "미수령이 남았는데 ack 가 나갔다 = 유저가 모르고 지나친다").toEqual([]);
  await page.screenshot({ path: `${CAP_DIR}sheet-mission-armed-390.png` });

  // ③ 두 번째 [확인] — "알고 넘어간다". 막지는 않는다(놓쳐도 기한 없이 남는다).
  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("result-page")).toBeVisible();
  expect(acks).toEqual(["B405"]);
});

test("n. 미션을 다 받으면 경고가 사라지고 [확인] **한 번**에 넘어간다", async ({ page }) => {
  const acks: string[] = [];
  const claims: string[] = [];
  await mockApi(page, { missions: [mission()], onAck: (id) => acks.push(id), onClaim: (id) => claims.push(id) });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);

  await page.getByTestId("reward-tab-MISSION").click();
  await page.locator('[data-mission-id="MS1"]').getByTestId("result-mission-claim").click();
  await expect(page.locator('[data-mission-id="MS1"]')).toHaveAttribute("data-state", "CLAIMED");
  expect(claims).toEqual(["MS1"]);

  // 받을 것이 없으니 경고도 없고 확인 단계도 하나다 — 가드가 영원히 남으면 그게 새 결함이다.
  await expect(page.getByTestId("reward-unclaimed")).toHaveCount(0);
  await expect(page.getByTestId("reward-confirm")).toHaveText("확인");
  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("result-page")).toBeVisible();
  expect(acks).toEqual(["B405"]);
});

test("o. 미션이 없으면 **탭도 섹션도 안 생긴다** — 진행 중만 있으면 [확인]도 안 막는다", async ({ page }) => {
  const acks: string[] = [];

  // (1) 원정이 아닌 경기 = `missions` 블록 자체가 없다 → 탭 2개 그대로(회귀 0).
  await mockApi(page, { onAck: (id) => acks.push(id) });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("reward-sheet")).toBeVisible();
  await expect(page.getByTestId("reward-tab-MISSION")).toHaveCount(0);
  await expect(page.getByTestId("result-missions")).toHaveCount(0);
  await expect(page.getByTestId("reward-unclaimed")).toHaveCount(0);
  // 앵커 — 탭 구조 자체는 살아 있다(공허한 toHaveCount(0) 방지).
  await expect(page.getByTestId("reward-tab-GROWTH")).toBeVisible();
  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("result-page")).toBeVisible();
  expect(acks, "미션이 없는데 [확인]이 막혔다 = 기존 흐름 회귀").toEqual(["B405"]);
});

test("o2. 손상된 missions / 빈 배열에도 빈 탭이 생기지 않는다", async ({ page }) => {
  // ⚠️ `isPresent` 와 섹션 컴포넌트의 null 조건이 갈리면 여기서 **탭은 있는데 안이 빈** 상태가 뜬다.
  for (const missions of [[], { nope: true }, [{ noId: 1 }], "x"]) {
    await page.context().clearCookies();
    await mockApi(page, { missions });
    await page.setViewportSize(PHONE);
    await page.goto(`/match/${MATCH_ID}`);
    await expect(page.getByTestId("reward-sheet")).toBeVisible();
    await expect(page.getByTestId("reward-tab-MISSION")).toHaveCount(0);
    await expect(page.getByTestId("reward-tab-GROWTH")).toBeVisible(); // 앵커
  }
});

test("p. 미수령이 있어도 진행 중 미션만이면 안 막는다 — `progress>=target` 재계산 변이체 킬", async ({ page }) => {
  const acks: string[] = [];
  await mockApi(page, {
    // 둘 다 진행도는 목표에 닿았지만 서버 state 는 아니다 → 받을 것이 없다.
    missions: [
      mission({ id: "A", state: "IN_PROGRESS", progress: 2, target: 2, completedNow: false }),
      mission({ id: "B", state: "CLAIMED", progress: 2, target: 2, completedNow: false }),
    ],
    onAck: (id) => acks.push(id),
  });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);
  // 탭은 생긴다(그릴 줄이 있다) — 하지만 경고는 없다.
  await expect(page.getByTestId("reward-tab-MISSION")).toBeVisible();
  await expect(page.getByTestId("reward-unclaimed")).toHaveCount(0);
  await page.getByTestId("reward-confirm").click();
  await expect(page.getByTestId("result-page")).toBeVisible();
  expect(acks).toEqual(["B405"]);
});

test("q. 봉투가 없는 매치(구 정산)는 **결과 화면**이 미션을 그린다 — 시트가 없으니 유일한 자리다", async ({ page }) => {
  mkdirSync(CAP_DIR, { recursive: true });
  await mockApi(page, { noBundle: true, missions: [mission()] });
  await page.setViewportSize(PHONE);
  await page.goto(`/match/${MATCH_ID}`);

  await expect(page.getByTestId("result-page")).toBeVisible();
  await expect(page.getByTestId("reward-sheet")).toHaveCount(0);
  const section = page.getByTestId("result-missions");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("result-mission-claim")).toBeEnabled();
  await page.screenshot({ path: `${CAP_DIR}result-mission-nobundle-390.png`, fullPage: true });
});
