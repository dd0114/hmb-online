import { expect, test, type Page } from "@playwright/test";
import {
  BOT,
  MATCH_ID,
  ME,
  NO_LOG_MATCH_ID,
  PHONE,
  authInit,
  box,
  countRequests,
  mockApi,
  mockGrowthReport,
  mockHalfLogError,
  mockNoLogMatch,
  mockPastLogs,
  open,
  pageScroll,
  seek,
  viewerReady,
  type Shape,
} from "./p403-mocks";

/**
 * #403 **W4 — 종료 후 개인 성적 · 과거 경기** 계약 (목업 화면 ⑤·⑥).
 *
 * ── 이 웨이브가 만든 것은 셋뿐이다 ────────────────────────────────────────────────────────
 *  ⓐ 결과 탭에 **MOTM + 양팀 개인 성적** 섹션 (요구 C)
 *  ⓑ 표·세그먼트를 선수 탭과 **같은 컴포넌트**로 추출(`match/PlayerStatsTable`)
 *  ⓒ 과거 경기 목록 뱃지 문구(`▶ 기록`) + **과거 경기가 실제로 되는지**(요구 D)
 *
 * ⚠️ ⓒ 가 이 파일의 존재 이유 중 절반이다 — 목업 ⑥ 은 *"새 화면 없이 이미 된다"* 고 주장하는데
 * **아무도 그것을 화면에서 확인한 적이 없었다**. 여기가 그 유일한 증거다.
 *
 * ⚠️ `toBeVisible()` 로 위치를 재지 마라 — 뷰포트 밖도 통과한다(CLAUDE.md 함정 3).
 * ⚠️ `toHaveCount(0)` 은 **같은 테스트 안에 양성 앵커**를 두고 쓴다(함정 6).
 */

test.use({ viewport: PHONE, hasTouch: true });

const MY_TEAM = "away" as const; // 픽스처는 어웨이 라운드(#322) — `home = 나` 가 아니다.
const OPP_TEAM = "home" as const;

interface OpenOpts {
  /** 성장 리포트가 **실제로 렌더되는** 목을 얹는다 — 기본 목의 `{}` 는 섹션을 통째로 없앤다. */
  growth?: boolean;
  /** `GET /api/me` 지연(ms). `myTeamSide` 가 늦게 오는 실제 순서를 만든다(major-1). */
  meDelayMs?: number;
  /** 하프 로그의 팀 라벨만 뒤집는다 → MOTM 이 **home 사이드**가 된다(R2, `p403-mocks` 참조). */
  flipLogTeams?: boolean;
  /** 매치 메타의 사이드 라벨(=`myTeamSide`) 축. 기본은 어웨이 라운드(#322 표본). */
  shape?: Shape;
}

/**
 * 결과 탭을 연다(종료 상태의 기본 탭이지만 **명시적으로** 고른다 — 기본이 바뀌어도 이 계약이 산다).
 *
 * ⚠️ **여는 경로는 한 벌이다** (R2, 독립검증 minor-3). R1 은 목을 끼우려고 여기서 `open()` 의
 * 본문(`mockApi → authInit → goto → expect`)을 복제했는데, 그러면 셸 진입 절차가 두 곳이 돼
 * 한쪽만 낡는다. 지금은 `open` 의 `beforeGoto` 훅으로 목만 얹는다.
 */
async function openResult(page: Page, opts: OpenOpts = {}) {
  await open(
    page,
    "FINISHED",
    opts.shape ?? "away-fixture",
    { meDelayMs: opts.meDelayMs ?? 0, flipLogTeams: opts.flipLogTeams },
    opts.growth ? mockGrowthReport : undefined,
  );
  await page.getByTestId("stage-tab-result").click();
  await expect(page.getByTestId("result-page")).toHaveCount(1);
  await expect(page.getByTestId("result-players")).toHaveCount(1);
}

/** 지금 `내 팀` 칩이 달린 세그먼트 / 지금 선택된 세그먼트 — **화면이 말하는 값만** 읽는다. */
function segmentState(page: Page): Promise<{ mine: string | null; selected: string | null }> {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-testid="players-teams"] button')];
    const sideOf = (el: Element | undefined) => el?.getAttribute("data-side") ?? null;
    return {
      mine: sideOf(btns.find((b) => b.querySelector('[data-testid^="players-my-team-"]'))),
      selected: sideOf(btns.find((b) => b.getAttribute("data-selected") === "true")),
    };
  });
}

/** 그 팀 표의 `(playerId, 평점)` 전부 — 두 화면이 **같은 것을 말하나**를 재는 자[尺]. */
function readTable(page: Page, team: "home" | "away"): Promise<[string, string][]> {
  return page.evaluate((t) => {
    const out: [string, string][] = [];
    for (const el of document.querySelectorAll(`[data-testid^="players-rating-${t}-"]`)) {
      const id = (el.getAttribute("data-testid") ?? "").replace(`players-rating-${t}-`, "");
      out.push([id, (el.textContent ?? "").trim()]);
    }
    return out;
  }, team);
}

