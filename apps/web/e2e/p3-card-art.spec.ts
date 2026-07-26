import { expect, test, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";

/**
 * 카드 풀아트 배선 계약 (#187).
 *
 * 이 파일이 지키는 것 4가지 — 전부 **화면이 조용히 망가지는** 부류다:
 *   ① 큰 화면에 풀아트가 실제로 뜬다 (뽑기 전체 · 덱 유닛정보 · 도감 확장)
 *   ② **아이콘/풀아트 경계** — 밀집 UI(리스트·전술보드 토큰·매치)에 풀아트가 **없어야** 한다.
 *      경계가 코드 리뷰 의견이 아니라 **테스트**로 지켜져야 나중에 무심코 안 넘어간다.
 *   ③ 폴백 계단 — 매핑 없음 → 등급 프레임 + 아이콘 / 에셋 전무 → CSS. 깨진 <img> 0.
 *   ④ 등급↔프레임 정합 + 모바일 390 가로 오버플로 0.
 *
 * 백엔드 없이 돈다: `/api/**` 를 목킹한다(라우트 매처는 **오리진 앵커** — 상대 글롭을 쓰면
 * 에셋 요청까지 가로채 흰 화면이 된다). `/chars/**` 는 vite public 실물을 쓴다(폴백 검사에서만 차단).
 */

const SHOTS = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** 목 로스터는 **발행물에서 조인**한다 — 손으로 적으면 등급·매핑이 실제 시드와 어긋난다. */
const SEED: Array<{ id: string; name: string; position: string; grade: string }> = JSON.parse(
  readFileSync(new URL("../../../data/players/players.v2.1.json", import.meta.url).pathname, "utf8"),
);

const pick = (grade: string, n: number) => SEED.filter((p) => p.grade === grade).slice(0, n);

/** 전 등급이 한 번씩 나오게 — ④ 등급↔프레임 정합을 5종 다 태우기 위해. */
const CATALOG = [
  ...pick("LEGEND", 2), ...pick("DIA", 2), ...pick("GOLD", 2),
  ...pick("SILVER", 2), ...pick("BRONZE", 3),
].map((p, i) => ({
  id: p.id,
  name: p.name,
  position: p.position,
  grade: p.grade,
  owned: true,
  ownedCount: 1,
  attributes: {
    technical: 70 + i, mental: 71, physical: 72, passing: 73,
    shooting: 74, tackling: 75, pace: 76, stamina: 77, positioning: 78,
  },
}));

/** 뽑기 10+1 응답 — 11장 전부 풀아트여야 한다(hero 확정 A안). */
const GACHA = {
  results: CATALOG.map((p, i) => ({
    player: { id: p.id, name: p.name, position: p.position, grade: p.grade },
    isNew: i % 3 === 0,
  })),
  wallet: { points: 500 },
};

/** 10연차(3,000P)가 **눌리는** 잔액이어야 한다 — 부족하면 버튼이 disabled 라 테스트가 타임아웃한다. */
const ME = { nickname: "tester", points: 10_000, wallet: { points: 10_000 }, records: { wins: 0, draws: 0, losses: 0 } };

async function mockApi(page: Page) {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json(ME)));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(CATALOG)));
  await page.route((url) => url.pathname === "/api/deck", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route((url) => url.pathname === "/api/presets", (route) => route.fulfill(json([])));
  // 형상을 지켜서 준다 — 캐치올 `{}` 를 그대로 두면 `relations.players` 가 undefined 라
  // 선수를 고르는 순간 덱 에디터가 언마운트된다(이 목이 실제로 밟았던 경로).
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 50, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/conditions", (route) => route.fulfill(json({ players: {} })));
  await page.route((url) => url.pathname === "/api/shop/gacha", (route) => route.fulfill(json(GACHA)));
  // 강화 상세(`CardGrowthDetail`, #179)가 여는 카드 상태. 캐치올 `{}` 로는 모달이 못 뜬다.
  await page.route(
    (url) => url.pathname.startsWith("/api/growth/card/"),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop()!;
      const p = CATALOG.find((c) => c.id === id) ?? CATALOG[0]!;
      const caps = Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, Math.min(99, v + 20)]));
      const statLevels = Object.fromEntries(Object.keys(p.attributes).map((k) => [k, { level: 0, xp: 0 }]));
      route.fulfill(
        json({
          playerId: p.id, grade: p.grade, star: 1,
          attributes: p.attributes, prePotential: p.attributes, base: p.attributes,
          caps, statLevels,
          potential: { unlocked: false, tier: null, maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 9 },
          ovr: 58, completion: 0.3,
        }),
      );
    },
  );
  await page.route((url) => url.pathname === "/api/growth/dice", (route) =>
    route.fulfill(json({ normal: 5, cash: 3 })),
  );
}

