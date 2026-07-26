import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * G4 성장 시스템 v2(메이플 피벗 + V2.1 피드백 개정 + 레이더 후속) UI route-mock 스모크(에픽 #179
 * GM3/GM7, §V2-6/V2-7 AC-V6 + §V2.1-3) — **백엔드 없이** vite dev + page.route 로 /api 목킹. 계약 박제:
 * (1) 카드 상세 렌더 — ★·스탯Lv·잠재 3줄(전줄 동일 티어, V2.1-1)·능력치 2레이어 토글([레이더(기본)]
 * SVG 폴리곤 6축+멘탈 칩+밴드 앵커 윈도우 라벨 / [막대] 윈도우 정규화 width+축 라벨,
 * hero 실시간 지시로 "+보너스" 분해 탭은 제거),
 * (2) 성 승급 → ★+1·잠재 해금·패널/프레임 티어 글로우, (3) 다이스 롤 → 라인 갱신·티어업 전체
 * 오버레이(V2.1-3), (4) 다이스 부족 4xx 메시지, (5) 390px 오버플로 0,
 * (6) 성장 리포트(S1) 스탯별 XP 막대 + 레벨업 뱃지.
 * 스펙 지정·대체포트(playwright.config PORT=5199, :8080 데모·5301 무접촉)·pathname 매칭(glob 아님).
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const err = (status: number, code: string, message: string) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ code, message }),
});

// GOLD 등급 카드로 고정 — linesByGrade G:2(잠재 2줄), gradeTierCap G:EPIC(RARE→EPIC 티어업 데모 가능).
const OWNED_ID = "P001";
const attrs = {
  technical: 44, mental: 41, physical: 40, passing: 42, shooting: 55,
  tackling: 30, pace: 60, stamina: 43, positioning: 45,
};
const caps = {
  technical: 70, mental: 68, physical: 65, passing: 69, shooting: 80,
  tackling: 55, pace: 82, stamina: 66, positioning: 71,
};
function statLevels(bump: number) {
  const out: Record<string, { lv: number; xp: number }> = {};
  for (const k of Object.keys(attrs)) out[k] = { lv: bump, xp: 20 };
  return out;
}
const PLAYERS_RESPONSE = [
  { id: OWNED_ID, name: "양민혁", position: "FW", grade: "GOLD", owned: true, ownedCount: 6, attributes: attrs },
  { id: "P099", name: "잠금 선수", position: "DF", grade: "GOLD", owned: false, ownedCount: 0, attributes: attrs },
];

// V2.2 재화 이원화(hero 확정 2026-07-26) — wallet 에 gems additive. 기본 50젬(캐시 다이스 5개분).
const ME_RESPONSE = {
  user: { id: "u1", nickname: "내 팀" },
  wallet: { points: 20000, gems: 50 },
  records: { wins: 0, draws: 0, losses: 0 },
};

// gems.topupPacks (economy.v2.json 미러) — 젬 충전(목업) 3종.
const GEM_TOPUP_PACKS = [
  { id: "p1", gems: 60, mockPrice: "₩1,200" },
  { id: "p2", gems: 330, mockPrice: "₩5,900" },
  { id: "p3", gems: 720, mockPrice: "₩11,900" },
];

async function seedAuth(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
}

interface GrowthMockOpts {
  /** POST /api/growth/dice 를 항상 이 코드로 4xx 실패시킨다(다이스 부족 시나리오 전용). */
  diceAlwaysFails?: boolean;
  /** 초기 젬 잔고(기본 ME_RESPONSE.wallet.gems) — 젬 부족 시나리오 전용으로 낮춰 넘긴다. */
  gems?: number;
  /**
   * POST /api/shop/dice(CASH) 를 잔고와 무관하게 항상 INSUFFICIENT_GEMS 로 실패시킨다 — 서버
   * 권위 검증(클라 가드를 우회해도 서버가 최종 게이트) 시나리오 전용, growth/dice 의
   * diceAlwaysFails 와 동일한 패턴.
   */
  cashDiceAlwaysFailsGems?: boolean;
}

/**
 * 성장 카드/성/다이스/상점 목 — 상태ful. star-up 마다 star++·잠재 해금, dice 마다 lines 갱신
 * (2회차에 RARE→EPIC 티어업), shop/dice 구매마다 diceBalance++. V2.2: /api/me·shop/dice 가
 * 살아있는 gems 잔고를 공유(젬 충전·캐시 다이스 구매가 서로 반영되도록).
 */
