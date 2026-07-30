import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #322 — **경기 화면의 사이드는 매치 소유자가 아니라 픽스처가 정한다** (안 C, hero 확정 2026-07-30).
 *
 * ── 무엇이 깨졌었나 ─────────────────────────────────────────────────────────────────────
 * 리그 어웨이 라운드(픽스처 `home_team = 봇`)에서 **엔진·서버·DB 는 전부 유저를 away 로 두는데**
 * (`MatchOrchestrator.userIsHome()`, 2026-07-19 #94), web 만 `homeName = ownerName` 으로
 * "홈 = 매치 소유자 = 나"를 못 박고 있었다. 그래서 한 화면에서 세 가지가 동시에 뒤집혔다:
 *   ① 스코어  ② 로그·타임라인의 팀 라벨  ③ 좌우(뷰어는 엔진 home 을 **항상 왼쪽**에 그린다)
 * 결과 카드는 `승리` 뱃지 옆에 `축구왕여르 1 : 5 Thunder Bay United` 라고 자기모순을 냈다.
 * 라이브 영향 = 리그 20경기 중 유저 어웨이 7건 · 유저 3/3.
 *
 * ── 이 파일이 지키는 것 ──────────────────────────────────────────────────────────────────
 *  a. 헤더 이름·스코어가 **픽스처 사이드**를 따른다(홈 먼저 — 축구 중계 관례).
 *  b. 로그 팀 라벨이 사이드를 따른다(득점자가 자기 팀 이름으로 불린다).
 *  c. 결과 카드가 자기모순이 아니다 — `승리` ⟺ 내 팀 득점 > 상대 득점.
 *  d. **내 팀 표식**(안 C) — 어웨이 라운드라 내가 오른쪽에 서도 어느 쪽이 나인지 화면이 말한다.
 *  e. 연습·유저홈 리그는 **무회귀**(유저가 계속 왼쪽).
 *  f. **구 서버 폴백** — `homeName`/`awayName` 이 없는 응답이면 예전 동작(홈 = ownerName)으로 떨어진다.
 *
 * ── 표본이 계약의 절반이다 ───────────────────────────────────────────────────────────────
 * ⚠️ 기존 web 계약·목은 **전부 유저=홈**이라 이 버그를 **구조적으로 못 잡았다**(그래서 3개월 살았다).
 * 그래서 여기 목은 라이브 실경기 그대로다 — `01KYS2QM76YBKANGNZ6QTX8WBZ`
 * (축구왕여르 리그 R4 vs Thunder Bay United, 픽스처 home=봇 · `matches 1:5` · `result=WIN`).
 * 로그도 그 경기의 진짜 `match_log_json` 을 잘라 쓴다(전반 첫 골 tick 384 = P034 = **away = 축구왕여르**).
 */

/**
 * 픽스처 = 그 경기의 **진짜 `match_log_json`** 을 성기게 추린 것(스냅샷 20틱 간격, 이벤트 전량).
 * 전반은 첫 골(tick 384) 직후까지만 — hero 제보 화면을 그대로 만든다. 라이브 원본은 수 MB 라
 * 커밋하지 않고, 팀 귀속·사이드 좌표 같은 **이 계약이 재는 성질은 손대지 않고** 줄였다.
 */
const LOG_H1 = JSON.parse(readFileSync(new URL("./fixtures/p322-half1.json", import.meta.url).pathname, "utf8"));
const LOG_H2 = JSON.parse(readFileSync(new URL("./fixtures/p322-half2.json", import.meta.url).pathname, "utf8"));

/** 캡처는 **리포 밖**으로 — e2e 가 남의 세션 트리를 더럽히지 않는다(apps/web/CLAUDE.md §규칙). */
const CAP_DIR = (process.env.HMB_CAP_DIR ?? "test-results/p322/").replace(/\/?$/, "/");

const MATCH_ID = "01KYS2QM76YBKANGNZ6QTX8WBZ";
const ME = "축구왕여르";
const BOT = "Thunder Bay United";
const PHONE = { width: 390, height: 844 };

type Shape = "away-fixture" | "home-fixture" | "legacy-server";

/**
 * 라이브 실값 그대로. `shape` 는 **서버가 무엇을 주느냐**만 바꾼다:
 *  · away-fixture   = 어웨이 라운드(홈 = 봇)  — 이 이슈의 표본
 *  · home-fixture   = 홈 라운드(홈 = 유저)    — 무회귀 대조군
 *  · legacy-server  = homeName/awayName 미제공 — 구 서버 폴백
 */
async function mockApi(page: Page, state: string, shape: Shape) {
  const userAway = shape === "away-fixture";
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: { id: "u-yeoreu", nickname: ME, points: 0, wins: 4, draws: 0, losses: 0, isAdmin: false },
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      const live = state === "FIRST_HALF";
      const sides =
        shape === "legacy-server"
          ? {}
          : { homeName: userAway ? BOT : ME, awayName: userAway ? ME : BOT };
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          // 엔진(=픽스처) 관점 그대로 — 라이브 DB 실값. 어웨이 라운드면 home=봇 득점이다.
          // ⚠️ 전반 픽스처 로그는 첫 골까지만 잘랐으므로 이 확정값(1:3)과 로그 델타는 다르다.
          //    그래도 맞다 — 끝난 하프는 **서버 확정값이 이긴다**(`headerScore`, #233). 재생 델타를
          //    쓰는 건 진행 중 하프뿐이고, 그 경로는 b 가 FIRST_HALF 로 따로 잰다.
          scoreH1Home: live ? null : 1,
          scoreH1Away: live ? null : 3,
          scoreHome: state === "FINISHED" ? 1 : null,
          scoreAway: state === "FINISHED" ? 5 : null,
          // result 는 이미 **유저 관점**이다(server `finishMatch` 가 뒤집어 저장) — 어웨이여도 WIN.
          result: state === "FINISHED" ? (userAway ? "WIN" : "LOSS") : null,
          createdAt: "2026-07-30T08:37:23Z",
          finishedAt: state === "FINISHED" ? "2026-07-30T08:55:31Z" : null,
          mode: "league",
          leagueFixtureId: "01KYQZ9CRG7E6HD547F6RR7213",
          ownerName: ME,
          opponent: { name: BOT, deck: [] },
          ...sides,
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/1\/log$/.test(url.pathname)) return route.fulfill({ json: LOG_H1 });
    if (/\/api\/matches\/.+\/halves\/2\/log$/.test(url.pathname)) return route.fulfill({ json: LOG_H2 });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: { result: userAway ? "WIN" : "LOSS", scoreHome: 1, scoreAway: 5, pointsAwarded: 0 },
      });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: [] });
    if (url.pathname === "/api/deck") return route.fulfill({ json: { formation: "4-3-3", slots: [] } });
    return route.fulfill({ json: {} });
  });
}