async function login(page: Page) {
  await page.addInitScript(() => localStorage.setItem("hmb.auth.token", "test-token"));
}

/**
 * 페이지 안 모든 풀아트 카드.
 * `full-art-` 접두어는 **카드 노드 전용**이다(카드 안 자식 testid 는 `card-label-*` 등 다른 접두어) —
 * 안 그러면 카드 1장이 2개로 세진다. 경계 단언이 전부 이 접두어에 기대므로 계약의 일부다.
 */
const cards = (page: Page) => page.locator('[data-testid^="full-art-"]');

/** 실제로 픽셀이 실린 <img> 만 센다 — src 는 있는데 로드 실패한 것을 잡는다. */
async function brokenImages(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("img")]
      .filter((i) => i.getAttribute("src") && i.complete && i.naturalWidth === 0)
      .map((i) => i.getAttribute("src") ?? "?"),
  );
}

async function horizontalOverflow(page: Page): Promise<{ sw: number; cw: number }> {
  return page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

// ── ① 큰 화면에 풀아트가 뜬다 ───────────────────────────────────────────────

test("뽑기: 결과 11장이 **전부** 풀아트 카드다 (hero 확정 A안)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.goto("/shop");
  await page.getByTestId("gacha-ten").click();
  await expect(page.getByTestId("gacha-reveal")).toBeVisible();
  await page.getByTestId("gacha-reveal-all").click();

  await expect(cards(page)).toHaveCount(GACHA.results.length);
  // 공개된 카드는 전부 실제 아트까지 해석돼야 한다 — 프레임만 뜨면 매핑이 끊긴 것.
  const kinds = await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-art-kind")));
  expect(new Set(kinds)).toEqual(new Set(["full-art"]));
  expect(await brokenImages(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}card-art-gacha.png`, fullPage: true });
});

/**
 * 카드를 키우면서 리빌 시트가 한 화면에 안 들어가게 됐다. 그때 액션 바가 fold 아래로 내려가면
 * 버튼을 누르려고 스크롤한 위치 그대로 공개가 끝나 **결과 첫 행이 화면 위로 잘린다**
 * (독립 검증이 잡은 blocker: 데스크탑 73px · 모바일 119px 가림. 10연차 첫 행 = 최고 등급 자리).
 * 그래서 "가로 오버플로 0" 만으로는 부족하다 — **첫 카드가 실제로 보이는지**를 계약으로 박는다.
 */
for (const [label, w, h] of [["데스크탑", 1280, 900], ["모바일 390", 390, 844]] as const) {
  test(`뽑기: 모두 공개 후 **첫 행이 잘리지 않는다** (${label})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await login(page);
    await mockApi(page);
    await page.goto("/shop");
    await page.getByTestId("gacha-ten").click();
    await page.getByTestId("gacha-reveal-all").click();
    await expect(cards(page).first()).toBeVisible();

    const box = await page.evaluate(() => {
      const sheet = document.querySelector('[data-testid="gacha-reveal"]')!;
      const card0 = document.querySelector('[data-testid="gacha-card-0"]')!;
      return {
        hidden: sheet.getBoundingClientRect().top - card0.getBoundingClientRect().top,
        cardH: card0.getBoundingClientRect().height,
      };
    });
    // 첫 카드 윗변이 시트 윗변보다 위로 올라가 있으면(양수) 그만큼 잘린 것.
    expect(box.hidden, `첫 카드가 ${Math.round(box.hidden)}px 잘렸다 (카드 높이 ${Math.round(box.cardH)}px)`)
      .toBeLessThanOrEqual(0);

    /*
     * 고정 액션 바의 **반대쪽 실패**도 막는다: `bottom` 음수를 키우면 하단 행을 영구히 덮는데
     * 위 단언(첫 카드 상단)은 그걸 못 본다(독립 검증 minor-A). 바닥까지 스크롤한 상태에서
     * 마지막 카드가 액션 바에 가리지 않아야 한다 — sticky 푸터의 정상 동작(스크롤 중 일시 가림)과
     * 영구 가림을 가르는 지점이 바로 "끝까지 내렸을 때"다.
     */
    const cover = await page.evaluate(() => {
      const sheet = document.querySelector('[data-testid="gacha-reveal"]')!;
      sheet.scrollTop = sheet.scrollHeight;
      const cards = [...document.querySelectorAll('[data-testid^="gacha-card-"]')];
      const last = cards[cards.length - 1]!.getBoundingClientRect();
      const bar = document.querySelector('[data-testid="gacha-close"]')!.getBoundingClientRect();
      return Math.round(last.bottom - bar.top);
    });
    expect(cover, `바닥까지 내렸는데 마지막 카드가 액션 바에 ${cover}px 가린다`).toBeLessThanOrEqual(0);

    await page.screenshot({ path: `${SHOTS}card-art-reveal-top-${w}.png`, fullPage: true });
  });
}

