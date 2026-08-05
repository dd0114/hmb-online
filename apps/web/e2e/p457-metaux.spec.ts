import { expect, test, type Page } from "@playwright/test";
import { mockAll, ME, PLAYERS } from "./p286-mocks";
import { appConfigPayload, mockAppConfig } from "./app-config-mock";
import { revealAllAndSettle } from "./gacha-reveal-settle";

/**
 * 메타 화면 개편 계약 (#457 — C 뽑기 · D 선수).
 *
 * ① **C2 가림 해소** — hero 제보: *"뽑고 나면 확인버튼이 안보여. 하단 바에 가려져."*
 *    ⚠️ `toBeVisible()` 로 쓰면 **가림을 못 잡는다**(DOM 에 있으면 통과) — 루트 §초록 거짓말 ③.
 *    그래서 **좌표 + `elementFromPoint`** 로 "그 점을 누르면 그 버튼이 눌리나"를 잰다(#294 선례).
 *    ⚠️ 그리고 **자기전제를 단언한다**: 시트가 실제로 탭바 밴드와 겹치는 상태에서 재고 있는지.
 *    안 그러면 시트가 짧은 날 계약이 아무것도 안 보고 통과한다.
 * ② **C2 뒤로가기** — 부재였던 손잡이(영입 헤더).
 * ③ **D 개명** — 홈 타일 `선수` · 화면 제목 `선수`.
 * ④ **D 정렬** — 획득한 좋은 카드 순(등급 내림차순이 첫 화면에 온다).
 * ⑤ **D 강화 UX** — 목록 뱃지 → 선택지 먼저 → [나중에] → **빛나는 버튼** → 다시 선택지.
 *
 * 백엔드 무접촉(`page.route`, pathname 매칭 — 오리진 없는 글롭은 vite 에셋까지 가로챈다).
 */

const PHONE = { width: 390, height: 844 };
test.use({ viewport: PHONE, hasTouch: true });

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** 뽑기 결과 — 10연뽑(11장)이라야 시트가 90vh 를 채워 **가림 조건이 실제로 생긴다**. */
const TEN = {
  results: PLAYERS.slice(0, 11).map((p, i) => ({
    player: { id: p.id, name: p.name, position: p.position, grade: p.grade },
    isNew: i === 0,
  })),
  wallet: { points: 21_300, gems: 940 },
};

/** 강화 선택 대기 — 목록 뱃지·상세 배너의 근거(`GET /api/growth/choices`). */
const PENDING_ID = PLAYERS.find((p) => p.owned && p.grade === "LEGEND")!.id;
const CHOICE = {
  choiceId: "c-457",
  playerId: PENDING_ID,
  source: "MATCH",
  candidates: [
    { stat: "shooting", gain: 3.2, core: true, why: "이 경기 슛 4회" },
    { stat: "passing", gain: 2.4, core: false, why: "패스 성공 21회" },
    { stat: "tackling", gain: 1.8, core: false, why: "태클 2회" },
  ],
};

async function mock(page: Page) {
  await mockAll(page);
  await mockAppConfig(page);
  // ⚠️ 뽑기 결제 재화는 **다이아**다(config 목 기본값) — 공용 목의 기본 잔액(1,240)으로는 10연(3,000)
  //    버튼이 잠겨 이 스펙이 "가림"이 아니라 "잔액 부족"을 검사하게 된다. 잔액을 올려 문을 연다.
  await page.route((url) => url.pathname === "/api/me", (r) =>
    r.fulfill(json({ ...ME, wallet: { points: 24_300, gems: 24_000 } })),
  );
  await page.route((url) => url.pathname === "/api/shop/gacha", (r) => r.fulfill(json(TEN)));
  await page.route((url) => url.pathname === "/api/growth/choices", (r) => r.fulfill(json({ choices: [CHOICE] })));
  await page.route(
    (url) => url.pathname.startsWith("/api/growth/card/"),
    (r) => {
      const id = r.request().url().split("/api/growth/card/")[1]!.split("?")[0]!;
      const attrs = Object.fromEntries(
        ["technical", "mental", "physical", "passing", "shooting", "tackling", "pace", "stamina", "positioning"].map(
          (k) => [k, 70],
        ),
      );
      return r.fulfill(
        json({
          playerId: id,
          grade: PLAYERS.find((p) => p.id === id)?.grade ?? "GOLD",
          star: 1,
          attributes: attrs,
          prePotential: attrs,
          base: attrs,
          caps: Object.fromEntries(Object.keys(attrs).map((k) => [k, 82])),
          statAdd: {},
          growCeil: 72,
          starCeilBonus: 1,
          attrHardCap: 99,
          startLo: 50,
          pendingChoices: id === PENDING_ID ? [CHOICE] : [],
          potential: { unlocked: false, tier: "RARE", maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 9 },
          ovr: 58,
          completion: 0.3,
        }),
      );
    },
  );
}