async function open(page: Page, state: string, shape: Shape = "away-fixture") {
  await mockApi(page, state, shape);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
}

/**
 * 헤더를 `"홈이름 | H : A | 어웨이이름"` 으로 납작하게 — **표식(내 팀 칩)은 뺀다**.
 *
 * ⚠️ `innerText` 를 그대로 쓰면 안 된다. 칩이 이름 슬롯 **안**에 있어서 `축구왕여르내 팀` 이 되고,
 * 그렇다고 "내 팀"을 문자열로 지우면 폴백 팀명(`"내 팀"`)까지 같이 지워져 계약이 자기 발을 문다.
 * 그래서 **구조로** 읽는다 — 이름 슬롯에서 칩 노드만 떼고 남은 텍스트.
 */
async function header(page: Page): Promise<string> {
  return page.getByTestId("stage-score").evaluate((root) => {
    const nameOf = (side: string) => {
      const slot = root.querySelector(`[data-team-side="${side}"]`)?.cloneNode(true) as HTMLElement | undefined;
      slot?.querySelector('[data-testid="scorebar-my-team"]')?.remove();
      return (slot?.textContent ?? "").trim();
    };
    const score = Array.from(root.children).find(
      (el) => !(el as HTMLElement).dataset.teamSide,
    );
    return `${nameOf("home")} | ${(score?.textContent ?? "").trim()} | ${nameOf("away")}`;
  });
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));
test.use({ viewport: PHONE });