/**
 * D4 — 등급색 링. 이 AC 는 "프레임 에셋의 LEGEND(#e4991c)와 GOLD(#d9a01e)가 육안 구분이 안 된다"는
 * 전제 위에 서 있어서, 링이 조용히 빠지면 등급 구분이 무너진다. 순수함수(`gradeRingShadow`)만
 * 단위테스트하면 **컴포넌트가 실제로 적용하는지는 아무도 안 본다** — 실제로 뮤테이션이 살아남았다.
 * 그래서 계산된 스타일을 직접 읽는다.
 */
test("등급색 링(D4)이 카드에 실제로 적용된다 — 등급별로 다른 색", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.goto("/shop");
  await page.getByTestId("gacha-ten").click();
  await page.getByTestId("gacha-reveal-all").click();
  await expect(cards(page).first()).toBeVisible();

  const seen = await cards(page).evaluateAll((els) =>
    els.map((e) => ({
      grade: e.getAttribute("data-grade"),
      shadow: getComputedStyle(e).boxShadow,
    })),
  );
  // web 등급색(common/grades.ts GRADE_COLORS)의 rgb 표현. 프레임 에셋 금색과 **다른 축**이어야 한다.
  const RGB: Record<string, string> = {
    BRONZE: "rgb(176, 121, 63)",
    SILVER: "rgb(184, 192, 204)",
    GOLD: "rgb(242, 199, 68)",
    DIA: "rgb(90, 200, 232)",
    LEGEND: "rgb(192, 124, 245)",
  };
  for (const { grade, shadow } of seen) {
    expect(shadow, `${grade} 카드에 링이 없다`).not.toBe("none");
    expect(shadow, `${grade} 링 색이 등급색이 아니다`).toContain(RGB[grade!]!);
  }
  // LEGEND 와 GOLD 가 실제로 **다른** 링을 갖는지 — 이게 D4 의 존재 이유다.
  const legend = seen.find((s) => s.grade === "LEGEND")?.shadow;
  const gold = seen.find((s) => s.grade === "GOLD")?.shadow;
  expect(legend, "LEGEND 표본 없음").toBeTruthy();
  expect(gold, "GOLD 표본 없음").toBeTruthy();
  expect(legend).not.toBe(gold);
});

