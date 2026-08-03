import { expect, test, type Page } from "@playwright/test";
import {
  BOT,
  MATCH_ID,
  ME,
  NO_LOG_MATCH_ID,
  PHONE,
  authInit,
  box,
  mockApi,
  mockNoLogMatch,
  mockPastLogs,
  open,
  pageScroll,
  seek,
  viewerReady,
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

/** 결과 탭을 연다(종료 상태의 기본 탭이지만 **명시적으로** 고른다 — 기본이 바뀌어도 이 계약이 산다). */
async function openResult(page: Page) {
  await open(page, "FINISHED");
  await page.getByTestId("stage-tab-result").click();
  await expect(page.getByTestId("result-page")).toHaveCount(1);
  await expect(page.getByTestId("result-players")).toHaveCount(1);
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
  test("자리 = 팀 스탯 뒤 · 성장 리포트 앞", async ({ page }) => {
    await openResult(page);
    await expect(page.getByTestId("team-stats")).toHaveCount(1);
    expect(await precedes(page, "team-stats", "result-players"), "개인 성적이 팀 스탯보다 앞에 있다").toBe(true);
    // 성장 리포트는 서버 응답이 있어야 뜬다 — 없으면 이 단언이 공허해지므로 존재부터 확인한다.
    if ((await page.getByTestId("growth-report").count()) > 0) {
      expect(await precedes(page, "result-players", "growth-report"), "개인 성적이 성장 리포트보다 뒤에 있다").toBe(true);
    }
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
     * ⚠️ **동점을 하나로 단정하지 마라.** 실측에서 이 표본은 상한 `10.0` 에 **여러 명이 붙는다**
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
   * 탭 이월 스크롤 — 결과↔선수 **양방향**. `key={activeTab}` 한 줄이 지키는 성질이고,
   * W2·W3 둘 다 계약이 green 인데 캡처에서만 보였던 부류다(그래서 양방향으로 잰다).
   */
  test("탭을 오가면 항상 맨 위에서 열린다 (결과↔선수 양방향)", async ({ page }) => {
    await openResult(page);
    const scrollTop = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="result-scroll"]') as HTMLElement | null;
        return el?.scrollTop ?? -1;
      });
    // 결과 패널을 끝까지 내린 뒤 선수 탭으로 → 선수 탭은 0 에서 시작한다.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="result-scroll"]') as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(120);
    expect(await scrollTop(), "결과 패널에 스크롤 여유가 없다 — 이 계약이 공허해진다").toBeGreaterThan(8);

    await page.getByTestId("stage-tab-players").click();
    await expect(page.getByTestId("stage-panel-players")).toHaveCount(1);
    const afterTab = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stage-panel-players"]')?.parentElement ?? null;
      return (el as HTMLElement | null)?.scrollTop ?? -1;
    });
    expect(afterTab, "선수 탭이 앞 탭의 스크롤을 물고 열렸다").toBeLessThanOrEqual(1);

    // 반대 방향 — 선수 탭을 내린 뒤 결과 탭으로.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stage-panel-players"]')?.parentElement as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(120);
    await page.getByTestId("stage-tab-result").click();
    await expect(page.getByTestId("result-page")).toHaveCount(1);
    expect(await scrollTop(), "결과 탭이 앞 탭의 스크롤을 물고 열렸다").toBeLessThanOrEqual(1);
  });
});
