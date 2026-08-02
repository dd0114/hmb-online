import { expect, test } from "@playwright/test";
import {
  AWAY_GK,
  CARD_CAPS,
  CARD_START_LO,
  H1_SCORER,
  H2_SCORER,
  PHONE,
  box,
  mockDeckPrompt,
  mockGrowthCard,
  open,
  openDetail,
  openPlayers,
  pageScroll,
} from "./p403-mocks";

/**
 * #403 W3 **선수 상세 모달** 계약 (목업 화면 ③④).
 *
 * ⚠️ 표본은 **어웨이 라운드**다 — 내 팀이 `away`, 상대(봇)가 `home` 이다(`p403-mocks` 머리말).
 * "홈 = 나" 로 읽으면 이 파일의 절반이 반대로 보인다.
 *
 * ── 무엇을 잰다 ─────────────────────────────────────────────────────────────────────────
 *  ① 진입·닫기 — 선수 탭 행이 문이다((B) 피치 터치는 이 브랜치에 없다, #421 대기)
 *  ② [이 경기] — **선수 탭과 같은 집계**를 본다 · 라이브 캡션은 `statsWindow` 에서 온다 · GK 축
 *  ③ [선수 정보] — 강화탭과 **같은 컴포넌트** · 내 카드 `full` / 상대 `reduced`
 *  ④ **없는 것을 없다고 말하나** — 축소 모드가 3층·천장을 0 으로 그리지 않는다
 *  ⑤ 경계 — 열람 전용(강화·리롤 없음) · 지시 비공개 · 매치 화면 풀아트 0(#285)
 */

test.use({ viewport: PHONE, hasTouch: true });

const MY_TEAM = "away" as const;
const OPP_TEAM = "home" as const;
/** 상대(봇) 필드 플레이어 — 축소 모드 표본. */
const OPP_FW = "P171";

// ══════════════════════════════════════════════════════════════════════════════════════
test.describe("① 진입 — 행이 문이다", () => {
  test("행을 누르면 그 선수 상세가 열린다 (목업 ①→③)", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, MY_TEAM, H2_SCORER);

    const modal = page.getByTestId("player-detail");
    await expect(modal).toHaveAttribute("data-player", H2_SCORER);
    await expect(modal).toHaveAttribute("data-team", MY_TEAM);
    await expect(modal).toHaveAttribute("data-mine", "true");
  });

  test("상대 행도 같은 문을 연다 — 기록은 완전히 동일하다(결정 ②)", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, OPP_TEAM, OPP_FW);
    await expect(page.getByTestId("player-detail")).toHaveAttribute("data-mine", "false");
    // 카테고리 구성이 내 선수와 **같다** — 상대만 항목이 빠지지 않는다.
    for (const cat of ["attack", "pass", "defence", "work", "discipline"]) {
      await expect(page.getByTestId(`pdetail-cat-${cat}`)).toHaveCount(1);
    }
  });

  test("[닫기]와 Escape 로 닫힌다 — 관전 화면으로 돌아온다", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, MY_TEAM, H2_SCORER);
    await page.getByTestId("pdetail-close").click();
    await expect(page.getByTestId("player-detail")).toHaveCount(0);

    await openDetail(page, MY_TEAM, H2_SCORER);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("player-detail")).toHaveCount(0);
    // 뒤의 선수 탭은 그대로 살아 있다(모달이 화면을 갈아치우지 않는다).
    await expect(page.getByTestId("stage-panel-players")).toBeVisible();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
