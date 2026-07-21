import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * W3 트레이드 route-mock 스모크 (AC-D + #149 능동화) — **백엔드 없이**(server 병렬 구현 중) vite dev +
 * page.route 로 /api 를 목킹해 IDLE/WAITING/OPEN 3상태 렌더·능동 플로우([장 시작!]/[거래 안함])·
 * 등급 마스킹·390px 오버플로 0·카운트다운 동작을 계약으로 박제한다. 라이브 왕복은 통합 게이트에서 별도.
 * 스크린샷 = apps/web/.smoke/.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

/** IDLE — 장이 닫힘. 모든 오퍼 필드 null(#149). */
const IDLE_SLOT = {
  slot: 1, state: "IDLE", offerKind: null, target: null, demand: null,
  targetGrade: null, speedupCost: null,
};
/**
 * WAITING — 등급만 공개. 서버가 target/demand/targetValue 를 null 로 감춘다(#149).
 * `offerKind` 는 **마스킹 대상이 아니다** — 라이브 서버는 대기 중에도 FA/TRADE 를 내려준다
 * (검증자 실측). 목이 라이브보다 관대하면 버그를 못 잡으므로 실제 값에 맞춘다.
 */
const WAITING_SLOT = {
  slot: 1, state: "WAITING", offerKind: "FA", target: null, demand: null,
  targetGrade: "GOLD", opensAt: "2026-07-21T12:00:00Z", remainingSec: 125, speedupCost: 300,
};
const WAITING_SLOT_2 = { ...WAITING_SLOT, slot: 2, targetGrade: "DIA", remainingSec: 240 };
/**
 * WAITING 인데 이미 공개됐던 오퍼 — FA 제안 실패 후 재제안 쿨타임. 서버가 target/targetValue 를
 * 계속 채워 보낸다(이미 본 선수를 도로 가리지 않는다, openapi-v2 TradeSlot).
 */
const WAITING_REVEALED_SLOT = {
  slot: 3, state: "WAITING", offerKind: "FA", demand: null,
  target: { playerId: "P042", name: "FA 스트라이커", position: "FW", grade: "DIA" },
  targetGrade: "DIA", targetValue: 91,
  opensAt: "2026-07-21T12:00:00Z", remainingSec: 90, speedupCost: 150,
};
const OPEN_FA_SLOT = {
  slot: 2, state: "OPEN", offerKind: "FA",
  target: { playerId: "P042", name: "FA 스트라이커", position: "FW", grade: "DIA" },
  demand: null, targetValue: 91, targetGrade: "DIA",
};
const OPEN_TRADE_SLOT = {
  slot: 3, state: "OPEN", offerKind: "TRADE",
  target: { playerId: "P077", name: "대가 플레이메이커", position: "MF", grade: "GOLD" },
  demand: { playerId: "P010", name: "내 센터백", position: "DF", grade: "SILVER" },
  acceptProbability: 0.8, targetGrade: "GOLD",
};

/** 기본 목: IDLE 1 + WAITING(등급만 = 가려짐) 2 + OPEN-TRADE 3. */
const TRADE_RESPONSE = {
  wallet: { points: 1200 },
  slots: [IDLE_SLOT, WAITING_SLOT_2, OPEN_TRADE_SLOT],
};

const attrs = {
  technical: 74, mental: 68, physical: 80, passing: 71, shooting: 85,
  tackling: 55, pace: 82, stamina: 70, positioning: 77,
};
const PLAYERS_RESPONSE = [
  { id: "P010", name: "내 센터백", position: "DF", grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs, personality: "CALM" },
  { id: "P011", name: "내 윙어", position: "FW", grade: "GOLD", owned: true, ownedCount: 2, attributes: attrs, personality: "FIERY" },
  { id: "P042", name: "FA 스트라이커", position: "FW", grade: "DIA", owned: false, ownedCount: 0, attributes: attrs, personality: "AMBITIOUS" },
  { id: "P077", name: "대가 플레이메이커", position: "MF", grade: "GOLD", owned: false, ownedCount: 0, attributes: attrs, personality: "CALM" },
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * `slotsFor()` 를 매 요청마다 평가해 목 상태를 갱신할 수 있게 한다(장 시작 → 재조회 시 WAITING).
 * `onStart(slotNo)` 는 서버 상태 전이를 흉내내고 새 슬롯을 돌려준다.
 * 반환 배열 = POST /api/trade/{n}/start 로 들어온 요청 슬롯 기록(계약 검증용).
 */
async function mockApi(
  page: Page,
  opts: { slotsFor?: () => unknown[]; onStart?: (slotNo: number) => unknown } = {},
) {
  const slotsFor = opts.slotsFor ?? (() => TRADE_RESPONSE.slots);
  const startCalls: number[] = [];
  // pathname 으로 매칭(glob '**/api/**' 는 vite 소스 /src/api/*.ts 까지 잡아 모듈로딩을 깬다).
  // Playwright 는 나중에 등록한 핸들러가 우선 — catch-all 먼저, 구체 라우트 뒤에.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );
  await page.route(
    (url) => url.pathname === "/api/trade",
    (route) => route.fulfill(json({ wallet: TRADE_RESPONSE.wallet, slots: slotsFor() })),
  );
  await page.route(
    (url) => /^\/api\/trade\/[123]\/start$/.test(url.pathname),
    (route) => {
      const slotNo = Number(new URL(route.request().url()).pathname.split("/")[3]);
      startCalls.push(slotNo);
      const slot = opts.onStart?.(slotNo) ?? { ...WAITING_SLOT, slot: slotNo };
      route.fulfill(json({ slot, wallet: TRADE_RESPONSE.wallet }));
    },
  );
  await page.route(
    (url) => url.pathname === "/api/players",
    (route) => route.fulfill(json(PLAYERS_RESPONSE)),
  );
  return startCalls;
}

async function seedAuth(page: Page) {
  // RequireAuth 통과용 토큰 시드(백엔드 없이).
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
}

test("W3 trade route-mock: IDLE/WAITING/OPEN 렌더 + 등급 마스킹 + 390px 오버플로 0 + 카운트다운", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page);
  await seedAuth(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trade");

  // 3슬롯이 각기 다른 view 로 렌더.
  await expect(page.getByTestId("trade-slot-1")).toHaveAttribute("data-view", "IDLE");
  await expect(page.getByTestId("trade-slot-2")).toHaveAttribute("data-view", "WAITING");
  await expect(page.getByTestId("trade-slot-3")).toHaveAttribute("data-view", "OPEN_TRADE");

  // IDLE: 장이 닫혀 있고 [장 시작!] 만 노출(오퍼 콘텐츠 없음).
  await expect(page.getByTestId("trade-slot-1-badge")).toContainText("장 닫힘");
  await expect(page.getByTestId("trade-slot-1-start")).toBeVisible();
  await expect(page.getByTestId("trade-slot-1-countdown")).toHaveCount(0);

  // WAITING: 등급은 보이고 선수 정체는 감춰진다(마스킹 회귀 가드).
  await expect(page.getByTestId("trade-slot-2")).toHaveAttribute("data-reveal", "MASKED");
  await expect(page.getByTestId("trade-slot-2-grade")).toContainText("다이아");
  await expect(page.getByTestId("trade-slot-2-countdown")).toContainText("공개까지");
  await expect(page.getByTestId("trade-slot-2-target")).toHaveCount(0);
  await expect(page.getByTestId("trade-slot-2-speedup")).toBeVisible();
  const waitingText = (await page.getByTestId("trade-slot-2").innerText()) ?? "";
  for (const name of PLAYERS_RESPONSE.map((p) => p.name)) {
    expect(waitingText).not.toContain(name);
  }
  // WAITING 에서는 재시작 불가(서버 400) — 버튼 자체가 없다.
  await expect(page.getByTestId("trade-slot-2-start")).toHaveCount(0);
  await expect(page.getByTestId("trade-slot-2-skip")).toHaveCount(0);

  // OPEN-TRADE: 서버 확률 + 액션은 [수락]/[거래 안함] 둘뿐(#149 — 구 [거절] 제거).
  await expect(page.getByTestId("trade-slot-3-prob")).toContainText("80%");
  await expect(page.getByTestId("trade-slot-3-accept")).toBeVisible();
  await expect(page.getByTestId("trade-slot-3-skip")).toBeVisible();
  await expect(page.getByTestId("trade-slot-3-decline")).toHaveCount(0);

  // 카운트다운 동작: ~2s 뒤 값이 줄어든다(서버 remainingSec 앵커 - 로컬 경과).
  const cd = page.getByTestId("trade-slot-2-countdown");
  const before = Number(await cd.getAttribute("data-remaining"));
  await page.waitForTimeout(2100);
  const after = Number(await cd.getAttribute("data-remaining"));
  console.log(`[smoke] countdown ${before} → ${after}`);
  expect(after).toBeLessThan(before);
  expect(before - after).toBeGreaterThanOrEqual(1);

  // 390px 가로 오버플로 0.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] 390px horizontal overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.screenshot({ path: `${SMOKE_DIR}w3-trade-mobile390.png`, fullPage: true });

  // 데스크탑(≥1024px): 3슬롯 병렬.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);
  const overflowDesk = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] 1280px horizontal overflow px = ${overflowDesk}`);
  expect(overflowDesk).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SMOKE_DIR}w3-trade-desktop.png`, fullPage: false });
});