/** DOM 순서 — `a` 가 `b` 보다 **앞**인가(`compareDocumentPosition` 실측, 좌표 추론 아님). */
function precedes(page: Page, a: string, b: string): Promise<boolean> {
  return page.evaluate(([x, y]) => {
    const ea = document.querySelector(`[data-testid="${x}"]`);
    const eb = document.querySelector(`[data-testid="${y}"]`);
    if (!ea || !eb) return false;
    return (ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }, [a, b]);
}

// ══════════════════════════════════════════════════════════════════════════════════════
test.describe("① 결과 탭 — MOTM + 양팀 개인 성적 (목업 ⑤)", () => {
  /**
   * **자리가 계약이다.** 목업 본문이 *"그 사이(팀 스탯 뒤)에 넣는다"* 라고 못 박았다
   * (그림은 MOTM 을 스코어 밑에 그렸지만 본문이 결정이다). 그리고 이 자리는 #355 의 세로 예산
   * 계약과도 얽힌다 — `p348-desktop-viewport` ⑥ 이 *"결과 카드 아래 **팀 스탯의 시작**이 보인다"*
   * 를 재므로, 개인 성적이 팀 스탯 **앞**으로 올라가면 그 계약이 재는 대상이 조용히 바뀐다.
   */
  /**
   * ⚠️ **`if (count > 0)` 로 감싸면 안 된다** (R1 — 독립검증 minor-6a). 기본 목은
   * `/api/growth/report/*` 를 `{}` 로 흘리고 `GrowthReportSection` 은 `entries.length === 0` 이면
   * **null 을 돌려준다** → 섹션이 DOM 에 없다 → 그 `if` 블록이 **한 번도 실행되지 않는다**.
   * 실제로 이 단언을 `<GrowthReportSection>` **뒤로 옮기는 변이가 SURVIVED** 했다.
   * 이제 성장 리포트가 실제로 뜨는 목(`mockGrowthReport`)을 주고 **존재를 단언한 뒤** 순서를 잰다.
   */
  test("자리 = 팀 스탯 뒤 · 성장 리포트 앞", async ({ page }) => {
    await openResult(page, { growth: true });
    await expect(page.getByTestId("team-stats")).toHaveCount(1);
    expect(await precedes(page, "team-stats", "result-players"), "개인 성적이 팀 스탯보다 앞에 있다").toBe(true);
    // 양성 앵커 — 성장 리포트가 **실제로 그려졌다**(이게 없으면 아래 순서 단언이 공허해진다).
    await expect(page.getByTestId("growth-report"), "성장 리포트가 안 떴다 — 목이 낡았다").toHaveCount(1);
    expect(await precedes(page, "result-players", "growth-report"), "개인 성적이 성장 리포트보다 뒤에 있다").toBe(true);
    // 그리고 스크롤 밖 CTA 는 여전히 맨 마지막이다(#355 두 층).
    expect(await precedes(page, "result-players", "to-lobby")).toBe(true);
  });

  /**
   * MOTM 은 **표의 1위와 같은 사람**이어야 한다. 다른 사람을 가리키면 "누가 잘했나"를 알려주는
   * 줄이 오히려 화면을 두 목소리로 만든다(#388 부류).
   * ⚠️ 표는 기본 세그먼트(= 내 팀)만 보여주므로, MOTM 이 상대일 수도 있다 → **양 팀에서** 찾는다.
   */
  test("MOTM 줄 = 양 팀 통틀어 평점 1위 · 그 행의 평점칩이 motm 등급", async ({ page }) => {
    await openResult(page);
    const motmTeam = await page.getByTestId("result-motm").getAttribute("data-team");
    const motmId = await page.getByTestId("result-motm").getAttribute("data-player");
    const motmRating = (await page.getByTestId("result-motm-rating").textContent())?.trim();
    expect(motmTeam === "home" || motmTeam === "away", `MOTM 팀 라벨이 이상하다: ${motmTeam}`).toBe(true);

    // 양 팀 표를 다 읽어 최고 평점을 구한다(세그먼트를 바꿔 가며 = 화면이 말하는 값만 쓴다).
    const all: [string, string, string][] = [];
    for (const t of ["home", "away"] as const) {
      await page.getByTestId(`players-team-${t}`).click();
      for (const [id, r] of await readTable(page, t)) all.push([t, id, r]);
    }
    expect(all.length, "표가 비어 있으면 이 계약이 공허해진다").toBeGreaterThan(10);

    /*
     * ⚠️ **동점을 하나로 단정하지 마라.** 실측에서 이 표본은 상한 `10.0` 에 **2명이 붙는다**
     * (`home:P121` · `away:P079` — 승부는 assists 1 vs 0 에서 갈린다)
     * (평점 포화 = `docs/plan-v5/player-stats.md` §5 가 hero 게이트로 올려둔 그 축). 그래서 계약은
     * "MOTM 은 이 사람"이 아니라 **"MOTM 은 표시 최고점이고 실제로 표에 있는 행이다"** 로 건다 —
     * 집계 쪽 동점 끊기(`pickMotm`)를 화면에서 재현하면 그건 규칙의 두 번째 사본이 된다.
     */
    const top = Math.max(...all.map(([, , r]) => Number(r)));
    expect(Number(motmRating), `MOTM 평점 ${motmRating} 이 표 최고점 ${top} 보다 낮다`).toBeCloseTo(top, 5);
    expect(
      all.some(([t, id]) => t === motmTeam && id === motmId),
      `MOTM(${motmTeam}/${motmId})이 표에 없는 선수다`,
    ).toBe(true);

    // 그 행의 평점칩이 실제로 motm 등급이다(색·타이틀이 아니라 데이터 축으로 잰다).
    await page.getByTestId(`players-team-${motmTeam}`).click();
    await expect(page.getByTestId(`players-rating-${motmTeam}-${motmId}`)).toHaveAttribute("data-tier", "motm");
  });

  /**
   * ⚠️ **MOTM 이 지금 고른 팀이 아니어도 그 줄이 있다.**
   *
   * 이 계약이 없는 동안 *"MOTM 을 지금 고른 세그먼트에서만 찾는다"* 는 변이가 **살아남았다**
   * (변이 M9). 기본 픽스처는 MOTM(P079)이 하필 **내 팀**이라 기본 세그먼트와 같아서, 위 계약
   * 전부가 그 구멍을 지나갔다 — CLAUDE.md 함정 4(*"픽스처가 두 상태를 뭉갠다"*)의 정확한 모양이다.
   *
   * 그래서 **홈 픽스처**(유저=홈)로 축을 갈라 잰다: 기본 세그먼트는 `home` 인데 MOTM 은 `away` 다.
   * 그 상태에서 줄이 사라지면 화면이 "우리 중 최고"라는 **다른 뜻**을 말하게 된다.
   */
  test("MOTM 이 지금 고른 팀이 아니어도 줄이 남는다 (홈 픽스처 = 다른 세그먼트)", async ({ page }) => {
    await open(page, "FINISHED", "home-fixture");
    await page.getByTestId("stage-tab-result").click();
    await expect(page.getByTestId("result-players")).toHaveCount(1);

    // 전제 확인 — 기본 세그먼트와 MOTM 팀이 **실제로 다르다**(같으면 이 계약이 공허해진다).
    await expect(page.getByTestId("players-team-home")).toHaveAttribute("data-selected", "true");
    const motm = page.getByTestId("result-motm");
    await expect(motm).toHaveCount(1);
    await expect(motm).toHaveAttribute("data-team", "away");
    /*
     * 그리고 그 줄은 **그 선수가 선 사이드의 팀 이름**을 말한다 — 어느 쪽 사람인지 화면이
     * 답한다(#322: 사이드 라벨은 서버가 주고 web 이 추론하지 않는다).
     * ⚠️ 이 픽스처에서 홈/어웨이 **라벨만** 뒤집혔고 로그는 같다 — 그래서 같은 선수(away 사이드)가
     * 여기서는 봇 이름을 단다. 그게 정확히 "홈은 내가 아니다"가 말하는 것이다.
     */
    await expect(page.getByTestId("result-motm-team")).toHaveText(BOT);
    // 지금 표에는 그 선수가 없다(= 표에서 찾은 게 아니라는 증거).
    const motmId = await motm.getAttribute("data-player");
    await expect(page.getByTestId(`players-row-away-${motmId}`)).toHaveCount(0);
    await expect(page.getByTestId(`players-row-home-${motmId}`)).toHaveCount(0);
  });

  /**
   * ⚠️ **MOTM 이 `home` 사이드인 표본** (#403 W4 R2 — R1 서술 철회의 실물).
   *
   * 위 두 계약은 MOTM 이 **언제나 away 사이드**라 `motmRowOf` 의 **`home` 항을 떨어뜨리는 변이**를
   * 못 죽였다(두 shape 은 매치 메타의 사이드 라벨만 뒤집고 하프 로그는 같다). R1 은 그것을
   * *"평점 포화 + 키 tie-break 때문에 실로그를 어떻게 relabel 해도 home MOTM 은 못 만든다"* 고
   * 적었는데 **거짓이다** — 그 픽스처의 10.0 은 2명이고 승부는 **assists** 에서 갈려 키 비교는
   * 발화조차 하지 않는다. 하프 로그의 팀 라벨을 뒤집으면 MOTM 은 그대로 **`home:P079`** 가 된다.
   *
   * ⚠️ 그래서 이 표본이 잰다: **지금 고른 표(내 팀 = away)에 없는 사람**이 MOTM 줄에 있고
   * 그 줄이 **상대 팀 이름**을 단다. 순수 계층(`player-stats-view.test.ts`)은 탐색 규칙을 보고,
   * 여기서는 그 규칙이 **화면에 배선됐나**를 본다.
   * ⚠️ 합성 표본이라 스코어(메타 `0:3`)와는 어긋난다 — 이 축 말고 다른 것을 여기서 재지 마라.
   */
  test("MOTM 이 home 사이드여도 줄이 남는다 (라벨 뒤집은 로그 = away 항만 뒤지면 사라진다)", async ({
    page,
  }) => {
    await openResult(page, { flipLogTeams: true });

    // 전제 — 기본 선택은 내 팀(away)이고 MOTM 은 그 반대편이다(같으면 계약이 공허해진다).
    await expect(page.getByTestId(`players-team-${MY_TEAM}`)).toHaveAttribute("data-selected", "true");
    const motm = page.getByTestId("result-motm");
    await expect(motm).toHaveCount(1);
    await expect(motm).toHaveAttribute("data-team", OPP_TEAM);
    // 그 줄은 상대(홈) 팀 이름을 말한다 — 어느 쪽 사람인지 화면이 답한다(#322).
    await expect(page.getByTestId("result-motm-team")).toHaveText(BOT);

    // 지금 열려 있는 표(내 팀)에는 그 선수가 없다 = 표에서 찾은 게 아니라는 증거.
    const motmId = await motm.getAttribute("data-player");
    await expect(page.getByTestId(`players-row-${MY_TEAM}-${motmId}`)).toHaveCount(0);
    // 상대 표로 바꾸면 실제로 그 행이 있고 motm 등급이다(양성 앵커).
    await page.getByTestId(`players-team-${OPP_TEAM}`).click();
    await expect(page.getByTestId(`players-rating-${OPP_TEAM}-${motmId}`)).toHaveAttribute(
      "data-tier",
      "motm",
    );
  });

  /**
   * 결과 탭은 **요약**이다 — 정렬 컨트롤도 라이브 캡션도 없다.
   * (정렬은 `선수` 탭 소관. 캡션은 창이 `settled` 라 애초에 null 이다.)
   */
  test("정렬 칩·라이브 캡션이 없다 — 표는 있다(양성 앵커)", async ({ page }) => {
    await openResult(page);
    await expect(page.getByTestId("players-table")).toHaveCount(1); // 앵커
    await expect(page.getByTestId("players-sort")).toHaveCount(0);
    await expect(page.getByTestId("players-live-caption")).toHaveCount(0);
  });

  /**
   * 결과 탭의 행은 **버튼이 아니다** — 상세 모달은 셸이 소유하고 `선수` 탭이 그 문이다.
   * 핸들러를 억지로 넘기면 눌리는데 아무 일도 안 일어나는 죽은 손잡이가 된다.
   */
  test("결과 탭 행은 눌러도 모달이 열리지 않는다 — 죽은 손잡이 금지", async ({ page }) => {
    await openResult(page);
    const row = page.getByTestId(`players-row-${MY_TEAM}-P014`);
    await expect(row).toHaveCount(1); // 앵커
    expect(await row.getAttribute("role"), "결과 탭 행에 button role 이 붙었다").toBeNull();
    await row.click();
    await expect(page.getByTestId("player-detail")).toHaveCount(0);
  });

  /**
   * ⚠️ **손잡이처럼 보이는 것도 손잡이다** (R1 — 독립검증 minor-5).
   *
   * 위 계약이 "눌러도 아무 일 없다"를 지키는 동안 `.plistRow { cursor: pointer }` 가 무조건이라
   * 결과 탭 행에도 손가락 커서가 붙어 있었다(실측 `{"cursor":"pointer","role":null,"tabIndex":-1}`).
   * 어포던스만 남기는 건 "만져도 아무 데도 안 가는 손잡이"를 안 남긴다는 규율과 어긋난다.
   *
   * ⚠️ **선수 탭이 양성 앵커다** — 거기서는 실제로 눌린다. 한쪽만 재면 CSS 를 통째로 지워도 통과한다.
   */
  test("커서 어포던스도 갈린다 — 결과 탭은 기본, 선수 탭(진짜 눌린다)은 pointer", async ({ page }) => {
    const cursorOf = (testId: string) =>
      page.evaluate(
        (id) => getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!).cursor,
        testId,
      );

    await openResult(page);
    expect(await cursorOf(`players-row-${MY_TEAM}-P014`), "결과 탭 행이 눌리는 척한다").not.toBe("pointer");

    await page.getByTestId("stage-tab-players").click();
    await expect(page.getByTestId("stage-panel-players")).toHaveCount(1);
    expect(
      await cursorOf(`players-row-${MY_TEAM}-P014`),
      "선수 탭 행은 진짜 눌리는데 커서가 안 붙었다(= 위 단언이 공허해진다)",
    ).toBe("pointer");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ② **같은 컴포넌트라는 증거** — 두 화면을 **같은 selector 로** 재서 값이 같다.
 * (W3 `AttributeLayers` 추출이 `growth-*` testid 를 유지한 것과 같은 이유. 이름을 화면별로
 * 가르면 "두 자리가 같은 것"이라는 성질을 계약이 확인할 방법이 없어진다.)
 */
test.describe("② 결과 탭 표 == 선수 탭 표", () => {
  test("두 탭이 같은 행·같은 평점을 말한다 (양 팀 다)", async ({ page }) => {
    await openResult(page);
    const fromResult: Record<string, [string, string][]> = {};
    for (const t of ["home", "away"] as const) {
      await page.getByTestId(`players-team-${t}`).click();
      fromResult[t] = await readTable(page, t);
    }

    await page.getByTestId("stage-tab-players").click();
    await expect(page.getByTestId("stage-panel-players")).toHaveCount(1);
    for (const t of ["home", "away"] as const) {
      await page.getByTestId(`players-team-${t}`).click();
      const fromTab = await readTable(page, t);
      expect(fromTab.length, `${t}: 선수 탭 표가 비었다`).toBeGreaterThan(5);
      // 정렬 축이 둘 다 기본(평점)이라 **순서까지** 같아야 한다.
      expect(fromTab, `${t}: 두 탭의 표가 다르다`).toEqual(fromResult[t]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ③ **홈은 내가 아니다** (#322). 픽스처는 어웨이 라운드다.
 */
test.describe("③ 팀 세그먼트 — 순서는 홈 먼저, 표식·기본 선택은 내 팀", () => {
  test("결과 탭에서도 규칙이 같다", async ({ page }) => {
    await openResult(page);
    const seg = page.getByTestId("players-teams");
    // 순서 = 홈(봇) 먼저.
    expect(await seg.locator("button").nth(0).getAttribute("data-side")).toBe("home");
    expect(await seg.locator("button").nth(1).getAttribute("data-side")).toBe("away");
    await expect(page.getByTestId(`players-team-${OPP_TEAM}`)).toContainText(BOT);
    await expect(page.getByTestId(`players-team-${MY_TEAM}`)).toContainText(ME);
    // 표식은 내 팀(어웨이)에만.
    await expect(page.getByTestId(`players-my-team-${MY_TEAM}`)).toHaveCount(1);
    await expect(page.getByTestId(`players-my-team-${OPP_TEAM}`)).toHaveCount(0);
    // 기본 선택도 내 팀.
    await expect(page.getByTestId(`players-team-${MY_TEAM}`)).toHaveAttribute("data-selected", "true");
  });

  /**
   * ⚠️ **`/api/me` 가 늦으면 화면이 자기 칩과 다른 표를 열었다** (R1 — 독립검증 major-1).
   *
   * `myTeamSide` 는 `useMe()` 산출인데 `App.tsx RequireAuth` 는 **토큰만** 보므로 그 응답을
   * 기다리지 않는다 → `/api/matches/:id` 가 먼저 오면 패널이 `null` 로 마운트되고,
   * `useState(() => defaultSegment(...))` 는 **마운트 때 한 번만** 돌아 `"home"` 에 굳었다.
   * 어웨이 라운드에서는 `축구왕여르 [내 팀]` 칩을 달아 놓고 **Thunder Bay United 표**를 여는 상태다.
   * 직접 잰 스윕(수정 전 코드): `0ms` 만 일치, **`20ms` 부터 300ms 까지 전부 불일치** —
   * 그래서 지연을 넉넉히 준다(하한에 붙여 재면 머신 부하에 따라 플래키해진다).
   *
   * 계약은 **값이 아니라 관계**다: *"선택된 세그먼트 == `내 팀` 칩이 달린 세그먼트"*.
   * 픽스처를 홈 라운드로 바꿔도, 기본값 규칙을 바꿔도 이 성질은 그대로여야 한다.
   */
  test("`/api/me` 가 늦게 와도 선택 = `내 팀` 칩이 달린 세그먼트 (지연 300ms)", async ({ page }) => {
    await openResult(page, { meDelayMs: 300 });
    // 칩이 도착할 때까지 기다린다 — 도착 전 상태를 재면 이 계약이 다른 것을 잰다.
    await expect(page.getByTestId(`players-my-team-${MY_TEAM}`)).toHaveCount(1);
    await expect
      .poll(async () => JSON.stringify(await segmentState(page)), {
        message: "늦게 온 myTeamSide 를 세그먼트가 안 따라갔다",
      })
      .toBe(JSON.stringify({ mine: MY_TEAM, selected: MY_TEAM }));
    // 표까지 따라왔나 — 선택 표시만 옮기고 행은 상대 것인 구현을 통과시키지 않는다.
    await expect(page.getByTestId(`players-row-${MY_TEAM}-P014`)).toHaveCount(1);
    await expect(page.getByTestId(`players-row-${OPP_TEAM}-P116`)).toHaveCount(0);
  });

  /**
   * ⚠️ **반대 방향이 더 나쁜 버그다** — 늦게 온 데이터가 유저 조작을 덮으면 유저가 방금 고른 팀이
   * 눈앞에서 바뀐다. 유저가 만졌으면 그 선택이 이긴다(칩과 선택이 **달라지는 것이 정답**인 유일한 자리).
   *
   * ⚠️ **표본을 홈 픽스처로 바꿨다**(R2). R1 의 표본은 어웨이 픽스처에서 `home`(= 도착 전 기본값,
   * 이미 선택된 칩)을 눌렀는데, 그건 **화면이 하나도 안 바뀌는 탭**이라 minor-1 수정 뒤로는
   * "유저가 골랐다"가 아니다. 홈 픽스처면 기본값(home)과 내 팀(home)이 같아서, 유저가 `away` 로
   * **실제로 바꾼 뒤** 도착한 `myTeamSide=home` 이 그것을 덮는지 **탭 한 번으로 직접** 볼 수 있다.
   *
   * ⚠️ **R2 가 여기 적었던 *"어웨이 픽스처에서는 진짜 선택이 존재하지 않는다"* 는 거짓이다**(R3 —
   * 독립검증 major-1). 참인 것은 **초기 상태에서 탭 한 번으로는 만들 수 없다**는 것뿐인데 문장이
   * 픽스처 전체로 양화됐다. **2탭이면 만들어진다** — 아래 "2탭" 계약이 그 표본이고 직접 잰 값은
   * 그 머리말에 있다. 홈 픽스처를 고른 이유는 불가능이 아니라 **더 직접적이기 때문**이다(1탭).
   */
  test("`/api/me` 도착 전에 유저가 고르면 그 선택이 이긴다 (홈 픽스처)", async ({ page }) => {
    await openResult(page, { meDelayMs: 600, shape: "home-fixture" });
    // 아직 칩이 없다 = myTeamSide 미도착(전제). 이때 기본 선택은 `home` 이다.
    await expect(page.getByTestId("players-teams").locator("[data-testid^='players-my-team-']")).toHaveCount(0);
    await expect(page.getByTestId("players-team-home")).toHaveAttribute("data-selected", "true");
    await page.getByTestId("players-team-away").click(); // 화면이 실제로 바뀌는 선택

    await expect(page.getByTestId("players-my-team-home")).toHaveCount(1); // 이제 도착(내 팀 = home)
    const s = await segmentState(page);
    expect(s, "늦게 온 myTeamSide 가 유저 선택을 덮었다").toEqual({ mine: "home", selected: "away" });
    await expect(page.getByTestId("players-row-away-P014")).toHaveCount(1);
    await expect(page.getByTestId("players-row-home-P116")).toHaveCount(0);
  });

  /**
   * ⚠️ **아무것도 안 바뀌는 탭은 "골랐다"가 아니다** (R2 — 독립검증 minor-1).
   *
   * `myTeamSide` 도착 전에는 세그먼트가 `home`(= **상대**)에 선택돼 있다. 그때 유저가 **이미
   * 하이라이트된 그 칩**을 한 번 누르면 값이 안 바뀌는데도 `picked` 가 굳어, 도착 후에도 표가
   * 상대에 남았다 — **major-1 과 똑같은 증상이 오탭 경로로** 살아 있었다.
   * (수정 전 실측 `meDelayMs 2500`: 도착 후 선택 `home`, 표 `home 11행 / away 0행`.)
   *
   * ⚠️ 위 "유저 선택이 이긴다" 계약과 **짝**이다 — 한쪽만 두면 반대쪽으로 되돌리는 변이가 산다.
   * 갈리는 축은 *"그 탭이 화면을 바꿨나"* 하나다.
   */
  test("`/api/me` 도착 전 **이미 선택된** 칩을 눌러도 내 팀으로 따라간다", async ({ page }) => {
    await openResult(page, { meDelayMs: 900 });
    // 전제 — 아직 칩이 없고(myTeamSide 미도착) 선택은 상대(home)에 있다.
    await expect(page.getByTestId("players-teams").locator("[data-testid^='players-my-team-']")).toHaveCount(0);
    await expect(page.getByTestId(`players-team-${OPP_TEAM}`)).toHaveAttribute("data-selected", "true");

    await page.getByTestId(`players-team-${OPP_TEAM}`).click(); // 무의미한 탭 1회

    await expect(page.getByTestId(`players-my-team-${MY_TEAM}`)).toHaveCount(1); // 도착
    await expect
      .poll(async () => JSON.stringify(await segmentState(page)), {
        message: "무의미한 탭 한 번이 세그먼트를 상대 팀에 가뒀다",
      })
      .toBe(JSON.stringify({ mine: MY_TEAM, selected: MY_TEAM }));
    // 표까지 — 선택 표시만 옮기고 행은 상대 것인 구현을 통과시키지 않는다.
    await expect(page.getByTestId(`players-row-${MY_TEAM}-P014`)).toHaveCount(1);
    await expect(page.getByTestId(`players-row-${OPP_TEAM}-P116`)).toHaveCount(0);
  });

  /**
   * ⚠️ **어웨이 라운드에서도 유저의 진짜 선택이 이긴다 — 2탭 표본** (R3, 독립검증 major-1).
   *
   * 위 "유저 선택이 이긴다"는 홈 픽스처다(1탭이라 더 직접적이다). 그런데 `apps/web/CLAUDE.md`
   * #322 가 *"표본이 계약의 절반"* 이라고 적어 둔 자리가 정확히 **어웨이 라운드**다 — 기존 web
   * 목·계약이 전부 유저=홈이라 "홈은 내가 아니다"가 3개월 살았다. R2 의 표본 교체가 이 축을
   * 홈으로 밀었으므로 여기서 되돌려 놓는다(교체 자체는 유지 — 두 표본은 짝이다).
   *
   * 어웨이 픽스처에서 **초기 상태의 1탭**은 *따라간다*와 구별되지 않는다(고를 수 있는 반대쪽이
   * 곧 나중에 올 내 팀이다). **2탭이면 구별된다** — `away`(실변화 ①) → `home`(실변화 ②)은 둘 다
   * no-op 가드에 안 걸리는 진짜 선택이고, 착지가 *따라간다*와 다르다. 직접 잰 값(`meDelayMs 900`):
   *   · 탭 0회 → 도착 후 `{mine:"away", selected:"away"}` · `away-P014` 1행 / `home-P116` 0행
   *   · 탭 2회 → 도착 후 `{mine:"away", selected:"home"}` · `home-P116` 1행 / `away-P014` 0행
   *     (16초 = 폴링 여러 바퀴 뒤에도 그대로)
   *
   * ⚠️ **중간 상태를 같이 잰다** — 두 탭이 실제로 화면을 바꿨다는 것이 "진짜 선택"의 정의이고,
   * 그걸 안 재면 이 계약이 no-op 탭 계약과 같은 것을 재는지 아무도 모른다.
   */
  test("어웨이 라운드에서 도착 전 2탭 — 유저의 진짜 선택이 이긴다", async ({ page }) => {
    await openResult(page, { meDelayMs: 900 });
    // 전제 — 아직 칩이 없고(myTeamSide 미도착) 기본 선택은 상대(home)다.
    await expect(page.getByTestId("players-teams").locator("[data-testid^='players-my-team-']")).toHaveCount(0);
    await expect(page.getByTestId(`players-team-${OPP_TEAM}`)).toHaveAttribute("data-selected", "true");

    await page.getByTestId(`players-team-${MY_TEAM}`).click(); // 실변화 ① (home → away)
    await expect(page.getByTestId(`players-team-${MY_TEAM}`)).toHaveAttribute("data-selected", "true");
    await page.getByTestId(`players-team-${OPP_TEAM}`).click(); // 실변화 ② (away → home)
    await expect(page.getByTestId(`players-team-${OPP_TEAM}`)).toHaveAttribute("data-selected", "true");

    await expect(page.getByTestId(`players-my-team-${MY_TEAM}`)).toHaveCount(1); // 이제 도착
    const s = await segmentState(page);
    expect(s, "늦게 온 myTeamSide 가 어웨이 라운드에서 유저 선택을 덮었다").toEqual({
      mine: MY_TEAM,
      selected: OPP_TEAM,
    });
    // 표까지 — 선택 표시만 남기고 행은 되돌아간 구현을 통과시키지 않는다.
    await expect(page.getByTestId(`players-row-${OPP_TEAM}-P116`)).toHaveCount(1);
    await expect(page.getByTestId(`players-row-${MY_TEAM}-P014`)).toHaveCount(0);
  });

  test("상대로 바꾸면 상대 행이 나온다 — 결정 ②(상대도 완전히 동일)", async ({ page }) => {
    await openResult(page);
    await expect(page.getByTestId(`players-row-${MY_TEAM}-P014`)).toHaveCount(1);
    await page.getByTestId(`players-team-${OPP_TEAM}`).click();
    await expect(page.getByTestId(`players-row-${OPP_TEAM}-P116`)).toHaveCount(1);
    await expect(page.getByTestId(`players-row-${MY_TEAM}-P014`)).toHaveCount(0);
  });

  /**
   * ⚠️ **세그먼트를 바꿔도 섹션이 화면 밖으로 사라지지 않는다.** 탭 사이 스크롤 이월(#403 W2)이
   * 두 웨이브 연속으로 캡처에서만 보였던 부류라, 같은 구조(한 스크롤러 안의 전환)를 직접 잰다.
   */
  test("세그먼트를 바꿔도 표 머리가 화면 안에 남는다 (양방향)", async ({ page }) => {
    await openResult(page);
    // 섹션이 보이는 자리까지 스크롤한 뒤 전환한다.
    await page.getByTestId("result-players").scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    for (const t of [OPP_TEAM, MY_TEAM, OPP_TEAM] as const) {
      await page.getByTestId(`players-team-${t}`).click();
      await page.waitForTimeout(120);
      const table = await box(page, "players-table");
      expect(table.y, `${t} 전환 후 표가 화면 위로 사라졌다(top ${table.y})`).toBeLessThan(table.vh);
      const seg = await box(page, "players-teams");
      expect(seg.hitSelf, `${t} 전환 후 세그먼트를 다른 것이 덮는다`).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ④ **MOTM 게이트** — 진행 중인 경기에 "이 경기 최우수 선수"는 없다(`motmKeyFor`).
 *
 * ⚠️ 결과 탭은 `FINISHED` 전용이라 그 화면에서는 게이트가 **항상 참**이다 — 게이트를 지우는
 * 변이를 죽이는 것은 **이 라이브 케이스뿐**이다(그래서 W4 스펙에 산다).
 */
test.describe("④ 진행 중에는 MOTM 이 없다", () => {
  test("후반 재생 중 선수 탭 — motm 등급 칩이 0개(평점칩은 있다)", async ({ page }) => {
    await open(page, "SECOND_HALF");
    await viewerReady(page);
    await seek(page, 1700); // 골이 이미 두 개 난 지점 — "아직 아무 일도 없어서" 0 인 게 아니다.
    await page.getByTestId("stage-tab-players").click();
    await expect(page.getByTestId("stage-panel-players")).toHaveCount(1);
    for (const t of ["home", "away"] as const) {
      await page.getByTestId(`players-team-${t}`).click();
      const chips = await readTable(page, t);
      expect(chips.length, `${t}: 표가 비었다`).toBeGreaterThan(5); // 양성 앵커
      const motm = await page.locator(`[data-testid^="players-rating-${t}-"][data-tier="motm"]`).count();
      expect(motm, `${t}: 진행 중인데 MOTM 칩이 ${motm}개 떴다`).toBe(0);
    }
    // 대조: 같은 픽스처를 종료 상태로 열면 MOTM 이 실제로 있다(= 위 0 이 "원래 없음"이 아니다).
    await page.getByTestId("stage-tab-log").click();
  });

  test("대조군 — 종료 경기에는 MOTM 이 있다", async ({ page }) => {
    await openResult(page);
    await expect(page.getByTestId("result-motm")).toHaveCount(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ⑤ **빈 상태** — 하프 로그가 없는 경기(`hasHalves:false`).
 * 서버는 404 를 주고, 그건 오류가 아니라 **사실**이다. 두 문구를 하나로 합치면 유저가 영영
 * 안 될 것을 다시 시도하거나(전자), 있는 기록을 없다고 믿는다(후자).
 */
test.describe("⑤ 로그 없는 과거 경기 — 정직한 빈 상태", () => {
  test("표 대신 '기록이 남아 있지 않습니다' — 빈 표를 그리지 않는다", async ({ page }) => {
    await mockApi(page, "FINISHED");
    await mockNoLogMatch(page);
    await authInit(page);
    await page.goto(`/match/${NO_LOG_MATCH_ID}`);
    await expect(page.getByTestId("stage-shell")).toBeVisible();
    await page.getByTestId("stage-tab-result").click();

    await expect(page.getByTestId("result-players")).toHaveCount(1); // 섹션 자체는 있다(앵커)
    await expect(page.getByTestId("result-players-missing")).toHaveCount(1);
    await expect(page.getByTestId("result-players-missing")).toContainText("기록이 남아 있지 않습니다");
    // 빈 표·유령 MOTM 을 그리지 않는다.
    await expect(page.getByTestId("players-table")).toHaveCount(0);
    await expect(page.getByTestId("result-motm")).toHaveCount(0);
    // 그리고 **오류 문구는 아니다** — 다시 시도하면 될 것처럼 읽히면 안 된다.
    await expect(page.getByTestId("result-players-error")).toHaveCount(0);
    // 결과 화면의 나머지(스코어·CTA)는 그대로 성립한다.
    await expect(page.getByTestId("final-score")).toHaveCount(1);
    expect((await box(page, "to-lobby")).inViewport).toBe(true);
  });

  /**
   * ⚠️ **반대 방향** — 진짜 오류(500)를 "기록 없음"으로 덮으면 **있는 기록을 없다고 말한다**
   * (R1 — 독립검증 minor-2). `usePlayerStats.logMissing` 의 `error.status === 404` 를 지우고
   * `curEnabled && isError` 로 바꾸는 변이가 **SURVIVED** 했다 — `result-players-error` 를 양성으로
   * 확인하는 단언이 리포 전체에 **0건**이었기 때문이다(404 → 오류 방향만 이미 걸려 있었다).
   *
   * 두 문구는 유저에게 **다른 행동**을 시킨다: 오류는 다시 시도할 수 있고, 기록 없음은 영영 없다.
   */
  test("500 이면 '불러오지 못했습니다' — '기록 없음' 으로 덮지 않는다", async ({ page }) => {
    // 같은 매치를 여는 절차는 `open` 한 곳이다 — 500 목만 `beforeGoto` 로 끼운다(R2 minor-3).
    await open(page, "FINISHED", "away-fixture", {}, (p) => mockHalfLogError(p, 500));
    await page.getByTestId("stage-tab-result").click();

    await expect(page.getByTestId("result-players")).toHaveCount(1); // 섹션 자체는 있다(앵커)
    await expect(page.getByTestId("result-players-error")).toHaveCount(1);
    await expect(page.getByTestId("result-players-error")).toContainText("불러오지 못했습니다");
    // ⚠️ 이게 이 계약의 핵심 — 500 을 "기록이 남아 있지 않습니다" 로 말하면 안 된다.
    await expect(page.getByTestId("result-players-missing")).toHaveCount(0);
    await expect(page.getByTestId("players-table")).toHaveCount(0);
    await expect(page.getByTestId("result-motm")).toHaveCount(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ⑥ **과거 경기 (요구 D)** — 목업 ⑥ 의 주장(*"새 화면 없이 이미 된다"*)을 화면에서 확인한다.
 * 진입 = `/logs` → (`/me` 리다이렉트) → 경기 로그 목록 → 행 → `/match/:id`.
 */
test.describe("⑥ 과거 경기 — 목록에서 열면 개인 성적·선수 상세가 나온다", () => {
  test("목록 뱃지 문구가 `▶ 기록` · 로그 없는 경기엔 뱃지가 없다", async ({ page }) => {
    await mockApi(page, "FINISHED");
    await mockPastLogs(page);
    await authInit(page);
    await page.goto("/logs");
    await expect(page.getByTestId(`match-log-${MATCH_ID}`)).toHaveCount(1);
    await expect(page.getByTestId(`match-replay-${MATCH_ID}`)).toHaveText("▶ 기록");
    // 규칙 하나당 표본 하나 — 같은 화면에 로그 없는 행이 있고 거기엔 뱃지가 없다.
    await expect(page.getByTestId(`match-log-${NO_LOG_MATCH_ID}`)).toHaveCount(1);
    await expect(page.getByTestId(`match-replay-${NO_LOG_MATCH_ID}`)).toHaveCount(0);
  });

  test("행을 누르면 그 경기의 종료 화면 → 개인 성적 → 선수 상세까지 열린다", async ({ page }) => {
    await mockApi(page, "FINISHED");
    await mockPastLogs(page);
    await authInit(page);
    await page.goto("/logs");
    await page.getByTestId(`match-log-${MATCH_ID}`).click();

    await expect(page).toHaveURL(new RegExp(`/match/${MATCH_ID}$`));
    await expect(page.getByTestId("stage-shell")).toBeVisible();
    await page.getByTestId("stage-tab-result").click();

    // 요구 C 가 과거 경기에서도 그대로 성립한다.
    await expect(page.getByTestId("result-players")).toHaveCount(1);
    await expect(page.getByTestId("result-motm")).toHaveCount(1);
    await expect(page.getByTestId(`players-row-${MY_TEAM}-P014`)).toHaveCount(1);

    // 선수 상세(W3)도 같은 화면에서 열린다 — 진입점은 `선수` 탭이다.
    await page.getByTestId("stage-tab-players").click();
    await page.getByTestId(`players-row-${MY_TEAM}-P014`).click();
    await expect(page.getByTestId("player-detail")).toBeVisible();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ⑦ **지오메트리 무회귀** — 새 섹션이 결과 시트를 밀지 않는다.
 * (6열 표가 넘칠 때 스크롤 대신 부모를 늘리면 시트가 통째로 밀리는데 **문서 스크롤은 0** 이라
 * 기존 계약이 전부 green 이다 — #284 에서 실제로 당한 모양. 그래서 폭을 직접 잰다.)
 */
test.describe("⑦ 폰 390×844 — 넘치지 않고 CTA 도 그대로다", () => {
  test("문서 스크롤 0 · 시트 폭 ≤ 뷰포트 · [로비로] 화면 안", async ({ page }) => {
    await openResult(page);
    const s = await pageScroll(page);
    expect(s.v, "문서 세로 스크롤이 생겼다").toBeLessThanOrEqual(1);
    expect(s.h, "가로 오버플로가 생겼다").toBeLessThanOrEqual(1);

    const sheet = await box(page, "stage-sheet");
    expect(sheet.w, `시트 폭 ${sheet.w} > 뷰포트 ${sheet.vw}`).toBeLessThanOrEqual(sheet.vw);
    const table = await box(page, "players-table");
    expect(table.w, `표 폭 ${table.w} 가 시트(${sheet.w})를 넘겼다`).toBeLessThanOrEqual(sheet.w);

    const cta = await box(page, "to-lobby");
    expect(cta.inViewport, `[로비로] 가 화면 밖 — bottom ${cta.bottom} > ${cta.vh}`).toBe(true);
    expect(cta.hitSelf, "[로비로] 중심을 다른 것이 받는다").toBe(true);
  });

  /**
   * ⚠️ **여기 있던 "탭 이월 스크롤 양방향" 단언은 공허했다** (R1 — 독립검증 minor-6b).
   *
   * 결과 탭은 `panelFlush`(바깥 `overflow:hidden`)라 **바깥 스크롤러의 `scrollTop` 이 애초에 0**
   * 이고, 되돌아올 때 `result-scroll` 은 조건부 렌더라 **어차피 새 노드**다 — 그래서
   * `key={activeTab}`(`StageShell`)을 **제거해도 SURVIVED** 했다(0 == 0 을 두 번 잰 셈).
   * 그 성질을 실제로 지키는 계약은 `p403-player-tab.spec.ts` "로그를 보다 넘어와도 맨 위에서
   * 열린다" **하나뿐**이고(로그 패널이 자기 마지막 줄로 스크롤해 둔 상태가 전제다), R1 에서
   * `key` 제거 변이로 그쪽이 **KILLED** 되는 것을 확인했다. 그래서 여기서는 **지우고**,
   * 이 화면에서 실제로 이월이 가능한 축 — **결과 탭 안의 세그먼트 전환** — 으로 재조준한다.
   *
   * ⚠️ 양성 앵커(`before > 8`)가 없으면 이 계약도 다시 0 == 0 이 된다.
   */
  test("세그먼트를 바꿔도 읽던 자리를 잃지 않는다 (결과 탭 내부 · 양성 앵커)", async ({ page }) => {
    await openResult(page, { growth: true }); // 성장 리포트까지 붙여 스크롤 여유를 확보한다
    const scrollTop = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="result-scroll"]') as HTMLElement | null;
        return el?.scrollTop ?? -1;
      });

    // 개인 성적이 화면에 오도록 내린다.
    await page.getByTestId("result-players").scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    const before = await scrollTop();
    expect(before, "결과 패널에 스크롤 여유가 없다 — 이 계약이 공허해진다").toBeGreaterThan(8);

    await page.getByTestId(`players-team-${OPP_TEAM}`).click();
    await expect(page.getByTestId(`players-team-${OPP_TEAM}`)).toHaveAttribute("data-selected", "true");
    await page.waitForTimeout(120);
    const after = await scrollTop();
    expect(after, `세그먼트를 바꾸자 스크롤이 맨 위로 튕겼다(${before} → ${after})`).toBeGreaterThan(8);
    // 그리고 표는 여전히 화면 안이다(= 자리를 지켰다는 것이 눈에도 보인다).
    expect((await box(page, "players-teams")).hitSelf).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
/**
 * ⑧ **게이트 합성** — `needsPlayerStats(activeTab)` → `useMatchPlayerStats(enabled)` (R1, minor-3).
 *
 * `stage-state.test.ts` 는 술어를, `usePlayerStats.test.ts` 는 훅을 각각 본다. **둘의 합성**은
 * 아무도 안 봤고, 그래서 `needsPlayerStats(activeTab)` → `true` 변이가 **SURVIVED** 했다.
 * 현재 동작은 옳다(W2 MAJ-1 이 살던 자리이므로 회귀 위험만 남은 축이다).
 *
 * ⚠️ **출하 코드에 계측을 남기지 않는다** — 검증자는 `computePlayerStats` 에 카운터를 주입했지만
 * 그건 소스를 건드리는 방법이다. 대신 **그 게이트가 켜져야만 나가는 요청**을 센다:
 * `usePlayerStats` 의 `priorEnabled = enabled && half === 2 && …` 가 **전반 로그**를 부르는데,
 * 셸(`StageShell`)은 지금 재생 중인 하프(=후반)만 받으므로 **후반 관전 중 `/halves/1/log` 는
 * 선수 기록 집계가 켜졌다는 것의 유일한 외부 신호**다.
 *
 * ⚠️ 그래서 상태는 `SECOND_HALF` 여야 한다 — `FINISHED` 는 기본 탭이 이미 `result`(=켜짐)라
 * "꺼져 있는 상태"를 만들 수 없다.
 */
test.describe("⑧ 집계는 보는 탭에서만 켜진다 (게이트 합성)", () => {
  const H1 = /\/api\/matches\/.+\/halves\/1\/log$/;

  test("로그 탭에서는 전반 로그를 안 부르고, 선수 탭으로 가면 부른다", async ({ page }) => {
    const c = countRequests(page, H1);
    await open(page, "SECOND_HALF");
    // 기본 탭 = 로그(#284). 패널이 실제로 떴는지부터 확인한다(전제).
    await expect(page.getByTestId("stage-panel-log")).toHaveCount(1);
    await page.waitForTimeout(600); // 늦게 나가는 요청까지 잡을 여유
    expect(c.n, `로그 탭인데 전반 로그를 ${c.n}회 불렀다 = 아무도 안 보는데 집계가 돈다`).toBe(0);

    await page.getByTestId("stage-tab-players").click();
    await expect(page.getByTestId("stage-panel-players")).toHaveCount(1);
    // 양성 앵커 — 게이트가 켜지면 실제로 나간다(0 == 0 을 재고 끝나지 않게).
    await expect.poll(() => c.n, { message: "선수 탭인데 전반 로그를 안 불렀다" }).toBeGreaterThan(0);
    // 그리고 그 표는 **경기 진행분**이다(전반 골이 실려 있다 = 합쳤다는 증거).
    await expect(page.getByTestId(`players-goals-${MY_TEAM}-P034`)).toHaveText("1");
  });
});
