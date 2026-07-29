import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";
import { readFileSync } from "node:fs";

/**
 * 고레어 뽑기 이펙트 배선 계약 (#250).
 *
 * 여기서 지키는 것은 **눈으로 못 잡는 부분**이다 — 빛이 예쁜지는 hero 컨펌(`/design/gacha-fx`)과
 * 실화면 캡처가 판정하고, 이 파일은 "발동하는가 / 순서가 맞는가 / 결과가 먼저 새지 않는가"를 본다.
 *
 *   ① 두 경로 **모두** 발동한다 — 개별 탭 · 일괄 공개(요구 3·4)
 *   ② **결과가 먼저 새지 않는다** — 빛이 모이는 동안 카드는 뒷면이다(anticipation 의 정의).
 *      이게 깨지면 연출이 남아 있어도 기대감은 사라지므로, 이 스펙의 핵심이다.
 *   ③ 레전드는 **다이아인 척하다가 격상**한다(A → B → 개봉). A 구간엔 레전드 전용 층이 없다.
 *   ④ 비고레어는 **지금과 똑같이 즉시** 열린다(대조군이 느려지면 전체 체감이 나빠진다).
 *
 * 백엔드 없이 돈다: `/api/**` 목킹(라우트 매처는 **오리진 앵커** — 상대 글롭이면 에셋까지 가로챈다).
 */

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** 목 로스터는 **발행물에서 조인**한다 — 손으로 적으면 등급이 실제 시드와 어긋난다. */
const SEED: Array<{ id: string; name: string; position: string; grade: string }> = JSON.parse(
  readFileSync(new URL("../../../data/players/players.v2.3.json", import.meta.url).pathname, "utf8"),
);
const pick = (grade: string, n: number) => SEED.filter((p) => p.grade === grade).slice(0, n);

const ME = {
  nickname: "tester",
  points: 10_000,
  wallet: { points: 10_000, gems: 10_000 },
  records: { wins: 0, draws: 0, losses: 0 },
};

/**
 * 표본 구성이 곧 계약이다 — **비고레어가 앞, 고레어가 뒤**에 오게 짠다.
 * 고레어를 0번에 두면 "순서대로 공개"만으로도 첫 클릭에 걸려서, 스태거·대조군 검사가 공허해진다.
 */
const ROSTER = [...pick("BRONZE", 2), ...pick("SILVER", 1), ...pick("DIA", 2), ...pick("LEGEND", 1)];
const IDX = { bronze0: 0, silver: 2, dia0: 3, dia1: 4, legend: 5 };

const GACHA = {
  results: ROSTER.map((p, i) => ({
    player: { id: p.id, name: p.name, position: p.position, grade: p.grade },
    isNew: i === 0,
  })),
  wallet: { points: 500 },
};

/** 고레어가 **하나도 없는** 대조군 응답 — 연출이 붙지 않아야 한다. */
const GACHA_LOW = {
  results: [...pick("BRONZE", 3), ...pick("GOLD", 2)].map((p) => ({
    player: { id: p.id, name: p.name, position: p.position, grade: p.grade },
    isNew: false,
  })),
  wallet: { points: 500 },
};

async function mockApi(page: Page, gacha: unknown = GACHA) {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  // 뽑기 가격·결제 재화가 config 에서 오므로 목이 없으면 버튼이 잠겨 클릭이 안 된다(#232).
  await mockAppConfig(page);
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json(ME)));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/deck", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route((url) => url.pathname === "/api/shop/gacha", (route) => route.fulfill(json(gacha)));
}

async function openPull(page: Page, gacha: unknown = GACHA) {
  // ⚠️ 키는 `hmb.auth.token` 이다. 틀리면 /login 으로 튕겨 상점 버튼이 영영 안 나오고,
  // 스펙은 "실패"가 아니라 **타임아웃까지 매달린다**(처음에 그렇게 몇 분을 날렸다).
  await page.addInitScript(() => localStorage.setItem("hmb.auth.token", "test-token"));
  await mockApi(page, gacha);
  await page.goto("/shop");
  await page.getByTestId("gacha-ten").click();
  await expect(page.getByTestId("gacha-reveal")).toBeVisible();
}

const card = (page: Page, i: number) => page.getByTestId(`gacha-card-${i}`);
/** 카드를 감싼 이펙트 무대 — 단계·티어·위장 여부를 속성으로 노출한다. */
const stage = (page: Page, i: number) =>
  page.locator(`[data-testid="gacha-fx-stage"]:has([data-testid="gacha-card-${i}"])`);

