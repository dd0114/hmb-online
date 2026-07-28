/**
 * #207 W3-D — hero 입고 실아트 소비 계약 + **실화면 증빙**.
 *
 * 여기서 보는 것(전부 목 API — 라이브 백엔드에 붙지 않는다):
 *   ① 완성 카드 2종이 **프레임 중복 없이** 자기 규격으로 뜬다(구워진 이름·별이 이중이 아니다)
 *   ② 디폴트 유닛(도트)이 확대돼도 `pixelated` 로 선명하다
 *   ③ 도감 비활성 카드에 **"off"** 가 붙는다(U-D7)
 *
 * 좌표 추론 금지 — 캡처를 남겨 눈으로 확인한다(루트 §2-2).
 */
import { test, expect, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";
import { readFileSync } from "node:fs";

const SHOTS = new URL("../.smoke/", import.meta.url).pathname;

const SEED: Array<{ id: string; name: string; position: string; grade: string; active: boolean }> = JSON.parse(
  readFileSync(new URL("../../../data/players/players.v2.3.json", import.meta.url).pathname, "utf8"),
);
const UNITS = JSON.parse(
  readFileSync(new URL("../../../design/characters/dist/units/manifest.json", import.meta.url).pathname, "utf8"),
) as { units: Record<string, { card: { kind: string }; forPlayer?: string }> };

/**
 * 발행 manifest 가 권위 — 완성 카드 유닛명을 스펙에 박지 않는다(인벤토리 정정 전례).
 * #207 재발행으로 보날두·욱링엄이 프레임리스가 되어 **현재 `complete` 은 0종**이다.
 * 그래서 완성 카드 테스트는 표본이 있을 때만 돌고(`test.skip`), 실아트 계약은 아래
 * 프레임리스 축 테스트가 계속 지킨다. 발행측이 다시 complete 을 실으면 자동으로 되살아난다.
 */
const COMPLETE_PLAYER_IDS = Object.values(UNITS.units)
  .filter((u) => u.card.kind === "complete" && u.forPlayer)
  .map((u) => u.forPlayer!);
const FRAMELESS_PLAYER_IDS = Object.values(UNITS.units)
  .filter((u) => u.card.kind === "frameless-art" && u.forPlayer)
  .map((u) => u.forPlayer!);

const attrs = {
  technical: 70, mental: 71, physical: 72, passing: 73,
  shooting: 74, tackling: 75, pace: 76, stamina: 77, positioning: 78,
};
const row = (p: (typeof SEED)[number], owned: boolean) => ({
  id: p.id, name: p.name, position: p.position, grade: p.grade,
  owned, ownedCount: owned ? 1 : 0, active: p.active, attributes: attrs,
});

/**
 * 실아트를 가진 LEGEND **전원**(활성 5 + 활성화 대기분) + 실아트 없는 비활성 LEGEND 2(off 대상)
 * + GOLD/BRONZE 각 1(디폴트 유닛).
 *
 * ⚠️ 표본을 `active` 로 고르지 않는다 — 3차 입고(2026-07-29)부터 **아트 입고와 활성화가 분리**돼
 * (아트 머지 → 배포 → 어드민 토글) 신규 유닛은 한동안 `active:false` 로 남는다. `active` 로
 * 거르면 새로 들어온 아트가 **실화면 검증에서 조용히 빠진다** — 실제로 P180 이 그럴 뻔했다.
 * 그래서 **발행물의 `forPlayer` 힌트**를 기준으로 잡아 입고 때마다 표본이 자동으로 늘게 한다.
 */
const UNIT_PLAYER_IDS = Object.values(UNITS.units).map((u) => u.forPlayer).filter((id): id is string => !!id);
const CATALOG = [
  ...SEED.filter((p) => UNIT_PLAYER_IDS.includes(p.id)).map((p) => row(p, true)),
  ...SEED.filter((p) => p.grade === "LEGEND" && !p.active && !UNIT_PLAYER_IDS.includes(p.id))
    .slice(0, 2).map((p) => row(p, true)),
  ...SEED.filter((p) => p.grade === "GOLD").slice(0, 1).map((p) => row(p, true)),
  ...SEED.filter((p) => p.grade === "BRONZE").slice(0, 1).map((p) => row(p, true)),
];

// #232: 뽑기는 유상재화 결제(economy `gacha.currency`)라 gems 가 있어야 버튼이 열린다 —
// 무료재화만 채워 두면 이 스펙의 주제(카드 규격)와 무관하게 클릭이 막힌다.
const ME = {
  nickname: "tester",
  points: 10_000,
  wallet: { points: 10_000, gems: 10_000 },
  records: { wins: 0, draws: 0, losses: 0 },
};
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function login(page: Page) {
  await page.addInitScript(() => localStorage.setItem("hmb.auth.token", "test-token"));
}

async function mockApi(page: Page) {
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  // #232: 뽑기 가격·결제 재화는 서버 config 에서 온다 — 목이 없으면 버튼이 잠긴다.
  await mockAppConfig(page);
  await page.route((url) => url.pathname === "/api/me", (r) => r.fulfill(json(ME)));
  await page.route((url) => url.pathname === "/api/players", (r) => r.fulfill(json(CATALOG)));
  await page.route((url) => url.pathname === "/api/deck", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route((url) => url.pathname === "/api/relations", (r) =>
    r.fulfill(json({ morale: 50, streak: 0, players: [] })));
  await page.route((url) => url.pathname === "/api/conditions", (r) => r.fulfill(json({ players: {} })));
  // 강화 상세가 여는 카드 상태 — 캐치올 `{}` 를 주면 모달이 렌더 중 터져 아예 안 뜬다.
  await page.route((url) => url.pathname.startsWith("/api/growth/card/"), (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop()!;
    const p = CATALOG.find((c) => c.id === id) ?? CATALOG[0]!;
    const caps = Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, Math.min(99, v + 20)]));
    const statLevels = Object.fromEntries(Object.keys(p.attributes).map((k) => [k, { level: 0, xp: 0 }]));
    r.fulfill(json({
      playerId: p.id, grade: p.grade, star: 1,
      attributes: p.attributes, prePotential: p.attributes, base: p.attributes,
      caps, statLevels,
      potential: { unlocked: false, tier: null, maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 9 },
      ovr: 58, completion: 0.3,
    }));
  });
  await page.route((url) => url.pathname === "/api/shop/gacha", (r) => r.fulfill(json({
    results: CATALOG.map((p, i) => ({
      player: { id: p.id, name: p.name, position: p.position, grade: p.grade }, isNew: i % 3 === 0,
    })),
    wallet: { points: 500 },
  })));
}