async function mockGrowth(page: Page, opts: GrowthMockOpts = {}) {
  let star = 1;
  let statBump = 0;
  let potentialUnlocked = false;
  let tier: "RARE" | "EPIC" | "UNIQUE" = "RARE";
  let rollsSinceTierUp = 0;
  let diceNormal = 0;
  let diceCash = 0;
  let rollCount = 0;
  let gems = opts.gems ?? ME_RESPONSE.wallet.gems;

  // V2.1-1: 전줄 동일 티어 — 모든 줄이 카드 잠재 티어를 그대로 따른다(구 "2줄=한 단계 아래" 폐기).
  function lines() {
    if (!potentialUnlocked) return [];
    return [
      { slot: 1, tier, type: "STAT_PCT" as const, stat: "shooting", value: 3 },
      { slot: 2, tier, type: "STAT_FLAT" as const, stat: "pace", value: 2 },
    ];
  }

  // catch-all 먼저(구체 라우트가 나중에 우선). pathname 매칭 — glob '**/api/**' 는 vite 소스까지 잡음.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({ ...ME_RESPONSE, wallet: { points: ME_RESPONSE.wallet.points, gems } })),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS_RESPONSE)));

  await page.route(
    (url) => url.pathname === `/api/growth/card/${OWNED_ID}`,
    (route) => {
      const cur: Record<string, number> = {};
      for (const [k, v] of Object.entries(attrs)) cur[k] = Math.min(caps[k as keyof typeof caps], v + statBump);
      route.fulfill(
        json({
          playerId: OWNED_ID,
          grade: "GOLD",
          star,
          attributes: cur,
          prePotential: cur,
          base: attrs,
          caps,
          statLevels: statLevels(statBump > 0 ? 1 : 0),
          potential: {
            unlocked: potentialUnlocked,
            tier,
            maxTier: "EPIC",
            lines: lines(),
            rollsSinceTierUp,
            ceilingAt: 9,
          },
          ovr: 58 + statBump,
          completion: Math.min(1, 0.3 + statBump * 0.05),
        }),
      );
    },
  );

  await page.route(
    (url) => url.pathname === "/api/growth/star",
    (route) => {
      if (star >= 4) {
        route.fulfill(err(409, "INSUFFICIENT_MATERIALS", "성 최대"));
        return;
      }
      star += 1;
      if (star === 2) potentialUnlocked = true;
      route.fulfill(
        json({ playerId: OWNED_ID, star, spentCopies: star === 2 ? 2 : star === 3 ? 3 : 5, potentialUnlocked: star === 2, maxTier: "EPIC" }),
      );
    },
  );

  await page.route(
    (url) => url.pathname === "/api/growth/dice",
    (route) => {
      // GET = 잔액 조회(DiceBalance, GM2 계약) / POST = 롤.
      if (route.request().method() === "GET") {
        // 잔액은 항상 있음 — 부족 시나리오는 POST 4xx(서버 권위)로 검증한다(버튼 활성 유지).
        route.fulfill(json({ normal: 5, cash: 3 }));
        return;
      }
      if (opts.diceAlwaysFails) {
        route.fulfill(err(409, "INSUFFICIENT_DICE", "다이스 부족"));
        return;
      }
      const body = route.request().postDataJSON() as { kind: "NORMAL" | "CASH" };
      rollCount += 1;
      statBump += 1;
      const tierBefore = tier;
      let tierUp = false;
      if (body.kind === "NORMAL") {
        rollsSinceTierUp += 1;
        if (rollCount >= 2 && tier === "RARE") {
          tier = "EPIC";
          tierUp = true;
          rollsSinceTierUp = 0;
        }
        diceNormal = Math.max(0, diceNormal - 1);
      } else {
        diceCash = Math.max(0, diceCash - 1);
      }
      route.fulfill(
        json({
          playerId: OWNED_ID,
          kind: body.kind,
          tierBefore,
          tierAfter: tier,
          tierUp,
          byCeiling: false,
          lines: lines(),
          rollsSinceTierUp,
          ceilingAt: 9,
          diceLeft: body.kind === "NORMAL" ? diceNormal : diceCash,
        }),
      );
    },
  );

  await page.route(
    (url) => url.pathname === "/api/shop/dice",
    (route) => {
      const body = route.request().postDataJSON() as { kind: "NORMAL" | "CASH"; count: number };
      // V2.2: NORMAL=P 결제(기존, 미추적) / CASH=젬 결제(10젬/개, 서버 권위로 잔고 검증).
      if (body.kind === "CASH") {
        const cost = 10 * body.count;
        if (opts.cashDiceAlwaysFailsGems || gems < cost) {
          route.fulfill(err(400, "INSUFFICIENT_GEMS", "젬이 부족합니다"));
          return;
        }
        gems -= cost;
        diceCash += body.count;
      } else {
        diceNormal += body.count;
      }
      route.fulfill(
        json({
          kind: body.kind,
          count: body.count,
          dice: { normal: diceNormal, cash: diceCash },
          wallet: { points: ME_RESPONSE.wallet.points - (body.kind === "NORMAL" ? 500 : 0), gems },
        }),
      );
    },
  );

  await page.route(
    (url) => url.pathname === "/api/shop/gems/topup",
    (route) => {
      const body = route.request().postDataJSON() as { packId: string };
      const pack = GEM_TOPUP_PACKS.find((p) => p.id === body.packId);
      const granted = pack?.gems ?? 0;
      gems += granted;
      route.fulfill(
        json({
          packId: body.packId,
          granted,
          wallet: { points: ME_RESPONSE.wallet.points, gems },
        }),
      );
    },
  );
}