/** 개별 공개로 index 번째까지 트리거한다(현행 조작 = 누르면 다음 장이 열린다). */
async function advanceTo(page: Page, index: number) {
  for (let i = 0; i <= index; i += 1) await page.getByTestId("gacha-reveal-next").click();
}

test.describe("#250 고레어 이펙트 — 발동 계약", () => {
  test("① 개별 공개: 고레어 카드는 빛이 모이는 동안 **뒷면**이고, 그 뒤에 열린다", async ({ page }) => {
    await openPull(page);
    await advanceTo(page, IDX.dia0);

    // 트리거 직후 = A 구간. 카드는 아직 뒷면이어야 한다 — 여기가 이 스펙의 핵심이다.
    await expect(stage(page, IDX.dia0)).toHaveAttribute("data-fx-phase", "charge");
    await expect(card(page, IDX.dia0)).toHaveAttribute("data-revealed", "false");
    // 연출이 실제로 붙었다(등급 판정이 화면까지 왔다).
    await expect(stage(page, IDX.dia0)).toHaveAttribute("data-fx-tier", "epic");

    // 기다리면 열린다. 시간을 스펙에 적지 않는다 — config 를 튜닝하면 곧바로 거짓 실패가 된다.
    await expect(card(page, IDX.dia0)).toHaveAttribute("data-revealed", "true", { timeout: 10_000 });
  });

  test("② 비고레어는 지연 없이 즉시 열린다 (대조군이 느려지지 않는다)", async ({ page }) => {
    await openPull(page);
    await advanceTo(page, IDX.bronze0);
    // 이펙트 무대 자체가 붙지 않는다 = 연출 경로를 아예 타지 않는다.
    await expect(stage(page, IDX.bronze0)).toHaveAttribute("data-fx-tier", "none");
    await expect(card(page, IDX.bronze0)).toHaveAttribute("data-revealed", "true", { timeout: 2_000 });
  });

  test("③ 레전드: A 구간엔 **다이아인 척**하고(전용 층 없음), B 로 격상한 뒤에야 열린다", async ({ page }) => {
    await openPull(page);
    await advanceTo(page, IDX.legend);

    // A — 위장 중. 티어 선언이 `epic` 이라 CSS 의 레전드 전용 규칙이 통째로 안 걸린다.
    await expect(stage(page, IDX.legend)).toHaveAttribute("data-fx-disguised", "true");
    await expect(stage(page, IDX.legend)).toHaveAttribute("data-fx-tier", "epic");
    await expect(card(page, IDX.legend)).toHaveAttribute("data-revealed", "false");

    // B — 격상. 아직도 뒷면이다(B 중에 열리면 카드 프레임이 곧 정답이라 위장이 무의미해진다).
    await expect(stage(page, IDX.legend)).toHaveAttribute("data-fx-phase", "surge", { timeout: 10_000 });
    await expect(stage(page, IDX.legend)).toHaveAttribute("data-fx-tier", "legend");
    await expect(stage(page, IDX.legend)).toHaveAttribute("data-fx-disguised", "false");
    await expect(card(page, IDX.legend)).toHaveAttribute("data-revealed", "false");

    // 개봉 → 확장 피날레(카드 밖 시트 전체).
    await expect(card(page, IDX.legend)).toHaveAttribute("data-revealed", "true", { timeout: 10_000 });
    await expect(page.getByTestId("gacha-fx-finale")).toBeVisible({ timeout: 10_000 });
  });

  test("③-b B 구간이 실제로 **그려진다** — 단계가 바뀌어도 애니메이션이 재시작한다", async ({ page }) => {
    /*
     * 독립검증 MJ-1: `GachaFx.tsx` 의 `key={phase}` 를 지워도 전 게이트가 green 이었다. 그런데
     * 실제로는 B 구간이 **통째로 빈 화면**이 된다 — CSS 애니메이션은 `animation-name` 이 그대로면
     * 클래스가 바뀌어도 재시작하지 않아서, B 진입 시점엔 이미 "끝난" 상태(opacity 0)로 계산된다.
     * 단계·색만 보는 계약은 이걸 못 잡는다(속성은 멀쩡하다). **그려진 픽셀의 근거**를 봐야 한다.
     */
    await openPull(page);
    await advanceTo(page, IDX.legend);
    await expect(stage(page, IDX.legend)).toHaveAttribute("data-fx-phase", "surge", { timeout: 10_000 });

    // surge 진입 직후 잠깐 뒤 — 이 구간에서 이펙트 요소 중 **하나라도** 실제로 보여야 한다.
    await page.waitForTimeout(200);
    const visible = await stage(page, IDX.legend).evaluate((el) =>
      [...el.querySelectorAll("span, div")].filter((n) => {
        const cls = n.className.toString();
        if (!/ray|ring|orb|beat|escalate/.test(cls)) return false;
        const cs = getComputedStyle(n);
        return Number.parseFloat(cs.opacity) > 0.01 && cs.animationName !== "none";
      }).length,
    );
    expect(visible, "B(surge) 구간에 그려지는 이펙트 요소가 0개다 — 애니메이션이 재시작되지 않았다").toBeGreaterThan(0);
  });

  test("④ 일괄 공개: 고레어가 섞여 있으면 발동하고, **클라이맥스(레전드)가 마지막**에 온다", async ({ page }) => {
    await openPull(page);
    await page.getByTestId("gacha-reveal-all").click();

    // 비고레어는 즉시, 고레어는 아직 뒷면 — 일괄이라고 전부 한꺼번에 뒤집히지 않는다.
    await expect(card(page, IDX.bronze0)).toHaveAttribute("data-revealed", "true", { timeout: 2_000 });
    await expect(card(page, IDX.dia0)).toHaveAttribute("data-revealed", "false");
    await expect(card(page, IDX.legend)).toHaveAttribute("data-revealed", "false");

    // 다이아가 먼저 열리고, 그때도 레전드는 아직 닫혀 있다(= 낮은 등급 → 높은 등급 순서).
    await expect(card(page, IDX.dia0)).toHaveAttribute("data-revealed", "true", { timeout: 10_000 });
    await expect(card(page, IDX.legend)).toHaveAttribute("data-revealed", "false");

    await expect(card(page, IDX.legend)).toHaveAttribute("data-revealed", "true", { timeout: 15_000 });
    await expect(page.getByTestId("gacha-fx-finale")).toBeVisible({ timeout: 10_000 });
  });

  test("⑤ 확인 버튼이 뜬 **그 순간** 모든 카드의 연출이 끝나 있다 (클라이맥스가 잘리지 않는다)", async ({ page }) => {
    /*
     * ⚠️ 이 스펙은 원래 "클릭 직후 hidden → 결국 visible" 만 봤는데, 그건 **위반 상태에서도 통과**한다.
     * 실제로 `useRevealFx` 의 경계 중복 때문에 다이아 카드가 `done` 을 두 번 통지했고 완료 집계가
     * 부풀어, 확인 버튼이 **피날레보다 1초 먼저** 떴다(독립검증 BL-1: 확인 2362ms vs 피날레 3373ms).
     * 그 상태로 확인을 누르면 레전드 확장 피날레가 **한 번도 재생되지 않는다** = AC2 소실.
     * 그래서 "언젠가 보인다"가 아니라 **보이는 순간의 전 카드 상태**를 단언한다.
     */
    await openPull(page);
    await page.getByTestId("gacha-reveal-all").click();
    await expect(page.getByTestId("gacha-close")).toBeHidden();
    await expect(page.getByTestId("gacha-close")).toBeVisible({ timeout: 20_000 });

    // 확인이 보이는 시점 = 모든 stage 가 done. 하나라도 재생 중이면 그 연출이 잘릴 수 있다.
    const phases = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="gacha-fx-stage"]')].map(
        (el) => el.getAttribute("data-fx-phase") ?? "?",
      ),
    );
    expect(phases.filter((p) => p !== "done"), `확인 버튼 시점에 아직 재생 중인 카드: ${phases}`).toEqual([]);
    // 앞면도 전부 확정돼 있어야 한다(뒷면인 채로 닫을 수 있으면 결과를 못 본다).
    for (let i = 0; i < GACHA.results.length; i += 1) {
      await expect(card(page, i)).toHaveAttribute("data-revealed", "true");
    }
  });

  test("⑥ 고레어가 없는 뽑기는 예전과 같다 — 연출 0, 즉시 종료", async ({ page }) => {
    await openPull(page, GACHA_LOW);
    await page.getByTestId("gacha-reveal-all").click();
    // 확인 버튼이 곧바로 나온다 = 기다릴 연출이 없다.
    await expect(page.getByTestId("gacha-close")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId("gacha-fx-finale")).toHaveCount(0);
    for (let i = 0; i < GACHA_LOW.results.length; i += 1) {
      await expect(stage(page, i)).toHaveAttribute("data-fx-tier", "none");
    }
  });
});

