import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { appConfigPayload, mockAppConfig } from "./app-config-mock";

/** 목 config 가 내려주는 재화 이름 — 문구 단언은 이 값을 따라간다(#232, 상수 박제 금지). */
const GEM_NAME = appConfigPayload().currencies.find((c) => c.code === "GEM")!.name;
const POINT_NAME = appConfigPayload().currencies.find((c) => c.code === "POINT")!.name;

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
// 포지션별 6축 검증용(hero 2026-07-26) — GK mock 카드, 1번 축 라벨 "선방위치" 확인.
const GK_ID = "P002";
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
  { id: GK_ID, name: "김골키퍼", position: "GK", grade: "GOLD", owned: true, ownedCount: 1, attributes: attrs },
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
  /** POST /api/growth/dice 를 항상 INSUFFICIENT_POINTS 로 실패시킨다(잔액부족 시나리오 전용). */
  rollAlwaysFailsPoints?: boolean;
  /** 초기 젬 잔고(기본 ME_RESPONSE.wallet.gems) — 젬 부족 시나리오 전용으로 낮춰 넘긴다. */
  gems?: number;
  /** 초기 무료재화 잔고(기본 ME_RESPONSE.wallet.points). */
  points?: number;
  /**
   * 유료 롤을 잔고와 무관하게 항상 INSUFFICIENT_GEMS 로 실패시킨다 — 서버 권위 검증
   * (클라 가드를 우회해도 서버가 최종 게이트) 시나리오 전용.
   */
  cashRollAlwaysFailsGems?: boolean;
}

/** #247 롤 비용 — app-config 목이 내리는 값과 같아야 화면 표기와 차감이 맞물린다. */
const DICE_NORMAL_COST = 5000;
const DICE_CASH_COST = 10;

/**
 * 성장 카드/성/잠재 리롤 목 — 상태ful. star-up 마다 star++·잠재 해금, 롤마다 lines 갱신
 * (2회차에 RARE→EPIC 티어업). **#247: 구매·재고가 사라졌으므로 롤이 지갑을 직접 깎는다** —
 * /api/me 와 롤 응답이 같은 지갑 변수를 공유해 화면 잔액이 실제로 줄어드는지 볼 수 있다.
 */