test("W3 trade 능동 플로우(#149): [장 시작!] → POST start → WAITING(등급만) 렌더", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  // 서버 상태 시뮬: start 성공 후 재조회하면 슬롯 1 이 WAITING 으로 바뀐다.
  let slot1: unknown = IDLE_SLOT;
  const startCalls = await mockApi(page, {
    slotsFor: () => [slot1, OPEN_FA_SLOT, OPEN_TRADE_SLOT],
    onStart: () => {
      slot1 = WAITING_SLOT;
      return WAITING_SLOT;
    },
  });
  await seedAuth(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trade");

  await expect(page.getByTestId("trade-slot-1")).toHaveAttribute("data-view", "IDLE");
  await page.getByTestId("trade-slot-1-start").click();

  // 요청이 실제로 나가고, 무효화된 캐시 재조회로 WAITING 이 렌더된다.
  await expect(page.getByTestId("trade-slot-1")).toHaveAttribute("data-view", "WAITING");
  await expect(page.getByTestId("trade-slot-1-grade")).toContainText("골드");
  await expect(page.getByTestId("trade-slot-1-countdown")).toBeVisible();
  // 이름 노출 금지(장 시작 직후에도 정체는 비공개).
  const waitingText = await page.getByTestId("trade-slot-1").innerText();
  for (const name of PLAYERS_RESPONSE.map((p) => p.name)) {
    expect(waitingText).not.toContain(name);
  }
  console.log(`[smoke] start calls = ${JSON.stringify(startCalls)}`);
  expect(startCalls).toEqual([1]);
  await page.screenshot({ path: `${SMOKE_DIR}w3-trade-start-waiting.png`, fullPage: true });
});

