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
 *    ⚠️ **중앙 히트테스트만으로는 공허했다.** 390×844 실측에서 [확인] 바닥은 786.8, 탭바 상단은
 *    788.5 — **1.7px** 차라 `--z-modal` 을 10 으로 되돌려도 이 스펙이 **통과했다**(변이 검증에서
 *    들켰다). 일반화하면 버튼 바닥 `0.95·vh − 15` > 탭바 상단 `vh − 55.5` ⇔ **vh < 810** 이므로
 *    깨지는 곳은 844 가 아니라 **흔한 폰 가시높이**다 → 계약을 두 축으로 다시 세웠다:
 *      ⓐ 버튼이 탭바 밴드에 **한 픽셀도** 들어가지 않는다(중앙이 아니라 **바닥 가장자리**)
 *      ⓑ **390×664 에서도** 같은 것을 잰다(여기서 구 레이아웃이 실제로 죽는다)
 *    ⚠️ 자기전제도 바꿨다 — 자리를 비우는 것이 수정이라 시트는 이제 탭바와 **안 겹친다**.
 *    대신 *시트가 탭바 바로 위까지 차 있다*(여유 < 40px)를 단언한다. 안 그러면 시트가 짧은 날
 *    계약이 아무것도 안 보고 통과한다.
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
      // 뷰포트 밖 좌표는 `elementFromPoint` 가 null 을 주므로 `hit` 이 곧 "화면 안에서 눌린다"다
      // — 별도 `inViewport` 필드는 아무도 읽지 않아 지웠다(독립검증 MIN-3).
      return { hit: !!(top && target && target.contains(top)) };
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

/**
 * 세로 844(툴바 없는 이상적 폰) · 664(툴바가 덮은 실제 가시높이) · **500**(가로모드·큰 글꼴).
 *
 * ⚠️ **500 을 "대체값을 죽이는 칸"으로 읽지 마라** — 실측하면 `max-height: 100%` 로 되돌려도
 * 세 뷰포트가 **전부 통과한다**(오버레이가 이미 탭바 자리를 비워 둬서 퍼센트도 그만큼 줄어든다).
 * 이 루프가 죽이는 변이는 **상한 자체를 지우는 것**이고, 그건 세 칸 모두에서 죽는다.
 * 500 은 그러니 형태 판별이 아니라 **가로모드·큰 글꼴 커버리지**로 있는 칸이다.
 */