test("덱: 선수를 누르면 유닛 정보(지시 레일)에 풀아트가 같이 뜬다", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.goto("/deck");

  const first = CATALOG[0]!;
  // 리스트 자체는 아이콘이다(경계) — 누르면 레일 컨텍스트가 그 선수로 바뀐다.
  await page.getByTestId(`pick-${first.id}`).click();
  const head = page.getByTestId("rail-head");
  await expect(head).toBeVisible();
  await expect(head.locator('[data-testid^="full-art-"]')).toHaveCount(1);
  await expect(head.locator('[data-testid^="full-art-"]')).toHaveAttribute("data-art-kind", "full-art");
  await page.screenshot({ path: `${SHOTS}card-art-deck-rail.png`, fullPage: true });
});

/**
 * main(#179)에서 도감 흐름이 바뀌었다: **보유 선수 탭 → 강화 상세 모달**, 인라인 확장은
 * **미보유(잠금) 전용**. 그래서 도감 자체는 어느 상태에서도 풀아트를 갖지 않는다 —
 * 잠긴 카드에 원색 전신 일러스트를 띄우면 잠금 표현과 어긋난다. 풀아트는 강화 상세가 갖는다.
 */
test("도감: 그리드·미보유 확장 어디에도 풀아트가 없다 (풀아트는 강화 상세)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.route((url) => url.pathname === "/api/players", (route) =>
    route.fulfill(json(CATALOG.map((p, i) => (i === 0 ? { ...p, owned: false, ownedCount: 0 } : p)))),
  );
  await page.goto("/codex");
  const locked = CATALOG[0]!;
  await expect(page.getByTestId(`codex-card-${locked.id}`)).toBeVisible();
  await expect(cards(page)).toHaveCount(0);

  // 미보유 카드는 인라인 확장(능력치만) — 풀아트가 붙지 않는다.
  await page.getByTestId(`codex-card-${locked.id}`).getByRole("button").first().click();
  await expect(page.getByTestId(`codex-attrs-${locked.id}`)).toBeVisible();
  await expect(cards(page), "잠긴 카드에 풀아트가 붙었다").toHaveCount(0);
});

// ── ② 아이콘/풀아트 경계 ────────────────────────────────────────────────────

test("경계: 덱 리스트 행·전술보드 토큰은 아이콘이다 (풀아트 침범 0)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.goto("/deck");

  const row = page.getByTestId(`pick-${CATALOG[0]!.id}`);
  await expect(row).toBeVisible();
  // 리스트 행 안에는 아바타만 — 풀아트가 들어오면 34px 자리에 전신 일러스트가 뭉개진다.
  await expect(row.locator('[data-testid^="full-art-"]')).toHaveCount(0);
  await expect(row.getByTestId(`char-avatar-${CATALOG[0]!.id}`)).toHaveCount(1);

  // 배치 후 전술보드 토큰도 아이콘. (슬롯 testid = `board-slot-<role>-<index>` — TacticsBoard.tsx)
  await row.click();
  await page.getByTestId("board-slot-starter-0").click();
  const token = page.locator('[data-testid^="token-"]').first();
  await expect(token).toBeVisible();
  await expect(token.locator('[data-testid^="full-art-"]')).toHaveCount(0);
  await expect(token.getByTestId(`char-avatar-${CATALOG[0]!.id}`)).toHaveCount(1);

  // 보드 전체로 넓혀도 풀아트 침범 0 — 슬롯은 얼굴 크롭만(hero 확정).
  await expect(page.getByTestId("tactics-board").locator('[data-testid^="full-art-"]')).toHaveCount(0);
});

test("경계: 도감 그리드(접힘)에 풀아트가 없다", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.goto("/codex");
  await expect(page.getByTestId("codex-grid")).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
});

