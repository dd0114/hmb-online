import { expect, test } from "@playwright/test";
import {
  BOT,
  H1_SCORER,
  ME,
  PHONE,
  box,
  goalSum,
  mockApi,
  open,
  openPlayers,
  pageScroll,
  seek,
  viewerReady,
  MATCH_ID,
} from "./p403-mocks";

/**
 * #403 W2 **(A) 선수 기록 탭** 계약 (목업 화면 ①).
 *
 * ⚠️ **(B) 피치 터치는 `p403-pitch-tap.spec.ts` 에 있다.** #421(경기 스킵 모드)이 매치 화면을
 * 크게 만지므로 (B) 통합은 그 뒤로 미뤄졌고(소유는 계속 #403), 두 덩어리가 **따로 나갈 수 있어야**
 * 해서 계약 파일도 갈랐다 — 이 파일에 피치 단언이 섞이면 분리가 성립하지 않는다.
 * 목·헬퍼·픽스처 주석(표본의 한계 포함)은 `p403-mocks.ts` 한 곳.
 *
 * ── 무엇을 잰다 ─────────────────────────────────────────────────────────────────────────
 *  ① 탭이 상태별로 뜨고 배타로 열린다(기존 기본 탭 무회귀)
 *  ② 팀 세그먼트 — 홈 먼저 · 표식·기본 선택은 내 팀 · **상대도 완전히 동일**(결정 ②) · 지시 비공개 안내
 *  ③ 상한 — **확정된 하프는 전량, 진행 중 하프만 재생 위치까지**(#233/#238 + BL-1)
 *  ④ 폰 지오메트리 — 시트를 밀지 않는다(#284 `min-width:0` 부류)
 *  ⑤ 데스크탑 비율대 — 시트 등급 `list` 가 목록을 목록으로 보이게 하나(#348/#355 축)
 *
 * ⚠️ `toBeVisible()` 로 위치를 재지 마라 — 뷰포트 밖도 통과한다(CLAUDE.md 함정 3).
 */

test.use({ viewport: PHONE, hasTouch: true });