async function mockGrowth(page: Page, opts: GrowthMockOpts = {}) {
  let star = 1;
  let statBump = 0;
  let potentialUnlocked = false;
  let tier: "RARE" | "EPIC" | "UNIQUE" = "RARE";
  let rollsSinceTierUp = 0;
  let rollCount = 0;
  let gems = opts.gems ?? ME_RESPONSE.wallet.gems;
  let points = opts.points ?? ME_RESPONSE.wallet.points;

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
  // #232: 다이스 가격·충전 팩은 서버 config 에서 온다(클라 미러 제거). 이 스펙은 충전 섹션도 보므로 켠다.
  await mockAppConfig(page, { topupEnabled: true });
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({ ...ME_RESPONSE, wallet: { points, gems } })),
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

  // GK mock 카드(고정, 상태ful 아님) — 포지션별 6축 매핑 검증 전용(1번 축 "선방위치").
  await page.route(
    (url) => url.pathname === `/api/growth/card/${GK_ID}`,
    (route) =>
      route.fulfill(
        json({
          playerId: GK_ID,
          grade: "GOLD",
          star: 1,
          attributes: attrs,
          prePotential: attrs,
          base: attrs,
          caps,
          statLevels: statLevels(0),
          potential: { unlocked: false, tier: "RARE", maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 9 },
          ovr: 58,
          completion: 0.3,
        }),
      ),
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

  // #247: 구매 단계가 사라졌다 — 롤 자체가 지갑에서 결제한다(POST 만 존재, 잔액조회 GET 없음).
  await page.route(
    (url) => url.pathname === "/api/growth/dice",
    (route) => {
      if (opts.rollAlwaysFailsPoints) {
        route.fulfill(err(400, "INSUFFICIENT_POINTS", `${POINT_NAME}가 부족합니다`));
        return;
      }
      const body = route.request().postDataJSON() as { kind: "NORMAL" | "CASH" };
      const cost = body.kind === "NORMAL" ? DICE_NORMAL_COST : DICE_CASH_COST;
      // 서버 권위 — 클라 가드를 우회해 눌러도 잔액이 모자라면 4xx.
      if (body.kind === "CASH" && (opts.cashRollAlwaysFailsGems || gems < cost)) {
        route.fulfill(err(400, "INSUFFICIENT_GEMS", `${GEM_NAME}가 부족합니다`));
        return;
      }
      if (body.kind === "CASH") gems -= cost;
      else points -= cost;
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
          wallet: { points, gems },
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
  // 레이더 기본 렌더(포지션별 6축, hero 2026-07-26: FW = 슛/스피드/공간지각/테크닉/패스/피지컬)
  // + 사이드 칩 2개(레이더 밖, FW = 멘탈+태클) + 밴드 앵커 윈도우 라벨(GOLD 60-75 → [55,90],
  // hero: "주식 y축처럼 하한 잘라 드라마틱하게").
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
    ["positioning", "공간지각"],
    ["technical", "테크닉"],
    ["passing", "패스"],
    ["physical", "피지컬"],
  ]) {
    await expect(page.getByTestId(`growth-radar-axis-${k}`)).toContainText(label);
  }
  await expect(page.getByTestId("growth-radar-axis-shooting")).toContainText("55"); // shooting 원시값
  await expect(page.getByTestId("growth-radar-window")).toHaveText("55–90"); // GOLD [60,75] → [55,90]
  await expect(page.getByTestId("growth-side-chip-mental")).toBeVisible();
  await expect(page.getByTestId("growth-side-chip-mental")).toContainText("멘탈");
  await expect(page.getByTestId("growth-side-chip-mental")).toContainText("41");
  await expect(page.getByTestId("growth-side-chip-tackling")).toBeVisible();
  await expect(page.getByTestId("growth-side-chip-tackling")).toContainText("태클");

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

test("G4 포지션별 레이더 6축(hero 2026-07-26): GK 카드 1번 축 = '선방위치'", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/codex");

  await page.getByTestId(`codex-card-${GK_ID}`).getByRole("button").first().click();
  const sheet = page.getByTestId("growth-detail");
  await expect(sheet).toBeVisible();

  await expect(page.getByTestId("growth-radar-svg")).toBeVisible();
  // GK 1번 축(positioning) = "선방위치"(FW/DF 의 "공간지각"·"위치선정"과 다른 GK 전용 라벨).
  await expect(page.getByTestId("growth-radar-axis-positioning")).toContainText("선방위치");
  // GK 사이드 칩(레이더 밖) = 슛 + 태클.
  await expect(page.getByTestId("growth-side-chip-shooting")).toBeVisible();
  await expect(page.getByTestId("growth-side-chip-shooting")).toContainText("슛");
  await expect(page.getByTestId("growth-side-chip-tackling")).toBeVisible();
  await expect(page.getByTestId("growth-side-chip-tackling")).toContainText("태클");
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

test("G4 잠재 재설정: 라인 갱신 + 티어업 전체 오버레이(RARE→EPIC 승급 연출)", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  // #247: 구매 단계가 없다 — 상점을 거치지 않고 강화 상세에서 바로 굴린다.
  await page.goto("/codex");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await page.getByTestId("growth-star-up").click();
  await expect(page.getByTestId("growth-stars")).toHaveAttribute("data-star", "2");

  // 레이더가 기본 레이어라 스탯 Lv 뱃지(growth-lv-*)는 [막대] 레이어에만 존재 — 전환.
  await page.getByTestId("growth-layer-total").click();
  await expect(page.getByTestId("growth-attrs")).toHaveAttribute("data-layer", "total");

  await expect(page.getByTestId("growth-dice-normal")).toBeEnabled();
  const shootLvBefore = await page.getByTestId("growth-lv-shooting").innerText();

  await page.getByTestId("growth-dice-normal").click(); // 1회차 — 첫 롤이라 확인 다이얼로그
  await page.getByTestId("growth-roll-confirm-ok").click();
  await expect
    .poll(async () => await page.getByTestId("growth-lv-shooting").innerText())
    .not.toBe(shootLvBefore);

  // 두 번째부터는 확인 없이 바로 굴러간다(hero 확정: 첫 1회만 확인).
  await page.getByTestId("growth-dice-normal").click(); // 2회차 — 목에서 RARE→EPIC 트리거
  await expect(page.getByTestId("growth-roll-confirm")).toHaveCount(0);

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

/**
 * #247: 부족은 **재화 부족**이다(구 INSUFFICIENT_DICE 는 재고와 함께 소멸). 서버 권위 —
 * 클라 잔고가 충분해 보여도 서버가 4xx 로 끊으면 그 문구를 그대로 띄운다.
 * 문구에 재화 이름을 클라가 지어내지 않는지도 같이 본다(#232 — 목 config 의 이름 "오메가").
 */
test("G4 잠재 재설정 잔액부족(서버 권위): 4xx INSUFFICIENT_POINTS → 서버 문구 그대로", async ({ page }) => {
  await mockGrowth(page, { rollAlwaysFailsPoints: true });
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/codex");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await page.getByTestId("growth-star-up").click(); // 잠재 해금(2★)
  await expect(page.getByTestId("growth-dice-normal")).toBeEnabled();
  await page.getByTestId("growth-dice-normal").click();
  await page.getByTestId("growth-roll-confirm-ok").click();

  await expect(page.getByRole("alert")).toContainText(`${POINT_NAME}가 부족합니다`);
});

/**
 * #247 핵심 동선 — 상점을 한 번도 거치지 않고 강화탭에서 바로 잠재가 바뀌고 **지갑이 줄어든다**.
 * 상점에 [다이스] 탭이 남아 있으면 이 테스트가 아니라 아래 "탭 제거" 단언이 잡는다.
 */
test("G4 잠재 재설정: 구매 없이 지갑 직접 차감 + 상점 [다이스] 탭 소멸", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/codex");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await page.getByTestId("growth-star-up").click();

  // 가격은 서버 config 에서 온다 — 화면에 상수가 박혀 있으면 목 값(5,000)과 어긋난다.
  await expect(page.getByTestId("growth-dice-normal-price")).toContainText("5,000");
  await expect(page.getByTestId("growth-dice-cash-price")).toContainText("10");
  await expect(page.getByTestId("growth-wallet")).toContainText("20,000");

  await page.getByTestId("growth-dice-normal").click();
  // 확인 다이얼로그가 **차감 후 잔액**을 미리 말해 준다(20,000 − 5,000).
  await expect(page.getByTestId("growth-roll-confirm-after")).toContainText("15,000");
  await page.getByTestId("growth-roll-confirm-ok").click();

  // 롤 뒤 헤더 지갑이 실제로 줄어든다(useDiceRoll 이 ["me"] 를 무효화하지 않으면 여기서 죽는다).
  await expect.poll(async () => await page.getByTestId("growth-wallet").innerText())
    .toContain("15,000");

  // 상점에는 다이스 탭이 없다. (상세 시트를 먼저 닫는다 — 열린 모달이 하단 nav 를 덮는다.)
  await page.getByTestId("growth-detail").getByRole("button", { name: "닫기" }).click();
  await expect(page.getByTestId("growth-detail")).toHaveCount(0);
  await page.getByTestId("nav-bottom").getByTestId("nav-recruit").click();
  await expect(page.getByTestId("shop-tab-gacha")).toBeVisible();
  await expect(page.getByTestId("shop-tab-dice")).toHaveCount(0);
});

/**
 * 1★(잠재 미해금) 카드에서는 **버튼이 잠기고 확인창도 뜨지 않는다**.
 *
 * 구 UI 는 "보유 다이스 ≥ 1" 이 이 자리를 사실상 가려 줬지만(신규 유저 재고 0), #247 이
 * 게이팅을 재고→잔액으로 바꾸면서 1★ 에서도 버튼이 열려 **"5,000 G 차감" 확인창이 뜨는데
 * 서버는 POTENTIAL_LOCKED 로 거절**했다(독립검증 major-2). 재화가 나가진 않지만 실행 불가한
 * 액션에 차감을 약속하면 안 된다 — 신규 유저 컬렉션은 대부분 1★다.
 */
test("G4 잠재 미해금(1★): 재설정 버튼 잠금 + 결제 확인창 안 뜸", async ({ page }) => {
  await mockGrowth(page); // star=1, potential.unlocked=false 로 시작
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/codex");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await expect(page.getByTestId("growth-potential-locked")).toBeVisible(); // "2★에서 해금"

  await expect(page.getByTestId("growth-dice-normal")).toBeDisabled();
  await expect(page.getByTestId("growth-dice-cash")).toBeDisabled();
  await page.getByTestId("growth-dice-normal").click({ force: true }); // 가드를 우회해 눌러도
  await expect(page.getByTestId("growth-roll-confirm")).toHaveCount(0); // 차감을 약속하지 않는다

  // 승급하면 그 자리에서 열린다(잠금이 영구가 아님을 같이 박제 — 과잉 잠금 회귀 방지).
  await page.getByTestId("growth-star-up").click();
  await expect(page.getByTestId("growth-dice-normal")).toBeEnabled();
});

/** 잔액이 비용에 못 미치면 **버튼 자체가 잠긴다**(클라 가드) — 눌러서 4xx 를 보기 전에. */
test("G4 잠재 재설정 잔액부족(클라 가드): 잔액 < 비용 → 버튼 잠금", async ({ page }) => {
  await mockGrowth(page, { points: 4999, gems: 5 });
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/codex");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await page.getByTestId("growth-star-up").click();

  await expect(page.getByTestId("growth-dice-normal")).toBeDisabled(); // 4,999 < 5,000
  await expect(page.getByTestId("growth-dice-cash")).toBeDisabled(); // 5 < 10
});

// ── V2.2 재화 이원화(hero 확정 2026-07-26, GM9) — 지갑 P·젬 병기·젬 충전(목업)·캐시 다이스 젬가격 ──

test("G4 V2.2 지갑 젬 표시(로비/상점 상단) + 유료 재설정 젬가격 표시(강화 상세)", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/home");
  await expect(page.getByTestId("wallet-gems")).toBeVisible();
  await expect(page.getByTestId("wallet-gems")).toHaveAttribute("data-gems", "50");
  await expect(page.getByTestId("wallet-gems")).toContainText("50");

  await page.goto("/shop");
  await expect(page.getByTestId("wallet-gems")).toHaveAttribute("data-gems", "50");

  // #247: 유료 재설정 가격은 상점이 아니라 **강화 상세**에 있다(구매 단계 소멸).
  await page.goto("/codex");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await page.getByTestId("growth-star-up").click();
  await expect(page.getByTestId("growth-dice-cash-price")).toContainText("10");
  await expect(page.getByTestId("growth-wallet")).toContainText("50");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`[smoke] growth-detail(#247) 390px overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("G4 V2.2 젬 충전(목업): 클릭 즉시 gems 증가 + 지갑 플래시", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  // #247: 충전 섹션은 [다이스] 탭이 사라지며 [충전] 탭으로 옮겨졌다(게이팅 플래그는 원래 같다).
  await page.goto("/shop");
  await page.getByTestId("shop-tab-topup").click();

  const section = page.getByTestId("gem-topup-section");
  await expect(section).toBeVisible();
  await expect(section).toContainText("목업");
  await expect(section).toContainText("실결제 없음");

  await page.getByTestId("gem-topup-p1").click(); // 60젬 지급 → 50+60=110
  await expect(page.getByTestId("gem-topup-wallet-flash")).toBeVisible();
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

/**
 * #247: 유료 재설정의 젬 부족은 이제 **강화 상세**에서 난다. 클라 가드가 먼저 잠그고,
 * 그걸 우회해 눌러도 서버가 최종 게이트다 — 두 층을 한 스펙에서 본다.
 * 문구는 **서버가 표기 메타로 만든 것**을 그대로 띄운다(#232 — 클라가 이름을 지어내면 죽는다).
 */
test("G4 유료 재설정 젬 부족: 클라 가드(버튼 잠금) + 서버 권위(4xx 문구)", async ({ page }) => {
  await mockGrowth(page, { gems: 5 }); // 10젬 미만 — 클라 가드가 먼저 막는다
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/codex");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await page.getByTestId("growth-star-up").click();
  await expect(page.getByTestId("growth-dice-cash")).toBeDisabled();
});

test("G4 유료 재설정 젬 부족(서버 권위): 4xx INSUFFICIENT_GEMS → 서버 문구 그대로", async ({ page }) => {
  // 클라 잔고는 충분해 보이지만(50젬) 서버가 최종 게이트로 거절 — 클라 가드를 믿지 않는다는 계약.
  await mockGrowth(page, { cashRollAlwaysFailsGems: true });
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/codex");
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  await page.getByTestId("growth-star-up").click();
  await expect(page.getByTestId("growth-dice-cash")).toBeEnabled(); // 잔고는 충분해 보인다
  await page.getByTestId("growth-dice-cash").click();
  await page.getByTestId("growth-roll-confirm-ok").click();

  await expect(page.getByRole("alert")).toContainText(`${GEM_NAME}가 부족합니다`);
});

test("G4 미보유 카드는 성장 UI 없이 기존 인라인 확장(잠금)만", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/players");
  // #286: 기본 스코프가 **보유**라 미보유 카드(P099)를 보려면 전체로 넘긴다.
  await page.getByTestId("codex-scope-all").click();

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