test.describe("② [이 경기] — 표와 같은 집계를 본다", () => {
  /**
   * 🚨 두 화면이 **같은 결과**를 봐야 한다(집계는 셸이 한 번 돌린다). 값이 갈리면 그 자리에서
   * 신뢰를 잃는다 — 표는 1골이라 하고 상세는 0골이라 하는 화면이 그 형태다.
   */
  test("표의 골·평점이 모달의 KPI·평점과 같다", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    const tableGoals = await page.getByTestId(`players-goals-${MY_TEAM}-${H2_SCORER}`).textContent();
    const tableRating = await page.getByTestId(`players-rating-${MY_TEAM}-${H2_SCORER}`).textContent();
    expect(Number(tableGoals), "표본이 0 골이면 이 계약이 공허하다").toBeGreaterThan(0);

    await openDetail(page, MY_TEAM, H2_SCORER);
    await expect(page.getByTestId("pdetail-kpi-goals")).toContainText(tableGoals!.trim());
    await expect(page.getByTestId("pdetail-rating")).toHaveText(tableRating!.trim());
  });

  /**
   * 캡션은 `statsWindow` **하나**가 상한과 같이 정한다(BL-1). 모달이 분을 다시 조립하면
   * 감독시간이 "N분까지" 위에 전 선수 0 을 그린 그 사고가 두 번째 화면에서 되살아난다.
   */
  test("라이브 하프면 캡션이 뜨고, 확정된 하프면 없다 — 표와 같은 창", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, MY_TEAM, H1_SCORER);
    await expect(page.getByTestId("pdetail-live-caption")).toHaveCount(0);
    await page.getByTestId("pdetail-close").click();

    await openPlayers(page, "SECOND_HALF");
    const tableCaption = await page.getByTestId("players-live-caption").textContent();
    await openDetail(page, MY_TEAM, H1_SCORER);
    await expect(page.getByTestId("pdetail-live-caption")).toContainText(tableCaption!.trim());
  });

  test("GK 는 공격 대신 선방 카테고리다 — xG 를 묻지 않는다(목업 ③ 각주)", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, MY_TEAM, AWAY_GK);
    await expect(page.getByTestId("pdetail-cat-keeper")).toHaveCount(1);
    await expect(page.getByTestId("pdetail-cat-attack")).toHaveCount(0);
    await expect(page.getByTestId("pdetail-kpi-savePct")).toHaveCount(1);
    await expect(page.getByTestId("pdetail-kpi-xg")).toHaveCount(0);
  });

  test("필드 플레이어는 그 반대다(대조군)", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, MY_TEAM, H2_SCORER);
    await expect(page.getByTestId("pdetail-cat-attack")).toHaveCount(1);
    await expect(page.getByTestId("pdetail-cat-keeper")).toHaveCount(0);
    await expect(page.getByTestId("pdetail-kpi-xg")).toHaveCount(1);
  });

  test("히트맵이 실제 격자를 그린다 — 매 틱 좌표가 로그에 있다(엔진 무접촉)", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, MY_TEAM, H2_SCORER);
    const heat = page.getByTestId("pdetail-heat");
    await expect(heat).toBeVisible();
    const cols = Number(await heat.getAttribute("data-cols"));
    const rows = Number(await heat.getAttribute("data-rows"));
    await expect(heat.locator("i")).toHaveCount(cols * rows);
    // 전부 같은 밀도면 "여기저기 다녔다"는 거짓 신호다 — 실제로 분포가 있어야 한다.
    const opacities = await heat.locator("i").evaluateAll((els) =>
      els.map((e) => Number((e as HTMLElement).style.opacity || "0")),
    );
    expect(new Set(opacities).size).toBeGreaterThan(1);
    expect(Math.max(...opacities)).toBeCloseTo(1, 5);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