/**
 * 트레이드 — **영입 대상(`slot.target`)만** 풀아트, 요구(내 선수)는 아이콘.
 * `TradeSlotCard` 는 target 을 **세 군데**(FA 오퍼 / 트레이드 오퍼 / 재제안 공개)에서 그리는데
 * 처음엔 한 곳에만 배선해 나머지 두 경로가 조용히 아이콘으로 남아 있었다(독립 검증 minor-B 로 발견).
 * 그래서 "카드가 있다"가 아니라 **어느 쪽에 붙었는지**를 단언한다.
 */
/**
 * `slotView()` 가 갈라지는 **세 경로 전부** 돈다. 한 상태(OPEN_TRADE)만 태우면 나머지 두 경로의
 * `fullArt` 를 떼어내도 초록이다 — 실제로 그 구멍 때문에 배선을 1/3 만 하고 놓쳤고,
 * 독립 검증이 "계약이 3경로를 대표하지 못한다"(M10·M11 생존)로 다시 잡았다.
 */
const TRADE_STATES = [
  { key: "OPEN_TRADE", withDemand: true, slot: { state: "OPEN", offerKind: "TRADE", acceptProbability: 0.8 } },
  { key: "OPEN_FA", withDemand: false, slot: { state: "OPEN", offerKind: "FA" } },
  { key: "WAITING_REVEALED", withDemand: false, slot: { state: "WAITING", offerKind: "TRADE", speedupCost: 300 } },
] as const;