test("G4 도감 성장 상세: ★·스탯Lv·잠재 3줄·티어색 렌더 + 성 승급→★+1·잠재 해금", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/codex");

  // 보유 카드 탭 → 성장 상세 시트.
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  const sheet = page.getByTestId("growth-detail");
  await expect(sheet).toBeVisible();

  // ★ 1(초기) · 잠재 3슬롯(1★=잠김) · 등급 프레임 GOLD.
  await expect(page.getByTestId("growth-frame")).toHaveAttribute("data-grade", "GOLD");
  await expect(page.getByTestId("growth-stars")).toHaveAttribute("data-star", "1");
  await expect(page.getByTestId("growth-potential-locked")).toBeVisible();
  await expect(page.getByTestId("growth-potential-slot-1")).toHaveAttribute("data-state", "locked-star");
  await expect(page.getByTestId("growth-ovr")).toHaveText("58");
  await expect(page.getByTestId("growth-completion")).toContainText("완성도");
  await expect(page.getByTestId("growth-star-up")).toContainText("2★");
  await expect(page.getByTestId("growth-star-cost")).toContainText("중복 −2");

  // 능력치 2단 레이어 — [레이더](기본) ↔ [막대]("+보너스" 탭은 hero 실시간 지시로 제거 — "잘 안 보여").
  // 레이더 기본 렌더: SVG 폴리곤 6축(슛/스피드/패스/테크닉/수비/피지컬) + 멘탈 칩(레이더 밖)
  // + 밴드 앵커 윈도우 라벨(GOLD 60-75 → [55,90], hero: "주식 y축처럼 하한 잘라 드라마틱하게").
  await expect(page.getByTestId("growth-layer-radar")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("growth-attrs")).toHaveCount(0); // 막대 dl 은 레이더 레이어에서 렌더 안 됨
  await expect(page.getByTestId("growth-layer-bonus")).toHaveCount(0); // +보너스 탭 제거됨
  const radarSvg = page.getByTestId("growth-radar-svg");
  await expect(radarSvg).toBeVisible();
  await expect(page.getByTestId("growth-radar-polygon-value")).toBeVisible();
  await expect(page.getByTestId("growth-radar-polygon-cap")).toBeVisible(); // cap 점선 폴리곤 — 성장/잠재 상한은 이걸로 표시
  for (const [k, label] of [
    ["shooting", "슛"],
    ["pace", "스피드"],
    ["passing", "패스"],
    ["technical", "테크닉"],
    ["defense", "수비"],
    ["physical", "피지컬"],
  ]) {
    await expect(page.getByTestId(`growth-radar-axis-${k}`)).toContainText(label);
  }
  await expect(page.getByTestId("growth-radar-axis-shooting")).toContainText("55"); // shooting 원시값
  await expect(page.getByTestId("growth-radar-window")).toHaveText("55–90"); // GOLD [60,75] → [55,90]
  await expect(page.getByTestId("growth-mental-chip")).toBeVisible();
  await expect(page.getByTestId("growth-mental-chip")).toContainText("멘탈");
  await expect(page.getByTestId("growth-mental-chip")).toContainText("41");

  await page.screenshot({ path: `${SMOKE_DIR}growth-radar.png`, fullPage: true });

  // [막대] 전환 — 윈도우 정규화 막대(cap/base 마커로 성장/잠재 여지 표시) + 축 라벨(윈도우 min/max 숫자).
  await page.getByTestId("growth-layer-total").click();
  await expect(page.getByTestId("growth-attrs")).toHaveAttribute("data-layer", "total");
  await expect(page.getByTestId("growth-layer-total")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("growth-radar-svg")).toHaveCount(0); // 레이더는 사라진다
  await expect(page.getByTestId("growth-attr-window")).toHaveText("스탯 축 55–90");
  await expect(page.getByTestId("growth-lv-shooting")).toHaveText("Lv.0");
  await expect(page.getByTestId("growth-fill-pace")).toBeVisible();
  // shooting(55) 이 이 카드의 윈도우 하한(55, GOLD [55,90])과 정확히 겹친다 — 밴드 앵커 클램프로
  // width 0%(밴드 아래는 안 보이게, hero: "y축 하한 잘라서 드라마틱하게"). raw 값은 data-value 로 유지.
  await expect(page.getByTestId("growth-fill-shooting")).toHaveAttribute("data-value", "55");
  await expect(page.getByTestId("growth-fill-shooting")).toHaveCSS("width", "0px");

  // 레이더로 복귀도 가능(2단 순환).
  await page.getByTestId("growth-layer-radar").click();
  await expect(page.getByTestId("growth-radar-svg")).toBeVisible();
  await expect(page.getByTestId("growth-attrs")).toHaveCount(0);
  await expect(page.getByTestId("growth-attr-window")).toHaveCount(0); // 축 라벨은 막대 레이어 전용

  // 이후 검증(성 승급 등)은 [막대] 레이어에서 진행.
  await page.getByTestId("growth-layer-total").click();
  await expect(page.getByTestId("growth-attrs")).toHaveAttribute("data-layer", "total");
  await expect(page.getByTestId("growth-layer-total")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("growth-layer-radar")).toHaveAttribute("aria-selected", "false");

  await page.screenshot({ path: `${SMOKE_DIR}growth-detail-schema3.png`, fullPage: true });

  // 성 승급 → ★2, 잠재 해금(2줄: GOLD=2줄), 전줄 동일 티어(RARE) 표시(V2.1-1) + 패널 단일 대형 뱃지.
  await page.getByTestId("growth-star-up").click();
  await expect(page.getByTestId("growth-stars")).toHaveAttribute("data-star", "2");
  await expect(page.getByTestId("growth-potential-tier")).toBeVisible();
  await expect(page.getByTestId("growth-potential-tier")).toContainText("레어");
  await expect(page.getByTestId("growth-potential")).toHaveAttribute("data-tier", "RARE");
  await expect(page.getByTestId("growth-frame")).toHaveAttribute("data-potential-tier", "RARE");
  await expect(page.getByTestId("growth-potential-slot-1")).toHaveAttribute("data-state", "filled");
  await expect(page.getByTestId("growth-potential-slot-1")).toHaveAttribute("data-tier", "RARE");
  await expect(page.getByTestId("growth-potential-slot-2")).toHaveAttribute("data-state", "filled");
  // V2.1-1: 전줄 동일 티어 — 2번째 슬롯도 1번째와 같은 RARE(구 "한 단계 아래" 폐기).
  await expect(page.getByTestId("growth-potential-slot-2")).toHaveAttribute("data-tier", "RARE");
  // GOLD 는 2줄까지만 — 3번째 슬롯은 등급 상한으로 영구 잠김.
  await expect(page.getByTestId("growth-potential-slot-3")).toHaveAttribute("data-state", "locked-grade");
  await expect(page.getByTestId("growth-dice-ceiling")).toBeVisible();

  // 390px 가로 오버플로 0.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`[smoke] growth-detail 390px overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SMOKE_DIR}growth-detail-promoted.png`, fullPage: true });
});