test.describe("③④ [선수 정보] — 강화탭과 같은 컴포넌트 · 두 모드", () => {
  /**
   * 🚨 **같은 selector 로 두 화면을 잰다**(`growth-*`). 이름을 화면별로 갈랐으면 "같은 컴포넌트"
   * 라는 성질을 계약이 확인할 수 없다 — 여기서 통과한다는 것이 곧 그 증거다.
   */
  test("내 카드 = full — 3층 막대 · 천장 마커 · 범례 · 서버 startLo 축", async ({ page }) => {
    await open(page, "FINISHED");
    await mockGrowthCard(page, H2_SCORER);
    await page.getByTestId("stage-tab-players").click();
    await openDetail(page, MY_TEAM, H2_SCORER);
    await page.getByTestId("pdetail-tab-info").click();

    await expect(page.getByTestId("growth-attr-reduced")).toHaveCount(0);
    await expect(page.getByTestId("pdetail-ovr")).toBeVisible();

    await page.getByTestId("growth-layer-total").click();
    await expect(page.getByTestId("growth-attrs")).toHaveAttribute("data-mode", "full");
    // 축 = [서버 startLo, caps 최대] — 클라 밴드 미러가 아니라 카드가 들고 온 값이다(§2.8).
    const hi = Math.max(...Object.values(CARD_CAPS));
    await expect(page.getByTestId("growth-attr-window")).toHaveText(`스탯 축 ${CARD_START_LO}–${hi}`);
    await expect(page.getByTestId("growth-attr-legend")).toContainText("성장분");
    await expect(page.getByTestId("growth-cap-shooting")).toHaveAttribute(
      "data-value",
      String(CARD_CAPS.shooting),
    );
    // 성장분이 실제로 폭을 갖는다(statAdd 2.5) — 0px 이면 3층이 죽은 것이다.
    const growWidth = await page
      .getByTestId("growth-grow-shooting")
      .evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    expect(growWidth).toBeGreaterThan(0);
  });

  /**
   * 🚨 **없는 것을 0 으로 그리지 않는다.** 서버가 남의 성장 진행도를 주지 않으므로(목업 ④ 데이터
   * 경계) 3층·천장·레이더 캡이 **아예 없어야** 한다 — 0 으로 그리면 "이 상대는 한 번도 안 큰
   * 카드"라는 거짓을 화면이 단언한다.
   */
  test("상대 = reduced — 값은 그대로, 성장 진행도만 **없다**(0 이 아니라 부재)", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, OPP_TEAM, OPP_FW);
    await page.getByTestId("pdetail-tab-info").click();

    // 무엇이 빠졌는지 화면이 말한다.
    const note = page.getByTestId("growth-attr-reduced");
    await expect(note).toBeVisible();
    await expect(note).toContainText("기본치");

    // 레이더는 그린다(능력치는 공개 대상) — 캡 점선만 없다.
    await expect(page.getByTestId("growth-radar-svg")).toBeVisible();
    await expect(page.getByTestId("growth-radar-polygon-value")).toBeVisible();
    await expect(page.getByTestId("growth-radar-polygon-cap")).toHaveCount(0);

    await page.getByTestId("growth-layer-total").click();
    await expect(page.getByTestId("growth-attrs")).toHaveAttribute("data-mode", "reduced");
    // 3층·천장·범례가 통째로 없다.
    await expect(page.getByTestId("growth-grow-shooting")).toHaveCount(0);
    await expect(page.getByTestId("growth-cap-shooting")).toHaveCount(0);
    await expect(page.getByTestId("growth-attr-legend")).toHaveCount(0);
    // 그래도 능력치 숫자는 9종 다 보인다.
    await expect(page.locator('[data-testid^="growth-value-"]')).toHaveCount(9);
    // OVR 은 카탈로그에 없다 — 지어내지 않는다.
    await expect(page.getByTestId("pdetail-ovr")).toHaveCount(0);
  });

  /**
   * 🚨 **탭을 바꾸면 맨 위에서 열린다.** 두 탭이 같은 스크롤러를 쓰므로 앞 탭의 `scrollTop` 을
   * 물고 가면 [선수 정보]가 **OVR·레이더가 위로 잘린 채** 시작한다 — 실화면 캡처로만 보였고
   * 계약은 전부 green 이었다(#403 W2 의 시트가 같은 함정을 먼저 겪었다).
   */
  test("[이 경기]를 내려 본 뒤 [선수 정보]로 가도 맨 위에서 열린다", async ({ page }) => {
    await open(page, "FINISHED");
    await mockGrowthCard(page, H2_SCORER);
    await page.getByTestId("stage-tab-players").click();
    await openDetail(page, MY_TEAM, H2_SCORER);

    const scrolled = await page.getByTestId("pdetail-panel-match").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(scrolled, "본문이 스크롤되지 않으면 이 계약이 공허하다").toBeGreaterThan(0);

    await page.getByTestId("pdetail-tab-info").click();
    expect(
      await page.getByTestId("pdetail-panel-info").evaluate((el) => el.scrollTop),
      "새 탭이 앞 탭의 스크롤 위치를 물고 왔다",
    ).toBe(0);
    // 잘린 것이 무엇이었나 — 이 화면의 첫 정보가 화면 안에 있어야 한다.
    expect((await box(page, "pdetail-ovr")).inViewport).toBe(true);
  });

  test("레이더 ↔ 막대 토글이 두 모드 모두에서 돈다(강화탭과 같은 동작)", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, OPP_TEAM, OPP_FW);
    await page.getByTestId("pdetail-tab-info").click();

    await expect(page.getByTestId("growth-layer-radar")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("growth-attrs")).toHaveCount(0);
    await page.getByTestId("growth-layer-total").click();
    await expect(page.getByTestId("growth-radar-svg")).toHaveCount(0);
    await expect(page.getByTestId("growth-attrs")).toHaveCount(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
test.describe("⑤ 경계 — 열람 전용 · 지시 비공개 · 아트 정책", () => {
  /** 목업 ④ 명시: 경기 중에 카드를 강화하게 만드는 것은 이 요구가 아니다. */
  test("강화·리롤·3지선다 버튼이 **없다**", async ({ page }) => {
    await open(page, "FINISHED");
    await mockGrowthCard(page, H2_SCORER);
    await page.getByTestId("stage-tab-players").click();
    await openDetail(page, MY_TEAM, H2_SCORER);
    await page.getByTestId("pdetail-tab-info").click();

    for (const id of ["growth-star-up", "growth-dice-normal", "growth-dice-cash", "choice-candidates"]) {
      await expect(page.getByTestId(id), `${id} 가 상세 모달에 새어들었다`).toHaveCount(0);
    }
    await expect(page.getByTestId("pdetail-readonly")).toBeVisible();
  });

  test("내 선수의 지시는 보이고, 상대의 지시는 비공개다(결정 ③)", async ({ page }) => {
    await open(page, "FINISHED");
    await mockDeckPrompt(page, H2_SCORER, "박스 안에서 과감하게 슈팅해라");
    await page.getByTestId("stage-tab-players").click();

    await openDetail(page, MY_TEAM, H2_SCORER);
    await page.getByTestId("pdetail-tab-info").click();
    await expect(page.getByTestId("pdetail-prompt")).toContainText("과감하게");
    await page.getByTestId("pdetail-close").click();

    await openDetail(page, OPP_TEAM, OPP_FW);
    await page.getByTestId("pdetail-tab-info").click();
    await expect(page.getByTestId("pdetail-prompt-locked")).toBeVisible();
    await expect(page.getByTestId("pdetail-prompt")).toHaveCount(0);
    // 상대 지시문이 DOM 어디에도 없다 — 가리는 것은 CSS 가 아니라 렌더다.
    expect(await page.content()).not.toContain("과감하게");
  });

  /**
   * 경계 표(`apps/web/CLAUDE.md`)는 **매치 화면을 아이콘으로** 못 박았고 `p3-card-art` 의
   * "매치·로비에 풀아트가 없다"가 그 계약이다. 모달을 연 상태에서도 성립해야 한다 —
   * 그 스펙은 페이지 로드만 보므로 여기가 그 구멍을 메운다.
   */
  test("모달을 열어도 매치 화면에 풀아트가 없다 (#285)", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, MY_TEAM, H2_SCORER);
    await expect(page.locator('[data-testid^="full-art-"]')).toHaveCount(0);
    // 표본은 SILVER(카탈로그) 라 임계(DIA) 아래 → 아트 자체를 안 그린다(fail-closed).
    await expect(page.getByTestId(`char-avatar-${H2_SCORER}`)).toHaveAttribute("data-art-policy", "hidden");
  });

  test("폰에서 문서 스크롤 0 · [닫기]가 화면 안 · 본문만 스크롤한다", async ({ page }) => {
    await openPlayers(page, "FINISHED");
    await openDetail(page, MY_TEAM, H2_SCORER);

    const scroll = await pageScroll(page);
    expect(scroll.v, "모달이 문서를 늘렸다").toBeLessThanOrEqual(0);
    expect(scroll.h, "가로 오버플로").toBeLessThanOrEqual(0);

    const close = await box(page, "pdetail-close");
    expect(close.inViewport, "[닫기]가 화면 밖이다").toBe(true);
    expect(close.hitSelf, "[닫기]가 무언가에 덮였다").toBe(true);
  });
});