/**
 * 모션 최소화 — **끄는 게 아니라 축약**이다. 연출을 통째로 지우면 "고레어를 뽑았다"는 정보가
 * 화면에서 사라져 등급 라벨만 남는다.
 *
 * 이 블록이 있는 이유: 이 경로는 **두 번 조용히 깨졌다**. ①키프레임 이름만 갈아끼워 duration 을
 * 물려받는 바람에 87ms 깜빡임이 됐고 ②단계를 추가할 때 `.ph_surge` 를 빠뜨려 B 구간이
 * **신호 0 + 카드는 계속 흔들림**이 됐다(독립검증 BL-2). 둘 다 "선언은 있는데 화면엔 없는" 부류라
 * 속성이 아니라 **computed 스타일**을 봐야 잡힌다.
 */
test.describe("#250 모션 최소화 — 신호는 남고 움직임만 빠진다", () => {
  test("A·B 두 구간 모두: 카드는 안 움직이고, 등급색 신호는 보인다", async ({ page }) => {
    /*
     * ⚠️ `test.use({ reducedMotion })` 는 **이 설정에서 먹지 않는다**(실측: describe·파일 스코프 둘 다
     * `matchMedia(...).matches === false`). 그대로 뒀다면 이 스펙은 모션 최소화를 검사하는 척하면서
     * **평상시 경로**를 통과시켰을 것이다 — 공허한 계약이 된다. `page.emulateMedia` 는 실측 true.
     */
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await openPull(page);

    /*
     * 단계마다 밖에서 폴링하면 **B 를 놓친다** — 축약 타이밍의 surge 는 380ms 뿐이라 A 를 재고
     * 돌아오면 이미 지나가 있다. 그래서 페이지 안에 관찰자를 심어 **전환 시점마다 표본을 남긴다**.
     */
    await page.evaluate(() => {
      const w = window as unknown as { __fx?: Record<string, { anim: string; signals: number; peak: number }> };
      w.__fx = {};
      const el = document.querySelector('[data-testid="gacha-fx-stage"]:has([data-testid="gacha-card-5"])');
      if (!el) throw new Error("stage 없음");
      const sample = () => {
        const phase = el.getAttribute("data-fx-phase") ?? "?";
        const holder = el.firstElementChild as HTMLElement | null;
        const ops = [...el.querySelectorAll("span, div")]
          .filter((n) => /ring|aura|beat|flash/.test(n.className.toString()))
          .map((n) => Number.parseFloat(getComputedStyle(n).opacity))
          .filter((o) => o > 0.05);
        w.__fx![phase] = {
          anim: holder ? getComputedStyle(holder).animationName : "?",
          signals: ops.length,
          peak: ops.length ? Math.max(...ops) : 0,
        };
      };
      sample();
      new MutationObserver(sample).observe(el, { attributes: true, attributeFilter: ["data-fx-phase"] });
    });

    await advanceTo(page, IDX.legend);
    await expect(card(page, IDX.legend)).toHaveAttribute("data-revealed", "true", { timeout: 10_000 });

    const fx = await page.evaluate(
      () => (window as unknown as { __fx: Record<string, { anim: string; signals: number; peak: number }> }).__fx,
    );
    // 두 구간이 실제로 표본에 잡혔는가(안 잡혔으면 아래 단언이 공허해진다).
    expect(Object.keys(fx), `표본: ${JSON.stringify(fx)}`).toEqual(expect.arrayContaining(["charge", "surge"]));

    for (const phase of ["charge", "surge"] as const) {
      expect(fx[phase]?.anim, `모션 최소화인데 ${phase} 구간에서 카드가 애니메이션한다`).toBe("none");
      expect(
        fx[phase]?.signals,
        `모션 최소화 ${phase} 구간에 등급색 신호가 0개다 — 연출이 사라지면 등급 정보도 사라진다`,
      ).toBeGreaterThan(0);
    }

    /*
     * ⚠️ **개수만 세면 부족하다.** `.ph_surge .ring{opacity:1}` 규칙만 지워도 B 의 링이 통째로
     * 사라지는데(base 가 0 + `animation:none`), `.aura` 하나가 남아 `signals > 0` 은 계속 통과한다
     * → 그러면 **최고 등급 구간이 다이아 구간보다 어두워진다**. 그게 정확히 BL-2 의 정의였다
     * (2R 검증 m-A: 이 변이가 유일한 생존자였다). 움직임을 못 쓰는 만큼 **밝기가 유일한 격상 신호**라
     * B ≥ A 를 계약으로 건다.
     */
    expect(
      fx.surge?.peak,
      `B(${fx.surge?.peak})가 A(${fx.charge?.peak})보다 어둡다 — 모션 최소화에서 격상 신호가 사라진다`,
    ).toBeGreaterThanOrEqual(fx.charge?.peak ?? 0);
  });
});