test("G4 성★ 승급 오버레이(GM7b): 클릭 → growth-starup-overlay 등장(2★ 달성!·잠재능력 해금) → 소멸", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/codex");

  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await expect(page.getByTestId("growth-detail")).toBeVisible();

  const overlay = page.getByTestId("growth-starup-overlay");
  await expect(overlay).toHaveCount(0);

  await page.getByTestId("growth-star-up").click();
  await expect(page.getByTestId("growth-stars")).toHaveAttribute("data-star", "2");

  // 이펙트 인터페이스화(CelebrationOverlay) — 성★ 승급도 티어업과 같은 재사용 오버레이로 뜬다.
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("data-variant", "starUp");
  await expect(overlay).toContainText("2★");
  await expect(overlay).toContainText("잠재능력 해금");

  // 일정 시간 후 자동으로 걷힌다(부모가 onDone 에서 unmount).
  await expect(overlay).toHaveCount(0, { timeout: 5000 });
});

test("G4 다이스 롤: 라인 갱신 + 티어업 전체 오버레이(RARE→EPIC 승급 연출)", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  // 상점에서 노말 다이스 2개 구매(롤 2회로 티어업 트리거).
  // ⚠️ page.goto 는 풀 리로드(React Query 캐시 = 다이스 잔고 리셋) — nav 클릭으로 SPA 내 이동 유지.
  await page.goto("/shop");
  await page.getByTestId("shop-tab-dice").click();
  await page.getByTestId("dice-buy-normal").click();
  await expect(page.getByTestId("dice-wallet-flash")).toBeVisible();
  await page.getByTestId("dice-buy-normal").click();

  // 도감 카드 상세 → 2★ 아니므로 먼저 승급(잠재 해금) → 다이스 롤.
  await page.getByTestId("nav-bottom").getByTestId("nav-codex").click();
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await page.getByTestId("growth-star-up").click();
  await expect(page.getByTestId("growth-stars")).toHaveAttribute("data-star", "2");

  // 레이더가 기본 레이어라 스탯 Lv 뱃지(growth-lv-*)는 [막대] 레이어에만 존재 — 전환.
  await page.getByTestId("growth-layer-total").click();
  await expect(page.getByTestId("growth-attrs")).toHaveAttribute("data-layer", "total");

  await expect(page.getByTestId("growth-dice-normal")).toBeEnabled();
  const shootLvBefore = await page.getByTestId("growth-lv-shooting").innerText();

  await page.getByTestId("growth-dice-normal").click(); // 1회차 — 아직 티어업 아님
  await expect
    .poll(async () => await page.getByTestId("growth-lv-shooting").innerText())
    .not.toBe(shootLvBefore);

  await page.getByTestId("growth-dice-normal").click(); // 2회차 — 목에서 RARE→EPIC 트리거

  // V2.1-3: 티어업 = 전체 오버레이(구 하단 배너 폐기) — 플래시+뱃지+순차 리롤 dot.
  const overlay = page.getByTestId("growth-tierup-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("data-tier", "EPIC");
  await expect(overlay).toContainText("에픽");

  // V2.1-1: 전줄 동일 티어 — 승급이 슬롯 1개가 아니라 전줄을 즉시 EPIC 으로 리롤한다.
  await expect(page.getByTestId("growth-potential-slot-1")).toHaveAttribute("data-tier", "EPIC");
  await expect(page.getByTestId("growth-potential-slot-2")).toHaveAttribute("data-tier", "EPIC");

  // 프레임 글로우도 새 티어로 전환.
  await expect(page.getByTestId("growth-frame")).toHaveAttribute("data-potential-tier", "EPIC");

  // 오버레이는 일정 시간 후 자동으로 걷힌다(전체 오버레이 → 카드 상시뷰 복귀).
  await expect(overlay).toHaveCount(0, { timeout: 5000 });
});