/** 깨진 <img> 0 — 어떤 폴백 경로에서도 지켜야 하는 계약. */
async function brokenImages(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("img")]
      .filter((i) => i.complete && i.naturalWidth === 0 && !!i.getAttribute("src"))
      .map((i) => i.getAttribute("src")!),
  );
}

/**
 * 아트가 **실제로 디코드돼 그려졌는지** 기다린다.
 *
 * ⚠️ `brokenImages` 로는 이걸 못 잡는다 — 아직 로딩 중인 <img> 는 `complete === false` 라
 * 필터를 그냥 통과한다(깨진 것도, 그려진 것도 아니다). 그래서 "요소는 붙었고 깨지지도
 * 않았는데 화면엔 아무것도 없는" 상태가 계약을 통과했고, 실제로 3차 입고 캡처에서
 * 경니시우스(P180)만 아트 자리가 **빈 채로** 찍혔다(다른 5종은 우연히 캐시에 있었다).
 * 캡처를 눈으로 보지 않았으면 green 으로 넘어갔을 자리다(루트 §2-2).
 */
async function expectArtPainted(page: Page, card: ReturnType<Page["locator"]>) {
  await expect
    .poll(
      async () =>
        card.locator("img[data-art-fit]").evaluateAll((imgs) =>
          imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0),
        ),
      { message: "아트 <img> 가 디코드되지 않았다(자리는 있는데 그림이 없다)" },
    )
    .toBe(true);
}

/**
 * **뽑기 그리드 줄맞춤** — #207 재발행의 직접적인 목적.
 *
 * 재발행 전에는 완성 카드 2종만 2:3(512×768)이고 나머지는 합성 카드 226×425(≈1:1.88)라
 * 그리드 첫 줄이 들쭉날쭉했다(hero 확인 항목). 완성 카드가 0종이 되면서 **모든 카드가 같은
 * 규격**이 된다 — 그걸 눈이 아니라 실제 박스 크기로 박는다. 캡처도 같이 남긴다(증빙).
 */
for (const [label, w, h] of [["데스크탑", 1280, 900], ["모바일390", 390, 844]] as const) {
  test(`뽑기 그리드: 카드 규격이 전부 같다 — 줄맞춤 (${label})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await login(page);
    await mockApi(page);
    await page.goto("/shop");
    await page.getByTestId("gacha-ten").click();
    await page.getByTestId("gacha-reveal-all").click();
    const cards = page.locator('[data-testid^="full-art-"]');
    await expect(cards).toHaveCount(CATALOG.length);
    await page.waitForTimeout(700); // 뒤집기 전환(0.45s) 완료 후 — 뒷면만 찍히지 않게

    const boxes = await cards.evaluateAll((els) =>
      els.map((e) => {
        const b = e.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      }),
    );
    // 규격이 하나여야 한다 — 종류가 둘 이상이면 그 줄이 어긋난다.
    expect(new Set(boxes.map((b) => `${b.w}x${b.h}`)).size, JSON.stringify(boxes)).toBe(1);
    expect(await brokenImages(page)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}unit-art-grid-${w}.png`, fullPage: true });
  });
}