test("W3 trade 능동 플로우(#149): OPEN-FA [거래 안함] → POST start(재롤)", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  let slot2: unknown = OPEN_FA_SLOT;
  const startCalls = await mockApi(page, {
    slotsFor: () => [IDLE_SLOT, slot2, OPEN_TRADE_SLOT],
    onStart: () => {
      // 거래 안함 = 새 오퍼·새 대기(등급도 새로 롤).
      slot2 = { ...WAITING_SLOT, slot: 2, targetGrade: "SILVER" };
      return slot2;
    },
  });
  await seedAuth(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trade");

  // FA 카드의 기존 UI(대상·제안빌더·확률노트)는 유지된다.
  await expect(page.getByTestId("trade-slot-2")).toHaveAttribute("data-view", "OPEN_FA");
  await expect(page.getByTestId("trade-slot-2-target")).toBeVisible();
  await expect(page.getByTestId("propose-builder")).toBeVisible();
  await expect(page.getByTestId("propose-prob-note")).toBeVisible();

  const [request] = await Promise.all([
    page.waitForRequest((r) => new URL(r.url()).pathname === "/api/trade/2/start" && r.method() === "POST"),
    page.getByTestId("trade-slot-2-skip").click(),
  ]);
  console.log(`[smoke] skip → ${request.method()} ${new URL(request.url()).pathname}`);

  // 새 오퍼로 카운트다운 재시작(응답 반영).
  await expect(page.getByTestId("trade-slot-2")).toHaveAttribute("data-view", "WAITING");
  await expect(page.getByTestId("trade-slot-2-grade")).toContainText("실버");
  await expect(page.getByTestId("trade-slot-2-countdown")).toBeVisible();
  console.log(`[smoke] start calls = ${JSON.stringify(startCalls)}`);
  expect(startCalls).toEqual([2]);
  await page.screenshot({ path: `${SMOKE_DIR}w3-trade-skip-reroll.png`, fullPage: true });
});

test("W3 trade WAITING 분기(#149): 공개된 채 쿨타임(재제안 대기)은 선수 카드를 유지한다", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  // 슬롯 2 = 가려진 대기(티저), 슬롯 3 = 이미 공개된 채 쿨타임(FA 제안 실패 후).
  await mockApi(page, { slotsFor: () => [IDLE_SLOT, WAITING_SLOT_2, WAITING_REVEALED_SLOT] });
  await seedAuth(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trade");

  // 가려진 대기: 마스크 티저(등급만).
  await expect(page.getByTestId("trade-slot-2")).toHaveAttribute("data-reveal", "MASKED");
  await expect(page.getByTestId("trade-slot-2-grade")).toBeVisible();
  await expect(page.getByTestId("trade-slot-2-target")).toHaveCount(0);

  // 공개된 채 쿨타임: 선수 카드 유지 + 마스크 없음 + "재제안까지" + 단축 버튼 노출.
  const revealed = page.getByTestId("trade-slot-3");
  await expect(revealed).toHaveAttribute("data-view", "WAITING");
  await expect(revealed).toHaveAttribute("data-reveal", "REVEALED");
  await expect(page.getByTestId("trade-slot-3-target")).toBeVisible();
  await expect(revealed).toContainText("FA 스트라이커");
  await expect(page.getByTestId("trade-slot-3-grade")).toHaveCount(0);
  await expect(page.getByTestId("trade-slot-3-countdown")).toContainText("재제안까지");
  await expect(page.getByTestId("trade-slot-3-speedup")).toBeVisible();
  // 대기 중이라 제안/거래안함은 불가.
  await expect(page.getByTestId("propose-builder")).toHaveCount(0);
  await expect(page.getByTestId("trade-slot-3-skip")).toHaveCount(0);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] revealed-cooldown 390px overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.waitForTimeout(450); // 카드 pop 애니메이션(0.35s) 종료 후 캡처 — 정착 상태를 남긴다.
  await page.screenshot({ path: `${SMOKE_DIR}w3-trade-waiting-revealed.png`, fullPage: true });
});