for (const st of TRADE_STATES) {
  test(`트레이드(${st.key}): 영입 대상만 풀아트, 요구(내 선수)는 아이콘`, async ({ page }) => {
    const target = SEED.find((p) => p.grade === "DIA" && p.position === "MF")!;
    const demand = SEED.find((p) => p.grade === "GOLD" && p.position === "DF")!;
    const ref = (p: typeof target) => ({ playerId: p.id, name: p.name, position: p.position, grade: p.grade });

    await login(page);
    await mockApi(page);
    await page.route((url) => url.pathname === "/api/trade", (route) =>
      route.fulfill(
        json({
          wallet: { points: 9000 },
          slots: [
            {
              slot: 1,
              target: ref(target),
              demand: st.withDemand ? ref(demand) : null,
              targetValue: 91,
              targetGrade: target.grade,
              speedupCost: null,
              ...st.slot,
            },
          ],
        }),
      ),
    );
    await page.goto("/trade");

    const targetCard = page.getByTestId("trade-slot-1-target");
    await expect(targetCard, `${st.key} 에서 영입 대상 카드가 안 뜬다`).toBeVisible();
    await expect(
      targetCard.locator('[data-testid^="full-art-"]'),
      `${st.key} 의 영입 대상에 풀아트가 없다 (호출부 3곳 중 하나가 미배선)`,
    ).toHaveCount(1);
    await expect(targetCard.locator('[data-testid^="full-art-"]')).toHaveAttribute("data-art-kind", "full-art");

    if (st.withDemand) {
      const demandCard = page.getByTestId("trade-slot-1-demand");
      await expect(demandCard.locator('[data-testid^="full-art-"]'), "요구(내 선수)는 아이콘이어야 한다").toHaveCount(0);
      await expect(demandCard.getByTestId(`char-avatar-${demand.id}`)).toHaveCount(1);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const ov = await horizontalOverflow(page);
    expect(ov.sw, `${st.key} 390 가로 오버플로`).toBeLessThanOrEqual(ov.cw);
  });
}

/**
 * **강화/카드 상세**(`CardGrowthDetail`, #179) — 이 게임에서 가장 큰 카드 자리다.
 * 강화 화면이 일러스트를 고려하지 않고 만들어져 44px 아바타만 쓰고 있었고(hero 지적),
 * 도감·육성허브 **두 진입점**이 같은 모달을 연다 — 한 쪽만 확인하면 다른 쪽 회귀를 놓친다.
 */
for (const [label, path] of [["도감", "/codex"], ["육성허브", "/growth"]] as const) {
  test(`강화 상세(${label} 진입): 카드 풀아트가 뜬다`, async ({ page }) => {
    await login(page);
    await mockApi(page);
    await page.goto(path);
    const target = CATALOG[0]!;
    const gridCard = page.getByTestId(`codex-card-${target.id}`);
    await expect(gridCard).toBeVisible();

    // 두 진입 모두 **보유 선수는 1탭에 상세**가 열린다(도감 `onToggle` 은 owned 면 곧장
    // setDetailPlayer, 인라인 확장은 미보유 전용 — main #179). 2탭을 넣으면 모달을 다시 닫는다.
    await gridCard.getByRole("button").first().click();

    const detail = page.getByTestId("growth-detail");
    await expect(detail, "강화 상세가 안 열렸다").toBeVisible();
    const card = detail.locator('[data-testid^="full-art-"]');
    await expect(card, "강화 상세에 풀아트가 없다").toHaveCount(1);
    await expect(card).toHaveAttribute("data-art-kind", "full-art");
    // 아트만 쓰는 자리 = 프레임 이미지를 안 받는다(빈 밴드가 생기지 않는다는 뜻).
    await expect(card.locator('img[data-art-layer="frame"]')).toHaveCount(0);
    await expect(card.locator('img[data-art-layer="art"]')).toHaveCount(1);
    expect(await brokenImages(page)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}card-art-growth-${path.slice(1)}.png`, fullPage: true });
  });
}

/**
 * 경계 표(`apps/web/CLAUDE.md`)는 **매치 화면**도 아이콘으로 못 박았는데 계약이 비어 있었다
 * (독립 검증 minor). 동작은 정상이지만 계약이 없으면 다음 사람이 무심코 넣는다.
 */
test("경계: 매치·로비에 풀아트가 없다", async ({ page }) => {
  await login(page);
  await mockApi(page);
  for (const path of ["/lobby", "/match/1"]) {
    await page.goto(path);
    await page.waitForTimeout(700);
    await expect(cards(page), `${path} 에 풀아트가 새어들었다`).toHaveCount(0);
  }
});

// ── ③ 폴백 계단 ─────────────────────────────────────────────────────────────

test("폴백: 캐릭터 매핑이 없으면 등급 프레임 + 아이콘 (깨진 img 0)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  // 매핑만 비운다 → 캐릭터 축이 끊기고 프레임은 살아있다.
  await page.route((url) => url.pathname === "/chars/player-chars.json", (route) =>
    route.fulfill(json({ players: {} })),
  );
  await page.goto("/shop");
  await page.getByTestId("gacha-ten").click();
  await page.getByTestId("gacha-reveal-all").click();

  await expect(cards(page).first()).toHaveAttribute("data-art-kind", "frame-only");
  expect(await brokenImages(page)).toEqual([]);
  // 뒤집기 전환(0.45s)이 끝난 뒤에 찍는다 — 안 그러면 증빙 이미지에 카드 뒷면("?")만 남아
  // 리뷰어가 "폴백이 깨졌다"고 오판한다(독립 검증 minor).
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}card-art-fallback-frameonly.png`, fullPage: true });
});