// ══════════════════════════════════════════════════════════════════════════════════════
test.describe("① 탭 — 상태별로 뜨고 배타로 열린다", () => {
  for (const state of ["FIRST_HALF", "HALFTIME", "SECOND_HALF", "FINISHED"]) {
    test(`${state} 에 선수 탭이 있다`, async ({ page }) => {
      await open(page, state);
      await expect(page.getByTestId("stage-tab-players")).toHaveCount(1);
    });
  }

  /**
   * ── BL-1 — **감독시간에 전반 기록이 실제로 잡힌다** ─────────────────────────────────────
   *
   * 이 자리가 blocker 였다. 감독시간엔 무대가 `경기장면` 탭으로 내려가(#244) `MatchViewer` 가
   * 마운트되지 않아 `tick === null` → 상한이 `0` 으로 폴백 → **11행 전부 평점 6.0 · 골 0**.
   * 그런데 캡션은 하프 끝 분을 받아 **"7분까지의 기록"** 이라고 말했고, 헤더는 `0 : 1` 이었다.
   * 요구 A 와 결정 ②("기록을 근거로 하프타임 지시를 바꾸는 것이 이 게임의 깊이")가 **가장 필요로
   * 하는 상태**에서 표가 통째로 비어 있었다.
   *
   * ⚠️ 위 `toHaveCount(1)` 만으로는 이걸 못 잡는다 — 탭은 **있었다**. 그래서 **골 넣은 선수의
   * 행 값**을 직접 본다. `H1_BREAK`(레거시 상태명)도 같이 — 배포본에 그 상태의 매치가 있다.
   */
  for (const state of ["HALFTIME", "H1_BREAK"]) {
    test(`${state} — 전반 골이 표에 잡힌다(전 선수 0 이 아니다)`, async ({ page }) => {
      await openPlayers(page, state);

      // 전반 유일 득점자(away P034)의 골이 1 이어야 한다. 상한이 0 이면 여기가 0 이다.
      await expect(page.getByTestId(`players-goals-away-${H1_SCORER}`)).toHaveText("1");
      await expect.poll(() => goalSum(page, "away")).toBe(1);
      // 헤더가 말하는 확정 스코어(0 : 1)와 표가 같은 사실을 말한다.
      await expect(page.getByTestId("stage-score")).toContainText("0 : 1");

      // 표가 실제로 채워졌나 — 전원 6.0(기본값)이면 그건 "아무 일도 없었다"는 거짓이다.
      const ratings = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-testid^='players-rating-away-']")).map(
          (el) => el.textContent ?? "",
        ),
      );
      expect(ratings.length, "표본에 선수가 있어야 이 계약이 공허하지 않다").toBeGreaterThanOrEqual(11);
      expect(new Set(ratings).size, `평점이 전부 같다(${ratings[0]}) = 집계가 0 에서 잘렸다`).toBeGreaterThan(1);

      /*
       * ⚠️ **상한이 없으면 분을 말하지 않는다.** 이 창은 확정된 전반이라 "N분까지"는 거짓이다 —
       * 캡션과 상한이 따로 놀던 것이 이 blocker 의 절반이었다(단일 출처 = `statsWindow`).
       */
      await expect(page.getByTestId("players-live-caption")).toHaveCount(0);
    });
  }

  /** 무회귀 — 기본으로 열리는 탭은 여전히 **로그**다(#284 hero 확정). 탭 추가가 그걸 바꾸면 안 된다. */
  test("기본 탭은 여전히 로그다 — 새 탭이 기본을 뺏지 않는다", async ({ page }) => {
    await open(page, "FIRST_HALF");
    await expect(page.getByTestId("stage-tab-log")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("stage-panel-players")).toHaveCount(0);
  });

  test("탭은 배타 — 선수를 고르면 통계·로그 패널은 사라진다", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");
    await expect(page.getByTestId("stage-panel-log")).toHaveCount(0);
    await expect(page.getByTestId("stage-panel-stats")).toHaveCount(0);
    // 무대는 어떤 탭에서도 남는다(#169 AC-W1-1).
    await expect(page.getByTestId("stage-canvas")).toBeVisible();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
test.describe("② 팀 세그먼트 — 홈은 내가 아니다(#322) · 상대도 완전히 동일(결정 ②)", () => {
  test("어웨이 라운드: 순서는 홈 먼저, 표식·기본 선택은 **내 팀(어웨이)**", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");

    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid^='players-team-']")).map((el) =>
        el.getAttribute("data-side"),
      ),
    );
    expect(order, "표시 순서는 사이드 축(홈 먼저) — 유저 시점으로 뒤집지 않는다").toEqual(["home", "away"]);

    await expect(page.getByTestId("players-team-home")).toContainText(BOT);
    await expect(page.getByTestId("players-team-away")).toContainText(ME);
    // 표식은 **내 이름 바로 뒤** — 어웨이 쪽에만.
    await expect(page.getByTestId("players-my-team-away")).toHaveCount(1);
    await expect(page.getByTestId("players-my-team-home")).toHaveCount(0);
    await expect(page.getByTestId("players-team-away")).toHaveAttribute("data-selected", "true");
  });

  test("홈 라운드(무회귀 대조군): 표식·기본 선택이 홈으로 간다", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF", "home-fixture");
    await expect(page.getByTestId("players-my-team-home")).toHaveCount(1);
    await expect(page.getByTestId("players-my-team-away")).toHaveCount(0);
    await expect(page.getByTestId("players-team-home")).toHaveAttribute("data-selected", "true");
  });

  /**
   * 결정 ② = 상대도 **우리와 완전히 동일**하게 보여주고 지시문만 가린다. 그래서 "상대 표에 열이
   * 줄지 않았나"를 직접 잰다 — 요약만 남기는 회귀는 열 개수로만 죽는다.
   */
  test("상대 세그먼트도 **같은 6열**이 그대로 나온다", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");
    await page.getByTestId("players-team-home").click();

    const rows = page.locator("[data-testid^='players-row-home-']");
    await expect(rows).not.toHaveCount(0);
    const headers = await page.getByTestId("players-table").locator("thead th").allTextContents();
    expect(headers.map((t) => t.replace("기록 불완전", "").trim())).toEqual([
      "선수",
      "평점",
      "골",
      "슛",
      "패스%",
      "수비",
    ]);
    // 상대 쪽에도 값 셀이 실제로 있다(빈 표를 "동일"이라 부르지 않게).
    const first = (await rows.first().getAttribute("data-testid"))!.replace("players-row-", "");
    await expect(page.getByTestId(`players-passpct-${first}`)).toHaveCount(1);
    await expect(page.getByTestId(`players-rating-${first}`)).toHaveCount(1);
  });

  /**
   * ⚠️ **탭을 열면 맨 위에서 시작해야 한다** — 실화면 캡처로만 보였던 결함(#403 W2).
   *
   * 시트의 스크롤러는 탭들이 **공유하는 같은 DOM 노드**라 앞 탭의 `scrollTop` 을 물고 간다.
   * 로그 패널은 마운트마다 마지막 줄로 `scrollIntoView` 하므로, 로그를 보다 선수 탭으로 오면
   * 실측 **86px(폰) / 235px(1280×800)** 내려간 자리에서 열려 **팀 세그먼트와 라이브 캡션이
   * 통째로 화면 밖**이었다 = 상대 기록으로 넘어갈 손잡이가 없는 화면.
   * 문서 스크롤은 0 이라 ④ 계약이 전부 green 이었다 — 그래서 이 축을 따로 건다.
   */
  test("로그를 보다 넘어와도 맨 위에서 열린다 — 세그먼트·캡션이 안 잘린다", async ({ page }) => {
    for (const vp of [PHONE, { width: 1280, height: 800 }]) {
      await page.setViewportSize(vp);
      await open(page, "SECOND_HALF");
      // 기본 탭(로그)이 자기 마지막 줄로 스크롤할 시간을 준다 — 그 상태가 이 결함의 전제다.
      await expect(page.getByTestId("stage-panel-log")).toHaveCount(1);
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              (document.querySelector('[data-testid="stage-panel-log"]')!.parentElement as HTMLElement).scrollTop,
          ),
        )
        .toBeGreaterThan(0);

      await page.getByTestId("stage-tab-players").click();
      await expect(page.getByTestId("stage-panel-players")).toHaveCount(1);
      const top = await page.evaluate(
        () =>
          (document.querySelector('[data-testid="stage-panel-players"]')!.parentElement as HTMLElement).scrollTop,
      );
      expect(top, `${vp.width}×${vp.height}: 선수 탭이 ${top}px 내려간 채로 열렸다`).toBe(0);

      const seg = await box(page, "players-teams");
      expect(seg.inViewport, `${vp.width}×${vp.height}: 팀 세그먼트가 화면 밖`).toBe(true);
      expect(seg.hitSelf, `${vp.width}×${vp.height}: 팀 세그먼트를 다른 것이 덮었다`).toBe(true);
      const cap = await box(page, "players-live-caption");
      expect(cap.inViewport, `${vp.width}×${vp.height}: 라이브 캡션이 화면 밖`).toBe(true);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  /**
   * m2 — **기본 정렬은 평점**(목업 ① 에 평점 칩이 눌린 채로 그려져 있다). 독립검증에서
   * `DEFAULT_SORT` 를 `"goals"` 로 바꾸는 변이가 유닛 91 + e2e 14 를 전부 통과했다 = 어디에도
   * 박혀 있지 않았다. **칩 선택과 실제 정렬 결과를 같이** 본다 — 칩만 보면 정렬 로직이 딴 축을
   * 써도 통과한다.
   */
  test("처음 열면 **평점** 순이다 — 칩도, 실제 순서도", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");
    await expect(page.getByTestId("players-sort-rating")).toHaveAttribute("data-selected", "true");
    for (const k of ["goals", "shots", "passPct", "defence", "num"]) {
      await expect(page.getByTestId(`players-sort-${k}`)).toHaveAttribute("data-selected", "false");
    }
    const ratings = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid^='players-rating-away-']")).map((el) =>
        Number(el.textContent),
      ),
    );
    expect(ratings.length).toBeGreaterThan(2);
    expect(new Set(ratings).size, "전부 같은 값이면 정렬 축을 검사할 수 없다").toBeGreaterThan(1);
    expect(ratings, `평점 내림차순이 아니다: ${ratings.join(",")}`).toEqual(
      [...ratings].sort((a, b) => b - a),
    );
  });

  /**
   * m5 — 결정 ②("상대도 완전히 동일, **지시문만 비공개**")를 **화면이 말한다**. 목업 ① 상대 탭에
   * 그려져 있던 안내가 구현에 없었다 — 기능상 새는 건 없지만 유저는 "왜 상대는 지시가 안 보이지"를
   * 결함으로 읽는다. 양방향으로 건다(우리 탭에 뜨면 그것도 거짓말이다).
   */
  test("상대 탭에만 '지시는 비공개' 안내가 뜬다", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");
    await expect(page.getByTestId("players-opponent-privacy"), "내 팀 탭엔 없다").toHaveCount(0);
    await page.getByTestId("players-team-home").click();
    const note = page.getByTestId("players-opponent-privacy");
    await expect(note).toHaveCount(1);
    await expect(note).toContainText("지시");
    const b = await box(page, "players-opponent-privacy");
    expect(b.w, "안내가 폭 0 이면 화면엔 없는 것이다").toBeGreaterThan(0);
  });

  test("정렬 칩을 누르면 실제로 순서가 바뀐다", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");
    const order = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-testid^='players-row-away-']")).map((el) =>
          el.getAttribute("data-testid"),
        ),
      );
    const byRating = await order();
    await page.getByTestId("players-sort-num").click();
    const byNum = await order();
    expect(byNum, "정렬 칩이 배선되지 않으면 두 목록이 같다").not.toEqual(byRating);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ③ **스포일러 — 재생 위치를 넘는 기록은 없다**(#233/#238 축).
 *
 * 픽스처는 라이브 실경기다: 전반 골 1(tick 384, away P034) · 후반 골 2(tick 1364·1566, away P108).
 * 후반을 재생 중이면 전반은 확정(헤더가 이미 `scoreH1*` 로 말한다)이라 전량이고, **후반만** 상한이
 * 걸린다. 그래서 기대값은 `1 + (후반 골 중 tick ≤ 플레이헤드)` 로 **픽스처에서 직접** 나온다.
 */
test.describe("③ 스포일러 — 재생 위치가 상한이다", () => {
  test("후반 진행 중: 아직 안 나온 골은 세어지지 않는다", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");
    await viewerReady(page);

    await seek(page, 1000);
    await expect.poll(() => goalSum(page, "away"), { timeout: 10_000 }).toBe(1); // 전반 1 + 후반 0

    await seek(page, 1400);
    await expect.poll(() => goalSum(page, "away")).toBe(2); // 1364 가 들어왔다

    await seek(page, 1600);
    await expect.poll(() => goalSum(page, "away")).toBe(3); // 1566 까지

    // 되감으면 다시 줄어든다 — 상한이 진짜 플레이헤드를 따라간다는 뜻.
    await seek(page, 1000);
    await expect.poll(() => goalSum(page, "away")).toBe(1);
  });

  test("라이브면 캡션이 몇 분까지인지 말한다 / 종료 경기면 캡션이 없다", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");
    await viewerReady(page);
    await seek(page, 1400);
    await expect(page.getByTestId("players-live-caption")).toContainText("분까지의 기록");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockApi(page, "FINISHED", "away-fixture");
    await page.goto(`/match/${MATCH_ID}`);
    await page.getByTestId("stage-tab-players").click();
    await expect(page.getByTestId("stage-panel-players")).toHaveCount(1);
    await expect(page.getByTestId("players-live-caption")).toHaveCount(0);
    // 종료 = 전 경기 전량(요구 C) — 전반 1 + 후반 2.
    await expect.poll(() => goalSum(page, "away")).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ④ 폰 지오메트리 — **시트를 밀지 않는다**.
 * #284 에서 대상 칩 17개가 시트를 989px 로 밀어 탭바가 화면 밖으로 나갔는데 **문서 스크롤은 0**
 * 이었다. 그래서 문서 스크롤만 재지 않고 **시트 폭·탭바 위치**를 같이 잰다.
 */
test.describe("④ 폰 390×844 — 넘치지 않는다", () => {
  test("문서 스크롤 0 · 시트 폭 ≤ 뷰포트 · 탭바가 화면 안", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");
    const s = await pageScroll(page);
    expect(s.v, "문서 세로 스크롤 0 — 스크롤은 패널 안에만").toBeLessThanOrEqual(1);
    expect(s.h, "가로 오버플로 0").toBeLessThanOrEqual(1);

    const sheet = await box(page, "stage-sheet");
    expect(sheet.w).toBeLessThanOrEqual(PHONE.width + 1);
    expect(sheet.x).toBeGreaterThanOrEqual(-1);

    const tabs = await page.getByRole("tablist", { name: "정보 패널" }).boundingBox();
    expect(tabs!.x + tabs!.width, "탭이 5개가 돼도 탭바가 화면 밖으로 나가면 안 된다").toBeLessThanOrEqual(
      PHONE.width + 1,
    );
  });

  /**
   * ⚠️ **긴 팀 이름 표본**. 세그먼트는 팀명을 그대로 싣는 자리라 이름 하나가 시트를 밀 수 있고,
   * 그 상태에서도 문서 스크롤은 0 이라 기존 계약이 전부 green 이다(#284 실적).
   */
  test("아주 긴 팀 이름도 시트를 밀지 않는다 — 이름만 줄어든다", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF", "long-name");
    const sheet = await box(page, "stage-sheet");
    expect(sheet.w, `긴 이름이 시트를 ${sheet.w}px 로 밀었다`).toBeLessThanOrEqual(PHONE.width + 1);

    const m = await page.getByTestId("players-team-home").evaluate((el) => {
      const name = el.querySelector("span")! as HTMLElement;
      return { clipped: name.scrollWidth > name.clientWidth, btn: Math.round(el.getBoundingClientRect().width) };
    });
    expect(m.clipped, "긴 이름 표본이 실제로 넘치지 않으면 이 계약은 공허하다").toBe(true);
    // 그리고 표식은 **살아남는다**(줄임표에 태우면 DOM 엔 있는데 화면엔 없다 — #322 실적).
    const chip = await box(page, "players-my-team-away");
    expect(chip.w).toBeGreaterThan(0);
    expect(chip.inViewport).toBe(true);
  });

  test("정렬 칩 줄과 표는 **자기 안에서** 처리한다(줄바꿈으로 시트를 밀지 않는다)", async ({ page }) => {
    await openPlayers(page, "SECOND_HALF");
    const m = await page.evaluate(() => {
      const sort = document.querySelector('[data-testid="players-sort"]') as HTMLElement;
      const table = document.querySelector('[data-testid="players-table"]') as HTMLElement;
      return {
        sortClient: sort.clientWidth,
        sortOverflowX: getComputedStyle(sort).overflowX,
        tableScroll: table.scrollWidth,
        tableClient: table.clientWidth,
      };
    });
    expect(m.sortClient).toBeLessThanOrEqual(PHONE.width + 1);
    expect(m.sortOverflowX, "넘치는 만큼은 자기 안에서 스크롤").toBe("auto");
    // 표는 `table-layout: fixed` 라 절대 안 넘친다 — 넘치면 긴 이름 하나가 시트를 밀어낸다.
    expect(m.tableScroll, "표가 자기 폭을 넘으면 안 된다").toBeLessThanOrEqual(m.tableClient + 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ⑤ **데스크탑 비율대** — 새 시트 등급 `list` 가 실제로 목록을 목록으로 보이게 하나.
 *
 * `info`(26svh)로 되돌리면 크롬(세그먼트+캡션+칩+표머리)만으로 패널이 차서 데이터가 한 줄도 안
 * 남는다 — "이게 전부"로 읽혀 아무도 스크롤하지 않는다(#355 가 결과 카드에서 겪은 모양).
 * **세로가 짧은 창을 빼지 마라**(브라우저 확대가 여기로 떨어진다, #348 MAJOR-1).
 */
const DESKTOP = [
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1024x640", width: 1024, height: 640 }, // 1280×800 @125%
  { name: "1280x600", width: 1280, height: 600 }, // 세로가 가장 빡빡하다
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1440x560", width: 1440, height: 560 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "3440x1440", width: 3440, height: 1440 },
];

test.describe("⑤ 데스크탑 — 목록이 목록으로 보인다", () => {
  for (const vp of DESKTOP) {
    test(`${vp.name} — 정렬 칩 + 표 머리 + 3행이 화면 안 · 나머지는 스크롤로 닿는다`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openPlayers(page, "SECOND_HALF");

      const sheet = await box(page, "stage-sheet");
      await expect(page.getByTestId("stage-sheet")).toHaveAttribute("data-sheet", "list");

      const sort = await box(page, "players-sort");
      expect(sort.inViewport, `${vp.name}: 정렬 칩 줄이 화면 밖 — bottom ${sort.bottom} > ${sort.vh}`).toBe(true);
      expect(sort.hitSelf, `${vp.name}: 정렬 칩 중심을 다른 것이 받는다`).toBe(true);

      /*
       * **행 3개가 온전히 보인다** = "이건 목록이고 더 있다"가 읽히는 최소치(실측 근거는
       * `.sheetList` 주석 — 크롬 236px + 행 34px). `info` 등급(26svh)으로 되돌리면 세로 ≤800 창
       * 전부에서 0~1행이 되어 여기서 죽는다.
       */
      const rows = page.locator("[data-testid^='players-row-away-']");
      expect(await rows.count(), "표본에 11명 이상이 있어야 이 계약이 공허하지 않다").toBeGreaterThanOrEqual(11);
      const third = (await rows.nth(2).getAttribute("data-testid"))!;
      const r3 = await box(page, third);
      expect(
        r3.inViewport,
        `${vp.name}: 3번째 행이 화면 밖(bottom ${r3.bottom} > ${r3.vh}) — 목록으로 안 읽힌다`,
      ).toBe(true);
      expect(r3.hitSelf, `${vp.name}: 3번째 행 중심을 다른 것이 받는다`).toBe(true);

      /*
       * ⚠️ "3행이 보인다"만으로는 부족하다 — 나머지에 **닿을 수 있어야** 목록이다.
       * 스크롤이 패널 안에 있고(문서는 안 움직인다) 실제로 뒤쪽 행이 올라오는지 같이 잰다.
       */
      const scrolled = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="stage-panel-players"]')!.parentElement as HTMLElement;
        const before = panel.scrollTop;
        panel.scrollTop = panel.scrollHeight;
        return { overflow: panel.scrollHeight - panel.clientHeight, before, after: panel.scrollTop };
      });
      expect(scrolled.overflow, `${vp.name}: 11명이 다 들어갈 리 없다 — 넘쳐야 정상`).toBeGreaterThan(0);
      expect(scrolled.after, `${vp.name}: 패널이 스크롤되지 않으면 뒤쪽 선수에 영영 못 닿는다`).toBeGreaterThan(
        scrolled.before,
      );
      const last = (await rows.last().getAttribute("data-testid"))!;
      const rl = await box(page, last);
      expect(rl.inViewport, `${vp.name}: 스크롤해도 마지막 행에 못 닿는다`).toBe(true);
      await page.evaluate(() => {
        (document.querySelector('[data-testid="stage-panel-players"]')!.parentElement as HTMLElement).scrollTop = 0;
      });

      // 무대는 남고(#169 AC-W1-1) 자기 행에 빈 띠를 남기지 않는다(#348 관계식 — 절대 하한 금지).
      const canvas = await box(page, "stage-canvas");
      expect(canvas.h, `${vp.name}: 무대가 실질적으로 사라지면 안 된다`).toBeGreaterThan(120);
      expect(
        sheet.y - canvas.bottom,
        `${vp.name}: 무대와 시트 사이 빈 띠 ${sheet.y - canvas.bottom}px`,
      ).toBeLessThanOrEqual(8);

      const s = await pageScroll(page);
      expect(s.v, `${vp.name}: 문서 세로 스크롤 0`).toBeLessThanOrEqual(1);
      expect(s.h, `${vp.name}: 가로 오버플로 0`).toBeLessThanOrEqual(1);
      expect(sheet.w, `${vp.name}: 시트 폭이 뷰포트를 넘으면 안 됨`).toBeLessThanOrEqual(vp.width + 1);
    });

  }

  /**
   * ⚠️ **스윕이 후반만 돌면 사각지대가 생긴다.** 스코어바가 상태마다 두께가 달라 같은 시트
   * 높이에서도 무대가 26px 차이 난다 — 실측 1440×560 에서 후반 132px / **전반 106px**.
   * 가장 빡빡한 창을 전반으로도 태워, 값을 더 키울 때 여기가 먼저 죽게 한다(근거 표 = `.sheetList` 주석).
   */
  test("1440x560 전반 — 가장 빡빡한 창에서도 3행 + 무대가 남는다", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 560 });
    await openPlayers(page, "FIRST_HALF");

    await expect(page.getByTestId("stage-sheet")).toHaveAttribute("data-sheet", "list");
    const rows = page.locator("[data-testid^='players-row-away-']");
    const third = (await rows.nth(2).getAttribute("data-testid"))!;
    const r3 = await box(page, third);
    expect(r3.inViewport, `3번째 행이 화면 밖(bottom ${r3.bottom} > ${r3.vh})`).toBe(true);

    const canvas = await box(page, "stage-canvas");
    // 후반(132)보다 낮은 하한이다 — 같은 창에서 전반 스코어바가 26px 더 두껍기 때문(조건부 임계).
    expect(canvas.h, `전반 무대가 ${canvas.h}px — 여기가 이 등급의 바닥이다`).toBeGreaterThan(100);
    const s = await pageScroll(page);
    expect(s.v).toBeLessThanOrEqual(1);
    expect(s.h).toBeLessThanOrEqual(1);
  });
});
