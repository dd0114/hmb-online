import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #406 W1b — **로그줄 = 선수 이름**(요구 5-4, hero 확정 ④ = 이름 + 등번호 · 라벨 한글화)
 * 과 **요구 6**(playerId → 카탈로그 이름 단일 창구)의 실화면 계약.
 *
 * 여기서만 잡을 수 있는 것 세 가지 — 단위 테스트로는 못 잡는다:
 *  ① **390px 에서 줄이 넘치지 않는다** — 계산이 아니라 실측(`scrollWidth` vs `clientWidth`).
 *    로그줄은 `[분][라벨][사람][스코어][팀][xG]` 6조각이 342px 를 나눠 갖고, 라벨만
 *    `text-overflow: ellipsis` 라 <b>이름을 넣은 만큼 라벨이 먹힌다</b>.
 *  ② **폴백 사다리가 화면에서 성립한다** — 카탈로그에 없는 선수 줄에 `P0xx` 가 뜨지 않는다.
 *  ③ **영어 라벨이 한 줄도 안 남는다** — 코어(viewer-core)는 계속 영어를 주므로,
 *    호스트 매핑이 빠진 타입이 있으면 그 줄만 영어로 남는다.
 *
 * ⚠️ **픽스처 id 를 실경기 id 로 바꿔서 쓴다.** 엔진 픽스처는 `H9`/`A11` 이라 카탈로그 조인이
 *    구조적으로 일어나지 않고, 그러면 이 스펙이 "이름이 안 나온다"를 통과시킨다
 *    (memory `fixture-ids-hide-live-defects` — 실경기 id `P077` 로 계약을 세울 것).
 *    같은 실엔진 로그의 **id 만** 바꾼 것이라 틱·이벤트·순서는 그대로다.
 * ⚠️ 라우트 매칭은 pathname 술어로 한다(glob 은 vite 소스까지 잡아 흰 화면).
 */

interface Snap {
  tick: number;
  minute: number;
  players?: Array<{ playerId: string; team: string }>;
}
interface Ev {
  tick: number;
  minute: number;
  type: string;
  playerId?: string;
}
type Log = { tickSnapshots: Snap[]; events: Ev[] };

const REAL: Log = JSON.parse(
  readFileSync(new URL("./fixtures/p388-half1.json", import.meta.url).pathname, "utf8"),
);

/** `H3` → `P003` · `A3` → `P103`. 실경기 카탈로그 id 모양으로 옮긴다(값만, 구조 무변경). */
function toCatalogId(engineId: string): string {
  const m = /^([HA])(\d+)$/.exec(engineId);
  if (!m) return engineId;
  const base = m[1] === "H" ? 0 : 100;
  return `P${String(base + Number(m[2])).padStart(3, "0")}`;
}

const LOG: Log = JSON.parse(
  JSON.stringify(REAL).replace(/"(H|A)(\d+)"/g, (_all, side: string, n: string) =>
    JSON.stringify(toCatalogId(`${side}${n}`)),
  ),
);

/** 로그에 실제로 등장하는 선수 id (등장 순). */
const APPEARING = [
  ...new Set(LOG.tickSnapshots.flatMap((s) => (s.players ?? []).map((p) => p.playerId))),
];

/**
 * 카탈로그 목 — **한 명은 일부러 뺀다**(폴백 사다리 표본). 이름은 발행물 모양 그대로
 * `name`(풀네임) + `shortName`(짧은 이름) 두 축을 싣는다.
 */
const ABSENT_FROM_CATALOG = APPEARING[3]!;
/**
 * **발행물의 실제 최악**(`data/players/players.v2.5.json`, 182/182 이 `shortName` 을 갖는다):
 * 짧은 축 최장은 **7자** — `알렉산더아널드`(P041) · `크바라츠헬리아`(P072) · `마마르다슈빌리`(P116).
 * ⚠️ 한때 여기 `추아메니`(**4자**)를 넣고 주석엔 "최악"이라고 적어 뒀다 — 발행물 최장의 **절반**이라
 * 폭 계약이 실제로 견뎌야 할 길이를 한 번도 재지 않았다. 표본이 계약의 절반이다.
 * 풀네임(11자)은 짧은 축을 **포함**하므로, "풀네임이 안 뜬다" 단언은 전체 문자열로 성립한다.
 */
const LONG_NAME = { full: "트렌트 알렉산더아널드", short: "알렉산더아널드" };
const CATALOG = APPEARING.filter((id) => id !== ABSENT_FROM_CATALOG).map((id, i) => ({
  id,
  // 표본의 절반은 **가장 긴 이름**으로 — 폭 계약이 최악에서 재도록.
  name: i % 2 === 0 ? LONG_NAME.full : `선수${i}`,
  shortName: i % 2 === 0 ? LONG_NAME.short : `선수${i}`,
  position: "MF",
  grade: "SILVER",
  attributes: {},
  owned: true,
  ownedCount: 1,
}));