test("폴백: manifest 는 멀쩡한데 **이미지만** 죽어도 계단이 내려간다 (onError)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  // manifest·매핑은 그대로 통과시키고 **PNG 만** 죽인다 → URL 해석은 성공(full-art)인데
  // 실제 로드가 실패하는 경로. manifest 부재만 막는 다른 폴백 테스트가 **못 잡는 구멍**이다
  // (뮤테이션 검사에서 `onError` 를 통째로 지워도 전부 통과해 실제로 드러났다).
  await page.route((url) => url.pathname.startsWith("/chars/") && url.pathname.endsWith(".png"), (route) =>
    route.abort(),
  );
  await page.goto("/shop");
  await page.getByTestId("gacha-ten").click();
  await page.getByTestId("gacha-reveal-all").click();
  await expect(cards(page).first()).toBeVisible();

  // 계단이 내려가야 한다: 이미지가 죽었으니 더 이상 full-art 가 아니다.
  //
  // ⚠️ **첫 카드만** 본다. `loading="lazy"` 라 화면 밖 카드는 요청 자체를 안 하고, 따라서
  //    error 도 안 나 `full-art` 로 남는다(정상 동작). 전체를 단언하면 뷰포트·스크롤에 따라
  //    깜빡이는 flaky 테스트가 된다 — 실제로 그렇게 만들었다가 되돌렸다.
  //    `toHaveAttribute` 는 재시도하므로 onError → setState 비동기도 안전하게 기다린다.
  await expect(
    cards(page).first(),
    "이미지 로드 실패 후에도 full-art 로 남아 있으면 폴백 계단이 안 내려간 것",
  ).toHaveAttribute("data-art-kind", "none");
  // 실패한 <img> 를 DOM 에 남겨두면 깨진 이미지 아이콘이 그대로 보인다.
  expect(await brokenImages(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}card-art-fallback-onerror.png`, fullPage: true });
});

test("폴백: /chars 가 통째로 없어도 화면이 산다 (CSS 폴백, 깨진 img 0)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.route((url) => url.pathname.startsWith("/chars/"), (route) => route.abort());
  await page.goto("/shop");
  await page.getByTestId("gacha-ten").click();
  await page.getByTestId("gacha-reveal-all").click();

  await expect(cards(page)).toHaveCount(GACHA.results.length);
  const kinds = await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-art-kind")));
  expect(new Set(kinds)).toEqual(new Set(["none"]));
  // 이 경로가 진짜 계약이다: 에셋 미배포로 카드가 빈 사각형이 되면 안 된다.
  expect(await brokenImages(page)).toEqual([]);
  await expect(page.getByTestId("gacha-reveal")).toBeVisible();
  await page.waitForTimeout(700); // 플립 전환 완료 후 캡처(위와 같은 이유)
  await page.screenshot({ path: `${SHOTS}card-art-fallback-none.png`, fullPage: true });
});

// ── ④ 등급↔프레임 정합 · 모바일 오버플로 ────────────────────────────────────

test("등급↔프레임 정합: 카드가 자기 등급 프레임을 쓴다 (5등급 전부)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.goto("/shop");
  await page.getByTestId("gacha-ten").click();
  await page.getByTestId("gacha-reveal-all").click();
  await expect(cards(page).first()).toBeVisible();

  const pairs = await cards(page).evaluateAll((els) =>
    els.map((e) => ({
      grade: e.getAttribute("data-grade"),
      frame: e.querySelector('img[data-art-layer="frame"]')?.getAttribute("src") ?? null,
    })),
  );
  expect(pairs.length).toBe(GACHA.results.length);
  for (const { grade, frame } of pairs) {
    expect(frame, `${grade} 프레임`).toBe(`/chars/frame-${grade}.png`);
  }
  // 목 카탈로그가 5등급을 다 태웠는지 — 안 그러면 이 계약이 일부만 검사한다.
  expect(new Set(pairs.map((p) => p.grade)).size).toBe(5);
});

test("모바일 390: 뽑기·도감 어디서도 가로 스크롤이 생기지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await mockApi(page);

  await page.goto("/shop");
  await page.getByTestId("gacha-ten").click();
  await page.getByTestId("gacha-reveal-all").click();
  await expect(cards(page).first()).toBeVisible();
  const shop = await horizontalOverflow(page);
  expect(shop.sw, `뽑기 가로 오버플로 (${shop.sw} > ${shop.cw})`).toBeLessThanOrEqual(shop.cw);
  await page.screenshot({ path: `${SHOTS}card-art-mobile-gacha.png`, fullPage: true });

  await page.goto("/codex");
  await page.getByTestId(`codex-card-${CATALOG[0]!.id}`).getByRole("button").first().click();
  await expect(cards(page).first()).toBeVisible();
  const codex = await horizontalOverflow(page);
  expect(codex.sw, `도감 가로 오버플로 (${codex.sw} > ${codex.cw})`).toBeLessThanOrEqual(codex.cw);
  await page.screenshot({ path: `${SHOTS}card-art-mobile-codex.png`, fullPage: true });
});