test.describe("어웨이 라운드 — 사이드는 픽스처가 정한다", () => {
  test("a. 헤더가 픽스처 사이드를 따른다 (홈=봇이 먼저, 스코어도 그 축)", async ({ page }) => {
    await open(page, "FINISHED");
    // 뒤집혀 있을 때의 실측값 = "축구왕여르 | 1 : 5 | Thunder Bay United"
    // (유저가 1골 넣고 5골 먹은 것처럼 보인다 — 실제는 정반대)
    expect(await header(page)).toBe(`${BOT} | 1 : 5 | ${ME}`);
  });

  test("b. 전반 첫 골이 내 골로 읽힌다 (hero 제보 화면)", async ({ page }) => {
    await open(page, "FIRST_HALF");
    await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      (window as unknown as { __viewer?: { seek?: (t: number) => void } }).__viewer?.seek?.(400);
    });
    await expect
      .poll(async () => await header(page), { timeout: 15_000 })
      // 제보는 "축구왕여르 0 : 1 Thunder B" 였다 — 그 골은 축구왕여르가 넣은 것이다.
      .toBe(`${BOT} | 0 : 1 | ${ME}`);
    await page.screenshot({ path: `${CAP_DIR}after-A-first-half.png` });
  });

  /**
   * ⚠️ **선수 id 로 행을 찾지 마라**(#334). 예전엔 `GOAL #P034` / `#P116` 처럼 로그가 playerId 원문을
   * 그대로 그렸고 이 계약도 그걸로 행을 집었는데, #334 가 **등번호 표기**로 바꾸면서(`#4`) 계약이
   * 조용히 낡아 main 에서 red 가 됐다. 재는 것은 번호가 아니라 **팀 라벨이 사이드를 따르는가**다 →
   * 표기와 무관한 앵커(킥오프 · 첫 골)로 집는다.
   */
  test("c. 로그 팀 라벨이 사이드를 따른다 — 킥오프는 홈, 첫 골은 어웨이(=나)", async ({ page }) => {
    await open(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-log").click();
    const rows = page.getByTestId("stage-panel-log").locator("li");

    // ① 킥오프는 **home** 이벤트다 → 어웨이 라운드에선 봇 이름이어야 한다.
    //    뒤집혀 있을 땐 여기가 "축구왕여르" 였다.
    const kickoff = rows.filter({ hasText: "Kick-off" }).first();
    await expect(kickoff).toBeVisible({ timeout: 30_000 });
    await expect(kickoff).toContainText(BOT);
    await expect(kickoff).not.toContainText(ME);

    // ② 이 하프의 **첫 골**은 away(=축구왕여르)다(라이브 로그 tick 384, 득점자 P034).
    //    뒤집혀 있을 땐 "Thunder Bay United" 로 불렸다 — hero 제보 화면의 실체.
    const firstGoal = rows.filter({ hasText: "GOAL" }).first();
    await expect(firstGoal).toBeVisible({ timeout: 30_000 });
    await expect(firstGoal).toContainText(ME);
    await expect(firstGoal).not.toContainText(BOT);
  });

  test("d. 결과 카드가 자기모순이 아니다 — 승리 ⟺ 내 득점이 더 많다", async ({ page }) => {
    await open(page, "FINISHED");
    await expect(page.getByTestId("result-badge")).toHaveText("승리");
    // 뒤집혀 있을 땐 같은 카드에 "승리" 와 "축구왕여르 1 : 5 Thunder Bay United" 가 같이 떴다.
    await expect(page.getByTestId("final-score")).toHaveText(`${BOT} 1 : 5 ${ME}`);
    await page.screenshot({ path: `${CAP_DIR}after-B-finished.png` });
  });

  test("e. 내 팀 표식 — 오른쪽에 서도 어느 쪽이 나인지 알 수 있다 (안 C)", async ({ page }) => {
    await open(page, "FINISHED");
    const mine = page.getByTestId("scorebar-my-team");
    await expect(mine).toBeVisible();
    // 어웨이 라운드 = 내 팀이 **away 슬롯**. 표식이 이름을 따라가야 의미가 있다.
    await expect(mine).toHaveAttribute("data-side", "away");
    const teams = page.getByTestId("stage-score");
    await expect(teams.locator('[data-team-side="away"]')).toContainText(ME);
  });

  /**
   * ⚠️ **`toBeVisible()` 로는 부족하다** — 실제로 한 번 당했다. 칩을 이름 슬롯 안에 넣었더니
   * `text-overflow: ellipsis` 가 긴 팀명 뒤에서 칩을 **통째로 잘라먹었는데** DOM 에는 있으니
   * 위 e 가 그대로 통과했다. 화면엔 없었다(실화면 캡처로만 보였다 — 루트 §2-2 "보이는 것 vs 데이터").
   * 그래서 **폭과 클리핑 경계를 잰다**: 칩이 실제 크기를 갖고, 이름 슬롯 밖으로 잘리지 않는지.
   *
   * ⚠️ **상태는 `FIRST_HALF` 여야 한다.** 처음엔 `FINISHED` 로 쟀는데 **변이체가 살아남았다** —
   * 종료 화면은 헤더 우측에 상태 태그만 있어 이름 슬롯이 넓고, 짧은 닉네임은 넘치지 않는다.
   * 실제로 잘린 건 **관전 중**이다(리그 뱃지 + 시계 + 상태 태그가 폭을 먹어 슬롯이 가장 좁다).
   * 계약은 **가장 좁은 상태**에서 재야 한다 — 넉넉한 상태에서 재면 검사하는 척만 한다.
   */
  test("e2. 표식이 긴 팀명에 잘리지 않는다 — 폭·클리핑 실측(관전 중 = 슬롯 최협)", async ({ page }) => {
    await open(page, "FIRST_HALF");
    const box = await page.getByTestId("scorebar-my-team").boundingBox();
    expect(box, "표식에 실제 박스가 없다 = 화면에 없다").not.toBeNull();
    expect(box!.width, "표식 폭이 0 이면 잘린 것이다").toBeGreaterThan(8);

    // 이름 슬롯의 클리핑 사각형 안에 칩이 들어와야 한다(슬롯이 overflow:hidden 이다).
    const slot = await page.locator('[data-team-side="away"]').boundingBox();
    expect(box!.x, "표식이 이름 슬롯 오른쪽 밖으로 밀려났다").toBeLessThanOrEqual(slot!.x + slot!.width + 0.5);
    expect(box!.x + box!.width, "표식 끝이 슬롯 밖이다 = 잘려 보인다").toBeLessThanOrEqual(
      slot!.x + slot!.width + 0.5,
    );
    // 표식이 살아남느라 이름이 사라져도 안 된다 — 둘 다 읽혀야 한다.
    await expect(page.locator('[data-team-side="away"]')).toContainText(ME.slice(0, 3));

    /*
     * ⚠️ **줄임표를 지는 쪽도 재야 한다**(독립검증 minor-1). 위 단언은 **칩의 박스**만 보므로,
     * 줄임표를 슬롯에 걸고 라벨을 자유롭게 두면 **칩은 멀쩡한데 이름 글자가 칩 밑으로 파고들어
     * 겹치는** 상태가 통과한다(변이체가 실제로 8/8 을 통과했고, 캡처에서 글자 겹침이 보였다).
     * 라벨은 **자기 박스 안에서** 줄어야 한다 = 칩 자리를 침범하지 않는다.
     *
     * ⚠️ `scrollWidth > clientWidth` 로는 재지 마라 — 여기서 이름이 줄임표로 잘리는 건 **의도된
     * 동작**이라(슬롯이 좁다) 그 단언은 정상 화면을 실패시킨다. 재야 할 것은 "잘리느냐"가 아니라
     * **"넘치는 부분이 잘려 그려지느냐"** 다.
     */
    const labelBox = await page.locator('[data-team-side="away"] > span').first().boundingBox();
    expect(labelBox!.x + labelBox!.width, "이름 박스가 표식을 밀어낸다").toBeLessThanOrEqual(box!.x + 0.5);

    /*
     * ⚠️ **박스만 재면 안 잡히는 변이가 있다**(독립검증 minor-1). 줄임표를 슬롯에 걸고 라벨을
     * 자유롭게 두면 flex 가 라벨 **박스**는 줄여 위 단언이 통과하는데, **글자는 박스 밖으로 그려져
     * 칩 밑에 깔린다**(검증자 캡처로 확인). 넘침은 레이아웃이 아니라 **페인트** 문제라
     * `boundingBox`·`getClientRects` 로는 원리적으로 구분되지 않는다.
     *
     * 픽셀로 재는 게 가장 정직하지만 이 리포엔 PNG 디코더가 없다(캔버스 픽셀 판정은
     * `getImageData` 를 쓰는데 DOM 텍스트엔 못 쓴다). 그래서 **요구를 그대로 문장으로** 건다:
     * "넘치는 라벨은 잘려야 한다". CSS 속성에 결합돼 있지만 요구 자체가 클리핑이라 그게 맞다 —
     * 픽셀 테스트인 척하지 않는다.
     */
    const clip = await page
      .locator('[data-team-side="away"] > span')
      .first()
      .evaluate((el) => ({
        overflows: el.scrollWidth - el.clientWidth > 1,
        overflowX: getComputedStyle(el).overflowX,
      }));
    if (clip.overflows) {
      expect(clip.overflowX, "이름이 넘치는데 잘리지 않는다 = 글자가 칩 위로 흘러 겹친다").not.toBe(
        "visible",
      );
    }
  });
});

test.describe("무회귀 — 유저가 홈인 경기는 그대로", () => {
  test("f. 홈 라운드: 유저가 왼쪽, 표식은 home", async ({ page }) => {
    await open(page, "FINISHED", "home-fixture");
    expect(await header(page)).toBe(`${ME} | 1 : 5 | ${BOT}`);
    await expect(page.getByTestId("scorebar-my-team")).toHaveAttribute("data-side", "home");
  });

  test("g. 구 서버(homeName/awayName 미제공)면 예전 동작으로 떨어진다", async ({ page }) => {
    await open(page, "FINISHED", "legacy-server");
    // 폴백 = ownerName / opponent.name. 연습·유저홈에서는 이게 정답이라 무회귀다.
    expect(await header(page)).toBe(`${ME} | 1 : 5 | ${BOT}`);
  });
});