test("G4 다이스 부족: POST /api/growth/dice 4xx → 에러 메시지", async ({ page }) => {
  await mockGrowth(page, { diceAlwaysFails: true });
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/shop");
  await page.getByTestId("shop-tab-dice").click();
  await page.getByTestId("dice-buy-normal").click(); // 잔고 1로 만들어 버튼을 활성 상태로 둔다(SPA 이동으로 캐시 유지)

  await page.getByTestId("nav-bottom").getByTestId("nav-codex").click();
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await expect(page.getByTestId("growth-dice-normal")).toBeEnabled();
  await page.getByTestId("growth-dice-normal").click();

  await expect(page.getByRole("alert")).toContainText("다이스가 부족합니다");
});

// ── V2.2 재화 이원화(hero 확정 2026-07-26, GM9) — 지갑 P·젬 병기·젬 충전(목업)·캐시 다이스 젬가격 ──

test("G4 V2.2 지갑 젬 표시(로비/상점 상단) + 캐시 다이스 젬가격 표시", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/lobby");
  await expect(page.getByTestId("wallet-gems")).toBeVisible();
  await expect(page.getByTestId("wallet-gems")).toHaveAttribute("data-gems", "50");
  await expect(page.getByTestId("wallet-gems")).toContainText("50");

  await page.goto("/shop");
  await expect(page.getByTestId("wallet-gems")).toHaveAttribute("data-gems", "50");

  await page.getByTestId("shop-tab-dice").click();
  await expect(page.getByTestId("dice-cash-price")).toContainText("10");
  await expect(page.getByTestId("dice-wallet-flash")).toContainText("50");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`[smoke] shop-dice(V2.2) 390px overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("G4 V2.2 젬 충전(목업): 클릭 즉시 gems 증가 + 지갑 플래시", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/shop");
  await page.getByTestId("shop-tab-dice").click();

  const section = page.getByTestId("gem-topup-section");
  await expect(section).toBeVisible();
  await expect(section).toContainText("목업");
  await expect(section).toContainText("실결제 없음");

  await page.getByTestId("gem-topup-p1").click(); // 60젬 지급 → 50+60=110
  await expect(page.getByTestId("dice-wallet-flash")).toBeVisible();
  await expect
    .poll(async () => await page.getByTestId("wallet-gems").getAttribute("data-gems"))
    .toBe("110");
  await expect(page.getByTestId("wallet-gems")).toContainText("110");

  // 플래시(dip 0.5s, transform:scale(1.2))가 걷힌 뒤 측정 — 진행 중 스케일은 scrollWidth 를
  // 일시적으로 부풀린다(레이아웃 오버플로가 아니라 트랜스폼 페인트 경계, 정적 레이아웃은 다른
  // 테스트가 이미 확인). 590ms(애니메이션 500ms) 대기 후 안정 상태를 잰다.
  await page.waitForTimeout(590);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("G4 V2.2 캐시 다이스 젬 부족(클라 가드): gems<10 → API 호출 없이 안내 + 충전 유도", async ({ page }) => {
  await mockGrowth(page, { gems: 5 }); // 10젬 미만 — 캐시 다이스 1개도 못 삼(클라 가드가 먼저 막는다)
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/shop");
  await page.getByTestId("shop-tab-dice").click();
  await expect(page.getByTestId("wallet-gems")).toHaveAttribute("data-gems", "5");

  await page.getByTestId("dice-buy-cash").click();
  await expect(page.getByRole("alert")).toContainText("젬이 부족합니다");
  await expect(page.getByRole("alert")).toContainText("충전");
});

test("G4 V2.2 캐시 다이스 젬 부족(서버 권위): POST /api/shop/dice 4xx INSUFFICIENT_GEMS → 에러 메시지", async ({ page }) => {
  // 클라 잔고는 충분해 보이지만(50젬) 서버가 최종 게이트로 거절 — diceAlwaysFails 와 동일한
  // "서버 권위" 검증 패턴(§2.5). ApiError.code === INSUFFICIENT_GEMS 분기가 실제로 타는지 확인.
  await mockGrowth(page, { cashDiceAlwaysFailsGems: true });
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/shop");
  await page.getByTestId("shop-tab-dice").click();
  await expect(page.getByTestId("wallet-gems")).toHaveAttribute("data-gems", "50");

  await page.getByTestId("dice-buy-cash").click();
  await expect(page.getByRole("alert")).toContainText("젬이 부족합니다");
  await expect(page.getByRole("alert")).toContainText("충전");
});

test("G4 미보유 카드는 성장 UI 없이 기존 인라인 확장(잠금)만", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/codex");

  await page.getByTestId("codex-card-P099").getByRole("button").first().click();
  // 성장 시트가 뜨지 않는다(미보유).
  await expect(page.getByTestId("growth-detail")).toHaveCount(0);
  // 기존 인라인 능력치 확장은 유지.
  await expect(page.getByTestId("codex-attrs-P099")).toBeVisible();
});

// ── 성장 리포트(S1) — ResultPage 하단 ────────────────────────────────
const MATCH_ID = "M777";
const REPORT = {
  matchId: MATCH_ID,
  entries: [
    {
      playerId: OWNED_ID,
      name: "양민혁",
      statXp: { shooting: 80, pace: 40, technical: 0, mental: 0, physical: 0, passing: 0, tackling: 0, stamina: 0, positioning: 0 },
      levelUps: ["shooting"],
      ovrBefore: 58,
      ovrAfter: 60,
    },
    {
      playerId: "P042",
      name: "김수비",
      statXp: { tackling: 30, physical: 0, shooting: 0, pace: 0, technical: 0, mental: 0, passing: 0, stamina: 0, positioning: 0 },
      levelUps: [],
      ovrBefore: 62,
      ovrAfter: 62,
    },
  ],
};
const FINISHED_MATCH = {
  id: MATCH_ID,
  state: "FINISHED",
  opponent: { name: "봇 FC", analysisText: "", deck: [] },
  scoreHome: 2,
  scoreAway: 1,
  result: "WIN",
  createdAt: "2026-07-26T00:00:00Z",
};

test("G4 성장 리포트(S1): ResultPage 하단 — 스탯별 XP 막대 + 레벨업 뱃지 + OVR before→after", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json(ME_RESPONSE)));
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) => route.fulfill(json(FINISHED_MATCH)));
  await page.route(
    (url) => url.pathname === `/api/matches/${MATCH_ID}/result`,
    (route) => route.fulfill(json({ matchId: MATCH_ID, scoreHome: 2, scoreAway: 1, result: "WIN", pointsAwarded: 100 })),
  );
  await page.route((url) => /\/api\/matches\/M777\/halves\/[12]\/log$/.test(url.pathname), (route) => route.fulfill(json({ events: [] })));
  await page.route((url) => url.pathname === `/api/growth/report/${MATCH_ID}`, (route) => route.fulfill(json(REPORT)));
  await seedAuth(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/match/${MATCH_ID}`);

  await expect(page.getByTestId("result-page")).toBeVisible();
  const report = page.getByTestId("growth-report");
  await expect(report).toBeVisible();
  await expect(page.getByTestId(`growth-xp-total-${OWNED_ID}`)).toContainText("+120");
  await expect(page.getByTestId(`growth-statxp-${OWNED_ID}-shooting`)).toContainText("+80");
  await expect(page.getByTestId(`growth-statxp-${OWNED_ID}-pace`)).toContainText("+40");
  await expect(page.getByTestId(`growth-ovr-${OWNED_ID}`)).toContainText("58 → 60");
  await expect(page.getByTestId(`growth-levelup-${OWNED_ID}-shooting`)).toContainText("슛 Lv up!");
  // 레벨업 안 한 선수는 뱃지 없음.
  await expect(page.getByTestId("growth-levelup-P042")).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await report.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SMOKE_DIR}growth-report.png`, fullPage: true });
});

test("G4 성장 리포트: entries 비면 섹션 숨김", async ({ page }) => {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json(ME_RESPONSE)));
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) => route.fulfill(json(FINISHED_MATCH)));
  await page.route(
    (url) => url.pathname === `/api/matches/${MATCH_ID}/result`,
    (route) => route.fulfill(json({ matchId: MATCH_ID, scoreHome: 2, scoreAway: 1, result: "WIN", pointsAwarded: 100 })),
  );
  await page.route((url) => /\/api\/matches\/M777\/halves\/[12]\/log$/.test(url.pathname), (route) => route.fulfill(json({ events: [] })));
  await page.route((url) => url.pathname === `/api/growth/report/${MATCH_ID}`, (route) => route.fulfill(json({ matchId: MATCH_ID, entries: [] })));
  await seedAuth(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("result-page")).toBeVisible();
  await expect(page.getByTestId("growth-report")).toHaveCount(0);
});