test("도감: 보유 비활성 카드에 'off' 가 붙고 활성에는 없다 (U-D7)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.goto("/codex");

  const inactive = CATALOG.filter((p) => p.active === false);
  const active = CATALOG.filter((p) => p.active !== false);
  expect(inactive.length).toBeGreaterThan(0);
  expect(active.length).toBeGreaterThan(0);
  for (const p of inactive) {
    await expect(page.getByTestId(`codex-off-${p.id}`), `${p.id} off 누락`).toHaveText("off");
  }
  for (const p of active) {
    await expect(page.getByTestId(`codex-off-${p.id}`), `${p.id} 에 off 오출력`).toHaveCount(0);
  }
  expect(await brokenImages(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}unit-art-codex-off.png`, fullPage: true });
});

test("강화 상세: 실아트 LEGEND 전종이 프레임리스 축으로 뜬다 (U-D8 재발행 후)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  expect(FRAMELESS_PLAYER_IDS.length, "프레임리스 실아트 표본이 비었다").toBeGreaterThan(0);

  // 카탈로그에 실린(=활성 LEGEND) 프레임리스 유닛만 — 디폴트 유닛은 별도 테스트가 본다.
  const ids = FRAMELESS_PLAYER_IDS.filter((id) => CATALOG.some((c) => c.id === id));
  expect(ids.length, "활성 LEGEND 실아트가 카탈로그 표본에 없다").toBeGreaterThan(0);
  for (const id of ids) {
    await page.goto("/codex");
    await expect(page.getByTestId(`codex-card-${id}`)).toBeVisible();
    await page.getByTestId(`codex-card-${id}`).getByRole("button").first().click();
    await expect(page.getByTestId("growth-detail"), "강화 상세가 안 열렸다").toBeVisible();
    const card = page.getByTestId("growth-detail").locator('[data-testid^="full-art-"]');
    await expect(card).toHaveAttribute("data-art-kind", "unit-art");
    // 아트는 창을 **채운다**(크롭 오프셋을 쓰면 실아트가 잘린다).
    await expect(card.locator('img[data-art-fit="fill"]')).toHaveCount(1);
    // ⚠️ 여기(강화 상세)는 `variant="art"` 라 프레임 층이 **없는 것이 정상**이다 —
    //    이름·등급·별을 카드 밖에서 이미 보여주므로 프레임을 깔면 빈 밴드가 남는다(모듈 계약).
    //    "프레임 정확히 한 겹"은 카드 통짜를 쓰는 뽑기 그리드에서 본다(`p3-card-art.spec.ts`).
    await expect(card.locator('img[data-art-layer="frame"]')).toHaveCount(0);
    expect(await brokenImages(page)).toEqual([]);
    await expectArtPainted(page, card);
    await page.screenshot({ path: `${SHOTS}unit-art-frameless-${id}.png` });
  }
});

test("강화 상세: 완성 카드는 프레임 중복 없이 자기 규격으로 뜬다 (U-D8)", async ({ page }) => {
  test.skip(COMPLETE_PLAYER_IDS.length === 0, "발행물에 완성 카드가 0종 — 계약은 유닛 테스트가 픽스처로 지킨다");
  await login(page);
  await mockApi(page);

  for (const id of COMPLETE_PLAYER_IDS) {
    await page.goto("/codex");
    await expect(page.getByTestId(`codex-card-${id}`)).toBeVisible();
    await page.getByTestId(`codex-card-${id}`).getByRole("button").first().click();
    await expect(page.getByTestId("growth-detail"), "강화 상세가 안 열렸다").toBeVisible();
    const card = page.getByTestId("growth-detail").locator('[data-testid^="full-art-"]');
    await expect(card).toHaveAttribute("data-art-kind", "unit-complete");
    // 프레임 층 0 = frame-<GRADE>.png 를 안 받는다(두 겹 방지). 아트는 통짜 1장.
    await expect(card.locator('img[data-art-layer="frame"]')).toHaveCount(0);
    await expect(card.locator('img[data-art-fit="whole"]')).toHaveCount(1);
    expect(await brokenImages(page)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}unit-art-complete-${id}.png` });
  }
});

test("강화 상세: 디폴트 유닛(도트)은 확대해도 pixelated 로 그린다 (U-D8)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.goto("/codex");
  const gold = CATALOG.find((p) => p.grade === "GOLD")!;
  await expect(page.getByTestId(`codex-card-${gold.id}`)).toBeVisible();
  await page.getByTestId(`codex-card-${gold.id}`).getByRole("button").first().click();
  await expect(page.getByTestId("growth-detail"), "강화 상세가 안 열렸다").toBeVisible();
  const card = page.getByTestId("growth-detail").locator('[data-testid^="full-art-"]');
  await expect(card).toHaveAttribute("data-art-kind", "unit-art");
  const art = card.locator('img[data-art-layer="art"]');
  await expect(art).toHaveAttribute("src", /art-default-unit\.png$/);
  expect(await art.evaluate((el) => getComputedStyle(el).imageRendering)).toBe("pixelated");
  expect(await brokenImages(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}unit-art-default-dot.png` });
});
