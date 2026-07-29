import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * 재화 표기 계약 (#232) — **서버 주도인가**를 강제한다.
 *
 * 이 스펙의 핵심은 "화면에 G 가 뜨는가"가 아니다. 그건 하드코딩으로도 통과한다(그리고 P→G 로
 * 문자열만 바꾼 구현이 정확히 그렇게 통과할 것이다). 그래서 **서버가 준 표기를 이상한 값으로
 * 바꿔 놓고**(Ω/Ξ) 화면이 따라오는지 본다 — 어딘가에 심볼이 박혀 있으면 여기서 죽는다.
 *
 * 같이 지키는 것:
 * - **금지 문자열 0**: 구 표기("포인트"·"젬"·"💎"·단위 "P")가 어느 화면에도 남아 있지 않다.
 * - **오탐 가드**: 카드 **등급** 라벨("골드"·"다이아")은 살아 있어야 한다. 재화 이름과 글자가
 *   겹치므로(hero 확정 C1) 등급까지 지우면 다른 기능을 부순 것이다.
 * - **폴백**: config 를 못 받아도 흰 화면이 아니고, 하드코딩 "P" 로 되돌아가지도 않는다.
 * - **금액↔재화 결속**: 뽑기 게이팅이 결제 재화 잔액을 따른다(#213 의 실체).
 *
 * 백엔드 없이 vite dev + page.route 목킹으로 돈다. 라우트는 pathname 앵커
 * (글롭 '**\/api/**' 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면이 된다 — 프로젝트 기지식).
 */

const POINTS = 62_000;
const GEMS = 6_000;

/** 기본값·운영값 어느 쪽과도 겹치지 않는 표기 — "따라왔다"가 우연일 수 없게. */
const ODD = { pointSymbol: "Ω", pointName: "오메가", gemSymbol: "Ξ", gemName: "크시" } as const;

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const ME = {
  user: { id: "U1", nickname: "테스터", provider: "guest", isAdmin: false, tutorialDone: true },
  wallet: { points: POINTS, gems: GEMS },
  records: { played: 12, wins: 7, draws: 2, losses: 3 },
};

const attrs = {
  technical: 74, mental: 68, physical: 80, passing: 71, shooting: 85,
  tackling: 55, pace: 82, stamina: 70, positioning: 77,
};
const PLAYERS = [
  { id: "P011", name: "내 윙어", position: "FW", grade: "GOLD", owned: true, ownedCount: 3, attributes: attrs, personality: "FIERY" },
  { id: "P042", name: "FA 스트라이커", position: "FW", grade: "DIA", owned: false, ownedCount: 0, attributes: attrs, personality: "AMBITIOUS" },
];

/** #247: 잠재 재설정 비용 표기를 보려면 강화 상세가 열려야 한다 — 2★(잠재 해금) 카드 목. */
const OWNED_ID = "P011";
const CARD = {
  playerId: OWNED_ID,
  grade: "GOLD",
  star: 2,
  attributes: attrs,
  prePotential: attrs,
  base: attrs,
  caps: attrs,
  statLevels: Object.fromEntries(Object.keys(attrs).map((k) => [k, { lv: 0, xp: 0 }])),
  potential: {
    unlocked: true,
    tier: "RARE",
    maxTier: "EPIC",
    lines: [{ slot: 1, tier: "RARE", type: "STAT_PCT", stat: "shooting", value: 3 }],
    rollsSinceTierUp: 1,
    ceilingAt: 9,
  },
  ovr: 74,
  completion: 0.3,
};

const TRADE = {
  wallet: { points: POINTS },
  slots: [
    {
      slot: 1, state: "WAITING", offerKind: "FA", target: null, demand: null, targetGrade: "GOLD",
      opensAt: "2026-07-28T12:00:00Z", remainingSec: 3_600,
      // 서버가 금액과 재화를 **같이** 준다(#232).
      speedupCost: 500, speedupCurrency: "POINT",
    },
  ],
};

const LEAGUE = {
  season: {
    id: "S1", seasonNo: 1, state: "FINISHED",
    teams: [{ teamId: "me", name: "내 팀", isUser: true, persona: null, power: null }],
    standings: [
      { teamId: "me", name: "내 팀", played: 18, won: 14, drawn: 2, lost: 2, goalsFor: 45, goalsAgainst: 15, goalDiff: 30, points: 44, rank: 1, isUser: true },
    ],
    fixtures: [], nextUserFixture: null,
    seasonReward: { rank: 1, points: 100_000, gems: 2_400, status: "AWARDED", awardedAt: "2026-07-28T09:00:00Z" },
  },
};

/** 트레이드 로그 행이 재화 태그를 그린다(FA 제안에 함께 낸 금액). */
const TRADE_LOGS = [
  {
    id: "t1", kind: "FA", result: "SUCCESS", createdAt: "2026-07-28T08:00:00Z",
    detail: { target: { name: "FA 스트라이커" }, points: 5_000 },
  },
];

type Opts = Parameters<typeof mockAppConfig>[1];

async function mockApi(page: Page, configOpts: Opts = ODD, configStatus: "ok" | "fail" = "ok") {
  await page.route((u) => u.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  const at = (path: string, body: unknown) =>
    page.route((u) => u.pathname === path, (r) => r.fulfill(json(body)));
  await at("/api/me", ME);
  await at("/api/players", PLAYERS);
  await at("/api/trade", TRADE);
  await at("/api/league", LEAGUE);
  await at("/api/logs/matches", []);
  await at("/api/logs/trades", TRADE_LOGS);
  await at(`/api/growth/card/${OWNED_ID}`, CARD);
  await at("/api/me/active-match", { match: null, locked: false, abandonable: false });
  await at("/api/deck", { formation: "4-3-3", slots: [], bench: [] });
  if (configStatus === "fail") {
    await page.route((u) => u.pathname === "/api/config", (r) => r.fulfill({ status: 500, body: "" }));
  } else {
    await mockAppConfig(page, configOpts);
  }
}

async function boot(page: Page, path: string, configOpts: Opts = ODD, configStatus: "ok" | "fail" = "ok") {
  await mockApi(page, configOpts, configStatus);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
    localStorage.setItem("hmb.tutorial.done", "1");
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(path);
}

/** 화면에 실제로 렌더된 텍스트(스크립트·스타일 제외). */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

/**
 * 구 표기 금지 목록. "P" 는 단독 단위로 쓰였을 때만 잡는다 — 닉네임·팀명에 P 가 섞이는 것까지
 * 막으면 오탐이 나고, 사고의 형태는 언제나 "숫자 뒤에 붙은 단위"였다.
 *
 * ⚠️ **💎 는 금지 대상이 아니다.** 그건 유상재화의 **아이콘**이고 서버 표기 메타가 내려준다
 * (`● 62,000 G` / `💎 6,000 Z` 로 대칭). 문제였던 것은 이모지 자체가 아니라 **단위가 없던 것**
 * (`💎 6,000` 옆에 `62,000 P`)이고, 그건 화면별 심볼 단언이 잡는다. 아이콘을 금지어로 두면
 * 목만 다른 이모지를 쓰게 되고 계약이 실제 배포 화면을 검사하지 않게 된다.
 */
const FORBIDDEN_UNIT_P = /\d[\d,]*\s*P(?![a-zA-Z가-힣])/;

async function expectNoLegacyCurrencyText(page: Page, where: string) {
  const text = await visibleText(page);
  expect(text, `${where}: 구 재화 이름(포인트)`).not.toContain("포인트");
  expect(text, `${where}: 구 재화 이름(젬)`).not.toContain("젬");
  expect(text, `${where}: 구 단위 표기(P)`).not.toMatch(FORBIDDEN_UNIT_P);
}

// ── 변이체 킬: 서버가 준 표기를 화면이 따라오는가 ─────────────────────────

test("지갑 배지가 서버 표기를 따른다 (하드코딩이면 실패)", async ({ page }) => {
  await boot(page, "/lobby");
  const wallet = page.getByTestId("points-badge");
  await expect(wallet).toContainText(ODD.pointSymbol);
  await expect(wallet).toHaveAttribute("data-points", String(POINTS));
  await expect(page.getByTestId("wallet-gems")).toContainText(ODD.gemSymbol);
  await expectNoLegacyCurrencyText(page, "로비");
});

test("상점 뽑기 가격·부족 문구가 서버 표기·서버 가격을 따른다", async ({ page }) => {
  await boot(page, "/shop", { ...ODD, gachaSingleCost: 777 });
  // 가격도 서버가 준 값이다 — 클라 상수(300)가 남아 있으면 여기서 죽는다.
  await expect(page.getByTestId("gacha-single")).toContainText("777");
  await expect(page.getByTestId("gacha-single")).toContainText(ODD.gemSymbol);
  await expectNoLegacyCurrencyText(page, "상점/뽑기");
});

/**
 * #247: 다이스는 상점에서 사지 않는다 — 잠재 재설정 **비용**이 강화 상세 버튼에 붙는다.
 * 가격 출처는 그대로 서버 config(`shop.dice`)이므로 이 계약도 그대로 따라 옮겼다
 * (구 미러 상수 500 이 되살아나면 여기서 죽는다).
 */
test("잠재 재설정 비용이 서버 config 를 따른다 (구 미러 상수 500 이 아니다)", async ({ page }) => {
  await boot(page, "/growth");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  const normal = page.getByTestId("growth-dice-normal-price");
  await expect(normal).toContainText("5,000");
  await expect(normal).toContainText(ODD.pointSymbol);
  await expect(page.getByTestId("growth-dice-cash-price")).toContainText(ODD.gemSymbol);
  await expectNoLegacyCurrencyText(page, "강화/잠재 재설정");
});

test("트레이드 단축 비용이 서버가 준 재화로 표기된다", async ({ page }) => {
  await boot(page, "/trade");
  const cost = page.getByText("단축 비용");
  await expect(cost).toContainText("500");
  await expect(cost).toContainText(ODD.pointSymbol);
  await expectNoLegacyCurrencyText(page, "트레이드");
});

test("리그 시즌 보상이 서버 표기를 따르고, 우승 유상재화도 화면에 뜬다", async ({ page }) => {
  await boot(page, "/league");
  await expect(page.getByTestId("season-reward-points")).toContainText(ODD.pointSymbol);
  // #212 가 지급하는데 화면에 아예 없던 재화 — 표기 갭이 메워졌는지 본다(연출은 #214).
  const gems = page.getByTestId("season-reward-gems");
  await expect(gems).toHaveAttribute("data-gems", "2400");
  await expect(gems).toContainText(ODD.gemSymbol);
  await expectNoLegacyCurrencyText(page, "리그");
});

test("로그(트레이드) 금액 태그가 서버 표기를 따른다", async ({ page }) => {
  await boot(page, "/logs");
  await page.getByTestId("logs-tab-trades").click();
  await expect(page.getByTestId("trade-log-t1")).toContainText(`5,000 ${ODD.pointSymbol}`);
  await expectNoLegacyCurrencyText(page, "로그");
});

test("가입 연출이 지급액·재화를 서버에서 받아 그린다 — 받은 재화를 빠뜨리지 않는다", async ({ page }) => {
  // 예전엔 클라 상수 3,000 을 "P"로 그리고 유상재화 지급은 **표기조차 없었다**(리그 우승과 같은 형태).
  // 운영이 무배포 override 로 지급액을 올린 이력이 있어(#209) 상수는 이미 틀린 값이었다.
  await mockApi(page, { ...ODD, initialPoints: 4_321, initialGems: 12_000 });
  await page.route((u) => u.pathname === "/api/auth/login", (r) =>
    r.fulfill(json({ token: "mock-token", user: { id: "U1", nickname: "테스터" }, isNew: true })),
  );
  await page.route((u) => u.pathname === "/api/me/starter-grant", (r) =>
    r.fulfill(json({ granted: false, player: null })),
  );

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/login");
  await page.getByTestId("provider-guest").click();
  await page.locator("#nickname").fill("테스터");
  await page.getByRole("button", { name: "계속" }).click();

  const reveal = page.getByTestId("starter-reveal");
  await expect(reveal).toBeVisible();
  await expect(reveal).toContainText(`4,321 ${ODD.pointSymbol}`);
  await expect(reveal).toContainText(`12,000 ${ODD.gemSymbol}`);
});

// ── 오탐 가드: 등급 라벨은 재화가 아니다 ────────────────────────────────

test("카드 등급 라벨(골드/다이아)은 그대로 산다 — 재화 이름과 겹쳐도 지우면 안 된다", async ({ page }) => {
  await boot(page, "/trade");
  // 트레이드 WAITING 은 등급만 공개한다 — 여기 "골드"는 재화가 아니라 **등급**이다.
  await expect(page.getByTestId("trade-slot-1-grade")).toContainText("골드");
});

// ── 금액↔재화 결속 (#213 의 실체) ────────────────────────────────────────

test("뽑기 게이팅이 결제 재화 잔액을 따른다 — 유상재화로 사는데 무료재화로 잠그지 않는다", async ({ page }) => {
  // 유상재화 잔액(6,000)으로는 살 수 있고 무료재화 잔액과는 무관한 가격.
  await boot(page, "/shop", { ...ODD, gachaCurrency: "GEM", gachaSingleCost: 5_000 });
  await expect(page.getByTestId("gacha-single")).toBeEnabled();

  // 유상재화 잔액을 넘는 가격이면 잠긴다 — 무료재화 62,000 이 있어도.
  await boot(page, "/shop", { ...ODD, gachaCurrency: "GEM", gachaSingleCost: 20_000 });
  await expect(page.getByTestId("gacha-single")).toBeDisabled();
  await expect(page.getByText(`${ODD.gemName}가 부족합니다`)).toBeVisible();
});

test("충전 탭은 서버 플래그를 따른다 — 비활성이면 죽은 버튼을 그리지 않는다", async ({ page }) => {
  await boot(page, "/shop", { ...ODD, topupEnabled: false });
  await expect(page.getByTestId("shop-tab-topup")).toHaveCount(0);
  // 탭이 없으면 충전 섹션도 어디에도 없다 (#247 로 [다이스] 탭이 사라져 진입로가 하나뿐이다).
  await expect(page.getByTestId("gem-topup-section")).toHaveCount(0);

  await boot(page, "/shop", { ...ODD, topupEnabled: true });
  await expect(page.getByTestId("shop-tab-topup")).toBeVisible();
});

// ── 로그인 전이 (독립검증 BL-1 이 살던 자리) ─────────────────────────────

/**
 * **토큰을 미리 심지 않고** 로그인 화면부터 시작한다.
 *
 * 이 스펙의 다른 테스트들이 전부 `localStorage` 에 토큰을 넣고 시작했기 때문에, 앱이 부팅 시
 * config 를 **인증 없이 한 번** 부르고 그게 401 로 죽으면 세션 내내 폴백이 된다는 사실을 아무도
 * 못 봤다(신규·세션만료 유저의 첫 진입이 전부 그 경로다). 로그인 **전이**를 실제로 지나야 잡힌다.
 */
test("로그아웃 상태로 부팅해 로그인해도 표기가 살아 있다", async ({ page }) => {
  await mockApi(page, ODD);
  await page.route((u) => u.pathname === "/api/auth/login", (r) =>
    r.fulfill(json({ token: "mock-token", user: { id: "U1", nickname: "테스터" }, isNew: false })),
  );
  const configCalls: number[] = [];
  page.on("response", (res) => {
    if (new URL(res.url()).pathname === "/api/config") configCalls.push(res.status());
  });

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/login");
  await page.getByTestId("provider-guest").click();
  await page.locator("#nickname").fill("테스터");
  await page.getByRole("button", { name: "계속" }).click();

  const wallet = page.getByTestId("points-badge");
  await expect(wallet).toBeVisible();
  await expect(wallet).toContainText(ODD.pointSymbol);
  // 코드가 노출되면 = config 를 못 받은 것. 이게 BL-1 의 화면이었다.
  await expect(wallet).not.toContainText("POINT");
  expect(configCalls, "config 응답이 하나도 200 이 아니다").toContain(200);
});

// ── 폴백 ────────────────────────────────────────────────────────────────

test("config 조회 실패 — 흰 화면 0 · 하드코딩 P 로 되돌아가지 않는다", async ({ page }) => {
  await boot(page, "/lobby", ODD, "fail");
  // 화면은 뜬다.
  await expect(page.getByTestId("points-badge")).toBeVisible();
  const text = await visibleText(page);
  expect(text.length).toBeGreaterThan(20);
  // 표기를 모르면 **코드를 그대로** 노출한다 — 못생겼지만 거짓말은 아니고, 눈에 띄어 썩지 않는다.
  await expect(page.getByTestId("points-badge")).toContainText("POINT");
  await expectNoLegacyCurrencyText(page, "config 실패 폴백");
});