for (const vh of [844, 664, 500]) {
  test(`① 10연뽑 [확인] 버튼이 하단 탭바에 가리지 않는다 — 390×${vh} (좌표·히트테스트)`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: vh });
    await auth(page);
    await mock(page);
    await page.goto("/recruit");

    await page.getByTestId("gacha-ten").click();
    await expect(page.getByTestId("gacha-reveal")).toBeVisible();
    await revealAllAndSettle(page);

    const g = await page.evaluate(() => {
      const rect = (s: string) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
      };
      return { sheet: rect('[data-testid="gacha-reveal"]'), nav: rect("nav"), close: rect('[data-testid="gacha-close"]') };
    });

    // 자기전제 ⓐ — 탭바가 실제로 그려져 있다(없으면 가림 계약이 통째로 공허하다).
    expect(g.nav.height, "탭바가 없는 화면에서 재고 있다").toBeGreaterThan(0);
    // 자기전제 ⓑ — 시트가 탭바 **바로 위**까지 차 있다. 여유가 남아돌면 어떤 구현도 통과한다.
    expect(g.nav.top - g.sheet.bottom, "시트가 탭바에서 멀면 빡빡한 상태를 안 재는 것이다").toBeLessThan(40);

    // 계약 ⓐ — 버튼이 탭바 밴드에 **한 픽셀도** 들어가지 않는다.
    expect(g.close.bottom, "[확인] 아랫부분이 탭바 밴드 안이다").toBeLessThanOrEqual(g.nav.top);

    // 계약 ⓑ — 그 버튼의 **바닥 가장자리**를 눌러도 그 버튼이 맞는다(중앙만 재면 1.7px 를 놓친다).
    const bottomEdge = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="gacha-close"]')!;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.bottom - 2);
      return { inViewport: r.bottom - 2 < window.innerHeight, hit: !!(top && el.contains(top)) };
    });
    expect(bottomEdge.inViewport, "[확인] 아랫부분이 뷰포트 밖이다").toBe(true);
    expect(bottomEdge.hit, "[확인] 아랫부분을 누르면 다른 요소(하단 탭바)가 먼저 맞는다").toBe(true);

    const close = await hits(page, "gacha-close");
    expect(close.hit, "[확인] 중앙을 누르면 다른 요소가 먼저 맞는다").toBe(true);

    // 실제로 눌려서 닫힌다 — 히트테스트가 참인데 못 닫히면 그것도 결함이다.
    await page.getByTestId("gacha-close").click();
    await expect(page.getByTestId("gacha-reveal")).toHaveCount(0);
  });
}

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

  /**
   * ⚠️ **위 단언들은 카탈로그가 도착한 상태만 본다.** 홈 타일의 부제는 갈래가 둘이고
   * (`보유 n / N` ↔ 폴백), 목 로스터가 24명이라 위에서는 **폴백 가지에 도달조차 하지 않는다**
   * — 실제로 그 가지에 `보유 선수와 도감` 이 남아 있었는데 계약은 초록이었다(독립검증 MAJ-1).
   * 카탈로그가 비어 오는 상태(신규 유저·구 서버 `{}`)를 따로 태운다.
   */
  await page.route((url) => url.pathname === "/api/players", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.goto("/home");
  await expect(page.getByTestId("home-tile-players")).toContainText("선수");
  await expect(
    page.getByTestId("home-tile-players"),
    "카탈로그가 비었을 때의 폴백 부제에 '도감'이 남아 있다",
  ).not.toContainText("도감");
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

  /**
   * ⚠️ **첫 카드가 LEGEND 라는 단언만으로는 공허하다** — 목 로스터는 `owned: i < 16` +
   * `PLAYERS[0] = P001`(LEGEND) 이라 **정렬을 떼도** 보유가 앞이고 첫 칸이 LEGEND 다
   * (`sortByStrength` 를 `CodexPage.tsx` 에서 제거해도 통과했다, 독립검증 BL-1).
   * 이 표본에서 정렬이 실제로 하는 일은 **구간 안에서 등급을 내림차순으로 다시 세우는 것**이다
   * — 원본 순서는 `LEGEND,DIA,GOLD,SILVER,BRONZE,LEGEND,…` 로 5칸마다 등급이 **되올라간다**.
   * 그래서 계약도 첫 칸이 아니라 **구간 전체의 단조성**으로 건다.
   */
  const gradeOf = (id: string) => PLAYERS.find((p) => p.id === id)!.grade;
  // ⚠️ 앱의 `GRADE_ORDER` 를 import 하지 않는다 — 같은 상수를 쓰면 순서를 뒤집는 변이가 통과한다
  //    (apps/web/CLAUDE.md 「초록으로 거짓말하는 방식」 ②). 기대 순서는 여기에 리터럴로 적는다.
  const STRONG_FIRST = ["LEGEND", "DIA", "GOLD", "SILVER", "BRONZE"];
  const rankOf = (id: string) => STRONG_FIRST.indexOf(gradeOf(id));
  for (const owned of [true, false]) {
    const seg = order.filter((row) => row.owned === owned).map((row) => rankOf(row.id));
    expect(seg.length, `${owned ? "보유" : "미보유"} 구간이 비었다 — 단조성 검사가 공허해진다`).
      toBeGreaterThan(4);
    // 강한 등급이 0 이므로 정렬된 구간은 **비내림차순**이다. 뒤에서 더 강한 등급이 나오면 위반.
    const drops = seg.filter((r, i) => i > 0 && r < seg[i - 1]!).length;
    expect(
      drops,
      `${owned ? "보유" : "미보유"} 구간에서 등급이 되올라간다 — 등급 정렬이 안 걸렸다 (${seg.join(",")})`,
    ).toBe(0);
  }
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