/** 로그인 우회 — 다른 목 스펙과 같은 방식(토큰만 심는다). */
async function auth(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });
}

/** `elementFromPoint` 로 그 점의 실제 최상단 요소가 대상(또는 그 자손)인지 본다. */
async function hits(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} 의 좌표를 못 잡았다`).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  return await page.evaluate(
    ({ cx, cy, testId }) => {
      const top = document.elementFromPoint(cx, cy);
      const target = document.querySelector(`[data-testid="${testId}"]`);
      return { inViewport: cy > 0 && cy < window.innerHeight, hit: !!(top && target && target.contains(top)) };
    },
    { cx, cy, testId },
  );
}

test("⓪ C1 홍보 구역 — 확률은 서버가 줄 때만 뜬다 (지어내지 않는다)", async ({ page }) => {
  await auth(page);
  await mock(page);
  await page.goto("/recruit");

  // 카드 2장 위에 "왜 지금 뽑나"를 말하는 구역이 있다.
  const promo = page.getByTestId("gacha-promo");
  await expect(promo).toBeVisible();
  await expect(promo).toContainText("레전드");
  await expect(page.getByTestId("gacha-promo-grades").locator("li")).toHaveCount(5);

  // 오늘 서버(#458 이전)는 확률을 안 준다 → 표가 **아예 없다**.
  await expect(page.getByTestId("gacha-rates")).toHaveCount(0);
  // 그리고 손으로 적은 보장 문구도 남아 있지 않다(#213 부류 — 서버가 안 준 약속).
  await expect(page.locator("body")).not.toContainText("골드 이상 1명 보장");

  // #458 이 랜딩하면 **코드 변경 없이** 켜진다 — config 에 rates 를 실어 그 축을 지금 태운다.
  await page.route((url) => url.pathname === "/api/config", (r) =>
    r.fulfill(
      json({
        ...appConfigPayload(),
        shop: {
          ...appConfigPayload().shop,
          gacha: {
            ...appConfigPayload().shop.gacha,
            rates: { BRONZE: 0.45, SILVER: 0.3, GOLD: 0.15, DIA: 0.08, LEGEND: 0.02 },
            tenPityMinGrade: "GOLD",
          },
        },
      }),
    ),
  );
  await page.reload();
  await expect(page.getByTestId("gacha-rates")).toBeVisible();
  await expect(page.getByTestId("gacha-rate-LEGEND")).toContainText("2%");
  await expect(page.locator("body")).toContainText("골드 이상 1명 보장");
});

test("① 10연뽑 [확인] 버튼이 하단 탭바에 가리지 않는다 (좌표·히트테스트)", async ({ page }) => {
  await auth(page);
  await mock(page);
  await page.goto("/recruit");

  await page.getByTestId("gacha-ten").click();
  await expect(page.getByTestId("gacha-reveal")).toBeVisible();
  await revealAllAndSettle(page);

  // 자기전제 — 시트가 **실제로** 탭바 밴드와 겹치는 상태에서 재고 있다(안 겹치면 이 계약은 공허하다).
  const overlap = await page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="gacha-reveal"]')!.getBoundingClientRect();
    const nav = document.querySelector("nav")!.getBoundingClientRect();
    return Math.min(sheet.bottom, nav.bottom) - Math.max(sheet.top, nav.top);
  });
  expect(overlap, "시트와 탭바가 안 겹치면 가림 계약이 공허하다").toBeGreaterThan(0);

  const close = await hits(page, "gacha-close");
  expect(close.inViewport, "[확인] 이 뷰포트 밖이다").toBe(true);
  expect(close.hit, "[확인] 을 누르면 다른 요소(하단 탭바)가 먼저 맞는다").toBe(true);

  // 실제로 눌려서 닫힌다 — 히트테스트가 참인데 못 닫히면 그것도 결함이다.
  await page.getByTestId("gacha-close").click();
  await expect(page.getByTestId("gacha-reveal")).toHaveCount(0);
});

test("② 영입 화면에 뒤로가기가 있다 (부재였던 손잡이)", async ({ page }) => {
  await auth(page);
  await mock(page);
  await page.goto("/recruit");
  const back = await hits(page, "recruit-back");
  expect(back.hit, "뒤로가기가 다른 요소에 가려 있다").toBe(true);
  await page.getByTestId("recruit-back").click();
  await expect(page).toHaveURL(/\/home$/);
});

test("③ 개명 — 홈 타일과 화면 제목이 '선수'다", async ({ page }) => {
  await auth(page);
  await mock(page);
  await page.goto("/home");
  await expect(page.getByTestId("home-tile-players")).toContainText("선수");
  await expect(page.getByTestId("home-tile-players")).not.toContainText("도감");

  await page.goto("/players");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("선수");
  // 화면 전체 텍스트에 '도감'이 남아 있으면 개명이 절반만 된 것이다.
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  expect(body).not.toContain("도감");
});

test("④ 정렬 — 보유 좋은 카드가 먼저 온다", async ({ page }) => {
  await auth(page);
  await mock(page);
  await page.goto("/players");
  await page.getByTestId("codex-scope-all").click();

  const order = await page
    .getByTestId("codex-grid")
    .locator('[data-testid^="codex-card-"]')
    .evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute("data-testid")!.replace("codex-card-", ""),
        owned: el.getAttribute("data-owned") === "true",
      })),
    );
  expect(order.length).toBeGreaterThan(4);

  // 보유가 앞, 미보유가 뒤 — 경계가 한 번만 바뀐다(섞이면 정렬이 안 걸린 것).
  const flips = order.filter((row, i) => i > 0 && order[i - 1]!.owned !== row.owned).length;
  expect(flips, "보유/미보유가 섞여 있다").toBe(1);

  // 보유 구간 첫 카드는 **최고 등급**이다(mock 로스터에 LEGEND 보유가 있다).
  const gradeOf = (id: string) => PLAYERS.find((p) => p.id === id)!.grade;
  expect(gradeOf(order[0]!.id)).toBe("LEGEND");
});

test("⑤ 강화 — 목록 뱃지 → 선택지 먼저 → [나중에] → 빛나는 버튼 → 다시 선택지", async ({ page }) => {
  await auth(page);
  await mock(page);
  await page.goto("/players");

  // 목록에서 "할 일이 있다"가 보인다. 대기 없는 카드에는 안 붙는다(양성/음성 둘 다).
  await expect(page.getByTestId(`codex-growth-${PENDING_ID}`)).toBeVisible();
  const other = PLAYERS.find((p) => p.owned && p.id !== PENDING_ID)!.id;
  await expect(page.getByTestId(`codex-growth-${other}`)).toHaveCount(0);

  // 열면 **선택지가 먼저** 온다(펼침 기본).
  await page.getByTestId(`codex-card-${PENDING_ID}`).getByRole("button").first().click();
  await expect(page.getByTestId("growth-detail")).toBeVisible();
  await expect(page.getByTestId("growth-pending-banner")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("choice-candidates").locator("button")).toHaveCount(3);

  // [나중에] → 선택지가 접히고 **빛나는 버튼**이 그 자리를 지킨다(회색 '펼치기'가 아니다).
  await page.getByTestId("growth-pending-toggle").click();
  await expect(page.getByTestId("choice-candidates")).toHaveCount(0);
  const glow = page.getByTestId("growth-pending-open");
  await expect(glow).toBeVisible();
  const animated = await glow.evaluate((el) => {
    const s = getComputedStyle(el);
    return { name: s.animationName, dur: s.animationDuration };
  });
  expect(animated.name, "글로우 애니메이션이 없다 — hero 요구는 '빛이 들어왔다 나갔다'다").not.toBe("none");
  expect(animated.dur).not.toBe("0s");

  // 다시 누르면 선택지로 돌아온다 — 미룬 강화가 막다른 길이 되지 않는다.
  await glow.click();
  await expect(page.getByTestId("choice-candidates").locator("button")).toHaveCount(3);
});