async function openLogTab(page: Page, matchId: string, catalog: unknown[] = CATALOG) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/me") {
        return route.fulfill({
          json: { user: { id: "u1", nickname: "테스터", isAdmin: false }, wallet: { points: 0, gems: 0 } },
        });
      }
      if (p === `/api/matches/${matchId}`) {
        return route.fulfill({
          json: {
            id: matchId,
            state: "FIRST_HALF",
            createdAt: "2026-08-02T09:00:00Z",
            opponent: { name: "천둥만" },
            homeName: "별희 FC",
            awayName: "천둥만",
          },
        });
      }
      if (p === `/api/matches/${matchId}/halves/1/log`) return route.fulfill({ json: LOG });
      if (p === "/api/players") return route.fulfill({ json: catalog });
      if (p === "/api/deck") return route.fulfill({ json: { formation: "4-4-2", slots: [] } });
      return route.fulfill({ json: {} });
    },
  );
  await page.goto(`/match/${matchId}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 20_000 },
  );
  // 하프 끝까지 감아 **모든 종류의 줄**을 띄운다(휘슬·파울·프리킥·카드까지).
  await page.evaluate(() => {
    const v = (window as never as { __viewer: { pause?: () => void; seek(t: number): void } }).__viewer;
    v.pause?.();
    v.seek(99_999);
  });
  await page.getByTestId("stage-tab-log").click();
  const rows = page.getByTestId("stage-panel-log").locator("li");
  await expect(rows.first()).toBeVisible();
  return rows;
}

test.describe("#406 W1b 로그줄 — 선수 이름 + 한글 라벨", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("사람 조각이 `짧은이름(등번호)` 이고, 라벨이 한글이다", async ({ page }) => {
    const rows = await openLogTab(page, "m-p406-names");
    const texts = await rows.allTextContents();
    expect(texts.length, "로그줄 표본").toBeGreaterThan(10);

    // 신선도 가드 — 이 로그에 카탈로그가 아는 선수가 실제로 등장한다(안 그러면 아래가 공허).
    expect(CATALOG.length).toBeGreaterThan(15);

    const withPerson = texts.filter((t) => /\(\d+\)/.test(t));
    expect(withPerson.length, "이름(번호) 형태의 줄").toBeGreaterThan(5);
    expect(withPerson.some((t) => t.includes(`${LONG_NAME.short}(`)), texts.join(" | ")).toBe(true);

    // 짧은 축을 쓴다 — 풀네임이 들어가면 이 단언이 죽는다.
    expect(texts.join(" ")).not.toContain(LONG_NAME.full);

    // 구 표기(`#7`)가 **카탈로그를 아는 선수 줄에는** 남아 있지 않다.
    const goalOrShot = texts.filter((t) => /슛|골|가로챔|태클|선방/.test(t));
    expect(goalOrShot.length).toBeGreaterThan(3);
  });

  test("★ 라벨에 영어가 한 줄도 남지 않는다 (코어는 영어를 준다)", async ({ page }) => {
    const rows = await openLogTab(page, "m-p406-ko");
    const labels = await rows.locator("span:nth-child(2)").allTextContents();
    expect(labels.length).toBeGreaterThan(10);
    const english = labels.filter((t) => /[A-Za-z]/.test(t));
    expect(english, "한글화 누락 줄").toEqual([]);
    // 신선도 — 실제로 한글 라벨이 떠 있다(빈 줄을 초록으로 읽지 않게).
    expect(labels.some((t) => /[가-힣]/.test(t))).toBe(true);
  });

  test("★ 카탈로그에 없는 선수 줄에도 `P0xx` 가 뜨지 않는다 (폴백 사다리)", async ({ page }) => {
    const rows = await openLogTab(page, "m-p406-fallback");
    const all = (await rows.allTextContents()).join(" | ");

    // 표본 신선도 — 그 선수가 이 로그에 실제로 이벤트를 남긴다.
    expect(
      LOG.events.some((e) => e.playerId === ABSENT_FROM_CATALOG),
      `${ABSENT_FROM_CATALOG} 가 이벤트를 남기지 않으면 이 계약은 공허하다`,
    ).toBe(true);

    expect(all).not.toContain(ABSENT_FROM_CATALOG);
    expect(all, "카탈로그 id 가 이름 자리에 새면 안 된다").not.toMatch(/\bP\d{3}\b/);
  });

  /**
   * ★ **폭 실측** — 390px 에서 라벨이 잘리지 않는다. 목업이 잘리는 줄에 주황 점선을 붙여
   * 보여줬던 그 판정(`scrollWidth > clientWidth`)을 실화면에서 그대로 잰다.
   *
   * ⚠️ **양성 대조를 먼저 세운다.** "잘린 줄 0개"는 <b>측정이 죽어 있어도</b> 통과한다
   * (`apps/web/CLAUDE.md` 거짓말 #6 — 앵커 없는 `toEqual([])`). 그래서 같은 스펙 안에서
   * 일부러 넘치는 이름을 한 번 띄워 <b>검출기가 실제로 반응하는지</b> 확인한 뒤 본 계약을 잰다.
   *
   * ⚠️ **여유(headroom)는 라벨 박스로 못 잰다.** `.label` 은 `flex-shrink:1` + `overflow:hidden`
   * 이라 <b>안 잘리는 동안엔 내용 크기 그대로</b>다 — 즉 `scrollWidth/clientWidth` 는 항상
   * 정확히 100% 로 나오고, "몇 px 남았나"를 영영 말해 주지 못한다(한때 그 비율을 로그로 찍어
   * 두고 근거로 삼을 뻔했다). 남은 여유는 <b>줄(`li`) 수준</b>에서만 보인다:
   * `여유 = 줄 콘텐츠폭 − (조각들의 자연폭 합 + gap)`. 아래는 그 값을 재고,
   * <b>양성 대조에서 그 값이 실제로 음수가 되는지</b>까지 확인한다(측정이 죽어 있으면 안 죽는다).
   */
  test("390px 에서 로그 라벨이 잘리지 않는다 (실측 + 양성 대조)", async ({ page }) => {
    const measure = (rows: ReturnType<Page["locator"]>) =>
      rows.locator("span:nth-child(2)").evaluateAll((els) =>
        els.map((el) => ({
          text: el.textContent ?? "",
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        })),
      );

    /**
     * 줄 수준 여유 — `줄 콘텐츠폭 − (조각 자연폭 합 + gap)`. 라벨이 안 잘리는 동안 라벨 박스는
     * 내용 크기라 여유가 0 으로만 보이므로, **줄에서** 재야 "몇 px 남았나"가 나온다.
     */
    const slack = (rows: ReturnType<Page["locator"]>) =>
      rows.evaluateAll((els) =>
        els.map((el) => {
          const cs = getComputedStyle(el);
          const gap = Number.parseFloat(cs.columnGap) || 0;
          const pad = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
          const kids = [...el.children] as HTMLElement[];
          const natural =
            kids.reduce((sum, k) => sum + k.scrollWidth, 0) + gap * Math.max(0, kids.length - 1);
          return {
            text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
            avail: Math.round(el.clientWidth - pad),
            natural: Math.round(natural),
            slack: Math.round(el.clientWidth - pad - natural),
          };
        }),
      );

    // ── 양성 대조: 넘치는 이름을 넣으면 **두 측정기 모두** 반응해야 한다 ────────────
    const OVERLONG = "가".repeat(24);
    const controlRows = await openLogTab(
      page,
      "m-p406-width-control",
      CATALOG.map((p) => ({ ...p, name: OVERLONG, shortName: OVERLONG })),
    );
    const control = await measure(controlRows);
    const controlClipped = control.filter((m) => m.scrollWidth > m.clientWidth + 1);
    expect(controlClipped.length, "검출기가 죽어 있으면 여기서 0 이 나온다").toBeGreaterThan(3);
    const controlSlack = await slack(controlRows);
    const controlTightest = controlSlack.reduce((a, b) => (b.slack < a.slack ? b : a));
    expect(controlTightest.slack, "여유 측정이 죽어 있으면 음수가 안 나온다").toBeLessThan(0);

    // ── 본 계약: 발행물의 짧은 이름으로는 한 줄도 안 잘린다 ──────────────────────
    const rows = await openLogTab(page, "m-p406-width");
    const measured = await measure(rows);
    expect(measured.length).toBeGreaterThan(10);
    expect(
      measured.some((m) => m.text.includes(LONG_NAME.short)),
      "가장 긴 이름 표본이 실제로 재졌다",
    ).toBe(true);

    const clipped = measured.filter((m) => m.scrollWidth > m.clientWidth + 1);
    expect(
      clipped.map((c) => `${c.text} (${c.scrollWidth}>${c.clientWidth})`),
      "390px 에서 잘리는 로그줄",
    ).toEqual([]);

    // 실측 기록 — **가장 빡빡한 줄에 몇 px 남았나**(다음 사람이 여유를 판단할 근거).
    // 여기가 0 에 가까워지면 이름 한 글자가 곧 잘림이다.
    const measuredSlack = await slack(rows);
    const tightest = measuredSlack.reduce((a, b) => (b.slack < a.slack ? b : a));
    expect(tightest.slack, `가장 빡빡한 줄: ${tightest.text}`).toBeGreaterThanOrEqual(0);
    console.log(
      `[p406 폭 실측] 최장 짧은이름 ${LONG_NAME.short.length}자 · 가장 빡빡한 줄 여유 ` +
        `${tightest.slack}px (콘텐츠폭 ${tightest.avail} − 자연폭 ${tightest.natural}) — "${tightest.text}"`,
    );

    // 문서 자체가 가로로 넘치지 않는다(#276 3영역 셸 규율).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/p406-log-names-390.png" });
  });
});
