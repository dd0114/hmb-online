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
    candidates: [
      { stat: "tackling", gain: 3.82 },
      { stat: "physical", gain: 3.11 },
      { stat: "pace", gain: 2.45 },
    ],
  },
  {
    choiceId: "c-2",
    playerId: "P003",
    level: 12,
    candidates: [
      { stat: "positioning", gain: 3.4 },
      { stat: "mental", gain: 2.9 },
      { stat: "stamina", gain: 2.2 },
    ],
  },
  {
    choiceId: "c-3",
    playerId: "P006",
    level: 8,
    candidates: [
      { stat: "passing", gain: 2.8 },
      { stat: "technical", gain: 2.4 },
      { stat: "shooting", gain: 1.9 },
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

interface MockOpts {
  /** 봉투 자체를 안 준다(W2b 이전 매치). */
  noBundle?: boolean;
  /** 이미 확인한 봉투. */
  acknowledged?: boolean;
  /** 재화 섹션을 비운다(§2.9.1 `isPresent` — 탭이 사라지는지). */
  currencyEmpty?: boolean;
  /** ack 호출 기록기. */
  onAck?: (bundleId: string) => void;
  /** 선택 적용 기록기. */
  onChoose?: (choiceId: string, stat: string) => void;
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
      rewardBundle: opts.noBundle
        ? null
        : { ...bundle({ acknowledgedAt: acked ? "2026-08-02T01:00:00Z" : null }), sections },
    }));
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
  await expectNoDocumentScroll(page);
  await page.screenshot({ path: `${CAP_DIR}sheet-growth-390.png` });
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
  await expect(page.getByTestId("reward-pick-later")).toBeVisible();
  await page.screenshot({ path: `${CAP_DIR}sheet-pick-390.png` });

  await page.getByTestId("choice-cand-tackling").click();
  await expect(page.getByTestId("choice-celebration")).toBeVisible();
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
