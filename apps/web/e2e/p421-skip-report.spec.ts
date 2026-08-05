import { expect, test, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { expectNoQaTransport } from "./play-mode-controls";

/**
 * #421 W2 — **경기 스킵 → 하프 리포트 → 닫으면 다음 단계**를 백엔드 없이 route-mock 으로 박제한다.
 *
 * 계약(hero 요구):
 *  1. 경기 화면에 스킵 버튼이 있고, 누르면 경기 장면을 건너뛴다.
 *  2. 스킵하면 **결과 중 중요 내용 리포트가 공지사항처럼** 뜬다(골·카드 타임라인 1장 + 최고 평점 1장).
 *  3. **닫으면 바로 다음** — 전반이면 감독시간(기존 [후반 시작]), 후반이면 결과 화면.
 *
 * 서버 계약(W1, `POST /api/matches/{id}/skip`)에서 이 스펙이 지키는 것:
 *  · 바디 `phase` 는 **필수이고 CAS 키다** — 화면이 지금 보고 있는 단계를 그대로 보내야 한다.
 *    (안 보내거나 틀리게 보내면 서버가 400/409 로 막지만, 그 전에 화면이 옳아야 한다.)
 *  · **409 는 에러가 아니다** — "이미 넘어갔다"이므로 토스트가 아니라 재조회로 따라간다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면.
 */

const MATCH_ID = "m-p421";
const LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
) as { events: { tick: number; minute: number; type: string; team?: string; playerId?: string; detail?: string }[] };

const GOALS = LOG.events.filter((e) => e.type === "goal");
const CARDS = LOG.events.filter((e) => e.type === "card");
/*
 * 리포트에 실려야 할 **줄** 수.
 * ⚠️ 한때 여기 *"이 픽스처엔 경고 누적 퇴장이 없어 병합 대상이 없다"* 라고 적혀 있었는데
 *    **거짓이었다** — 그 문장이 낡은 기대값을 정당화하며 red 를 덮고 있었다(#456 실측).
 *
 * ⚠️ **두 번째 옐로는 레드와 한 줄로 합쳐진다**(`half-report.ts` — *"유저는 카드가 두 장 나온 줄
 * 안다"*). 그래서 행 수는 이벤트 수가 아니다: 데모 로그에는 tick 923 에 `yellow`+`red`(H10)가
 * 같이 있어 14 이벤트 → **13 행**이다.
 * ⚠️ 이 상수는 그동안 `GOALS + CARDS` 였고 **선행 red 였다**(#456 이 발견 — 병합 로직은 손대지
 *    않았고 기대값만 낡아 있었다). 숫자를 박지 않고 **같은 규칙을 유도**해 다시 낡지 않게 한다.
 */
const MERGED_SECOND_YELLOW = CARDS.filter(
  (r) => r.detail === "red" && CARDS.some((y) => y.detail === "yellow" && y.playerId === r.playerId),
).length;
const ROW_COUNT = GOALS.length + CARDS.length - MERGED_SECOND_YELLOW;
/** 이 로그 한 하프의 골 수. 목 서버의 확정 스코어를 **여기서 파생**해 두 축이 어긋나지 않게 한다. */
const HALF = {
  home: GOALS.filter((g) => g.team === "home").length,
  away: GOALS.filter((g) => g.team === "away").length,
};

/**
 * 카탈로그는 로그의 선수 id 를 그대로 덮는다 — 이름이 안 붙으면 그 자리가 빈다.
 *
 * ⚠️ **이벤트 id 만으로는 부족하다**(#421 W7): 주요 인물 카드는 **출전한 22명 전원** 중에서
 * 뽑히는데 이 로그에서 이벤트에 한 번이라도 등장하는 건 21명뿐이라, 하필 그 1명이 뽑히면 이름이
 * id 원문("A4")으로 떨어져 계약이 화면 결함과 구분되지 않는다. 스냅샷 등장 순서를 먼저 깐다.
 */
const SNAP_IDS = ((LOG as unknown as { tickSnapshots?: { players?: { playerId: string }[] }[] }).tickSnapshots ?? [])
  .flatMap((s) => s.players ?? [])
  .map((p) => p.playerId);
const PLAYERS = [...new Set([...SNAP_IDS, ...LOG.events.map((e) => e.playerId).filter(Boolean)])].map((id, i) => ({
  id,
  name: `선수${i + 1}`,
  position: "MF",
  grade: "B",
}));
const DECK = {
  formation: "4-3-3",
  slots: PLAYERS.slice(0, 11).map((p, i) => ({ slotIndex: i, playerId: p.id, role: "starter" as const })),
};

interface Harness {
  /** 서버가 들고 있는 현재 매치 상태(스킵 응답으로 바뀐다). */
  state: string;
  /** 스킵 요청 바디 기록 — `phase` 계약의 증거. */
  skips: unknown[];
  /** 다음 스킵 요청에 409 를 돌려준다(스위퍼가 먼저 경계를 밟은 경합). */
  skipConflict: boolean;
  /** 409 뒤 서버가 실제로 가 있는 상태. */
  conflictState: string;
}

function detailOf(h: Harness) {
  const finished = h.state === "FINISHED";
  return {
    id: MATCH_ID,
    state: h.state,
    // 전반이 끝나기 전에는 서버가 확정 스코어를 내려주지 않는다(스포일러 금지 계약).
    scoreH1Home: h.state === "FIRST_HALF" ? null : HALF.home,
    scoreH1Away: h.state === "FIRST_HALF" ? null : HALF.away,
    scoreHome: finished ? HALF.home * 2 : null,
    scoreAway: finished ? HALF.away * 2 : null,
    result: finished ? "WIN" : null,
    auto: false,
    createdAt: "2026-08-02T09:00:00Z",
    opponent: { name: "봇 FC" },
  };
}

async function mockApi(page: Page, h: Harness) {
  await page.route("**/*", async (route) => {
    const req: Request = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();

    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/skip`) {
      h.skips.push(req.postDataJSON());
      if (h.skipConflict) {
        // 서버는 이미 다음 단계로 가 있다 — 화면이 재조회로 따라가야 한다.
        h.state = h.conflictState;
        return route.fulfill({
          status: 409,
          json: { code: "INVALID_STATE", message: "이미 다음 단계입니다" },
        });
      }
      h.state = h.state === "FIRST_HALF" ? "HALFTIME" : "FINISHED";
      return route.fulfill({ json: detailOf(h) });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill({ json: detailOf(h) });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: { matchId: MATCH_ID, result: "WIN", scoreHome: 4, scoreAway: 2, rewardPoints: 500 },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: LOG });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    if (url.pathname === "/api/me/active-match") {
      return route.fulfill({ json: { match: detailOf(h), locked: true, abandonable: false } });
    }
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, state: string, over: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = { state, skips: [], skipConflict: false, conflictState: "HALFTIME", ...over };
  await mockApi(page, h);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
  await page.locator(`[data-testid="viewer-canvas-half${state === "SECOND_HALF" ? 2 : 1}"]`).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  return h;
}

/**
 * ⚠️ **#424 가 스택의 마지막에 브릿지 카드를 더했다**(`docs/plan-v5/match-flow-bridge.md` §3.2:
 * *"전반 종료(스킵함) : [전반 리포트][주요 인물][B2 브릿지]"*). 스킵 리포트를 **별도 레이어가
 * 아니라 브릿지의 앞 카드**로 둔 결정이라, 여기 계약의 "닫기 = 클릭 한 번"이라는 전제만 바뀐다
 * (리포트가 무엇을 말하는가 · 무대가 도는가 · 409 처리는 그대로다).
 *
 * 그래서 장 수를 세는 대신 **끝까지 넘긴다** — 카드가 몇 장이 되든(#403 평점 카드가 들어오면 3장)
 * "닫으면 바로 다음 단계"라는 #421 의 요구는 이 헬퍼로 계속 검증된다.
 */
async function closeStack(page: Page) {
  const dialog = page.getByTestId("half-report");
  const card = page.getByTestId("half-report-card");
  /*
   * ⚠️ **먼저 떠 있는지 기다린다.** 스택은 스킵 응답이 온 뒤에 뜨므로, 이 헬퍼가 곧바로 `count()`
   * 를 재면 아직 0 이고 아래 루프가 **한 번도 돌지 않은 채** 끝난다 — 그러면 정작 다음 단언에서
   * "안 닫혔다"로 실패해 원인이 엉뚱한 곳을 가리킨다(실측: 그 상태로 test g 만 재현 실패했다).
   */
  await expect(dialog).toBeVisible();
  /**
   * 진행 기록 — **실패했을 때 원인을 말하기 위한 것**이다(독립검증 N6).
   *
   * ⚠️ 아래 `waitForFunction` 의 타임아웃을 `.catch(() => undefined)` 로 **통째로 삼키면 안 된다**.
   * 삼키면 "카드가 안 넘어갔다"가 흔적 없이 사라지고, 실패는 루프 뒤 `toHaveCount(0)` 에서
   * *"다이얼로그가 안 닫혔다"* 로만 나타난다 — 클릭이 안 먹은 건지, 카드가 안 넘어간 건지,
   * 마지막 장에서 안 닫힌 건지 구분할 수 없다. 그렇다고 그 자리에서 **던지면 계약의 뜻이 바뀐다**:
   * 이 헬퍼는 StrictMode 이중 마운트로 클릭이 버려지는 것을 **재시도로 견디는 것이 정상 동작**이다.
   * ⇒ 견디되 **기록**하고, 끝내 못 닫으면 그 기록을 실패 메시지로 낸다.
   */
  const trace: string[] = [];
  for (let i = 0; i < 8 && (await dialog.count()) > 0; i++) {
    const before = await card.getAttribute("data-card");
    await page.getByTestId("half-report-next").click();
    /*
     * ⚠️ **클릭 횟수를 세지 말고 진행을 본다.** dev 서버는 `StrictMode` 라 컴포넌트가 마운트 →
     * 언마운트 → 재마운트 되는데(실측 로그로 확인), 그 창에 들어간 클릭의 `setIndex` 는 버려지는
     * 인스턴스에 적용돼 **사라진다**. 그러면 카드가 안 넘어가고, 횟수로 세는 루프는 조용히 끝난 뒤
     * 엉뚱한 곳에서 실패한다(실제로 그렇게 났다). 진행이 없으면 다음 루프가 다시 누른다.
     * (프로덕션 빌드에는 이중 마운트가 없다 — dev 하네스 한정 성질이다.)
     */
    try {
      await page.waitForFunction(
        (prev) => {
          const c = document.querySelector('[data-testid="half-report-card"]');
          return !c || c.getAttribute("data-card") !== prev;
        },
        before,
        { timeout: 3000 },
      );
      trace.push(`#${i + 1} ${before} → ${(await card.count()) > 0 ? await card.getAttribute("data-card") : "(닫힘)"}`);
    } catch {
      // 견딘다(다음 루프가 다시 누른다) — 대신 **무엇이 멈췄는지** 남긴다.
      trace.push(`#${i + 1} ${before} → 진행 없음(3s 타임아웃, StrictMode 로 클릭이 버려졌을 수 있다)`);
    }
  }
  await expect(
    dialog,
    `카드 스택이 8회 안에 닫히지 않았다. 진행 기록:\n  ${trace.join("\n  ")}`,
  ).toHaveCount(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe("#421 스킵 버튼 · 하프 리포트", () => {
  test("픽스처 신선도 — 골·카드가 없으면 이 스펙은 아무것도 증명하지 못한다", () => {
    expect(GOALS.length, "데모 로그에 골이 있어야 타임라인 카드가 의미를 갖는다").toBeGreaterThanOrEqual(2);
    expect(CARDS.length, "카드 기록도 리포트의 요구(골·카드 타임라인)다").toBeGreaterThanOrEqual(1);
  });

  test("a. 전반 재생 중 스킵 버튼이 무대에 있다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    const skip = page.getByTestId("match-skip");
    await expect(skip).toBeVisible();
    await expect(skip).toHaveAttribute("data-phase", "FIRST_HALF");
    // 유저 주 액션이다 — 무대 오버레이의 QA 칩 크기(11px)로 줄어들면 폰에서 못 누른다.
    const box = await skip.boundingBox();
    expect(box?.height ?? 0, "터치 타깃 높이").toBeGreaterThanOrEqual(32);

    /*
     * ⚠️ **#216 계약을 내가 깨지 않는다**: 플레이 모드 *재생 컨트롤 바*에는 **QA 재생 조작이 없다**.
     * 스킵은 재생 조작이 아니라 경기 흐름 액션이라 바 **밖**(같은 오버레이 층)에 선다.
     *
     * ⚠️ **범위가 바뀌었다(#406 W9)** — 예전엔 이 자리에서 바 안의 `button` **개수 == 0** 을 쟀다.
     * 그 사이 hero 승인 요구 5-3(과거 전용 시크바)이 **그 바 안에** 유저용 시간바를 넣어(키장면 핀이
     * `<button>` 이다 — 실측 46개) 개수 단언은 *정책이 바뀐 사실*만 알리고 결함은 하나도 못 잡는
     * 지표가 됐다. 그래서 규칙을 "개수" 에서 **"금지 대상이 없다"** 로 옮겼고, 그 규칙은
     * `matchui-controls-mock` 과 **같은 한 곳**(`play-mode-controls.ts`)이 소유한다 — 한쪽만
     * 고치면 다음 사람이 반대로 되돌린다.
     */
    await expectNoQaTransport(page, 1);
  });

  /*
   * ── #456 B1 — *"하이라이트 토글은 비활성화하고 그 자리에 스킵을. 색 톤도 통일."* (hero)
   *
   * ⚠️ **부품을 지우지 않았다.** `HighlightToggle`·`useHighlightSequencer` 는 그대로 있고
   * 무대에서 **그리지 않을** 뿐이다(롤백 자산). 그래서 계약이 두 겹이다 —
   * ①화면에 없다(여기) ②그래서 **하이라이트 모드가 켜질 경로도 없다**
   * (`highlight-sequencer.test.ts` 의 `HIGHLIGHT_DEFAULT_HALVES`). ①만 걸면 토글만 숨기고
   * 디폴트 ON 이 남는 구현이 통과하는데, 그 상태가 정확히 **"끄는 버튼 없이 릴이 도는"**
   * #421 이관 발견이다(유저가 전체 재생으로 돌아갈 방법을 잃는다).
   */
  test("a-2. #456 B1 — 무대에 하이라이트 토글이 없다 (복귀 경로 상실 0)", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await expect(page.getByTestId("match-skip")).toBeVisible();

    await expect(page.getByTestId("highlight-toggle"), "토글 버튼 비노출").toHaveCount(0);
    await expect(page.getByTestId("highlight-mode"), "토글 묶음 자체가 없다").toHaveCount(0);
    // 상태 줄만 남으면 "왜 장면이 건너뛰지"가 되고 끌 방법이 없다 — 같이 사라져야 한다.
    await expect(page.getByTestId("highlight-status"), "진행 상태 줄도 없다").toHaveCount(0);
  });

  test("a-3. #456 B1 — 스킵 버튼 톤이 무대 컨트롤과 통일된다 (단색 강조 알약 아님)", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    const skip = page.getByTestId("match-skip");
    await expect(skip).toBeVisible();

    const tone = await skip.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderTopColor, h: el.getBoundingClientRect().height };
    });
    /*
     * 판정축 = **불투명 단색이 아니다**. accent 색상값을 계약에 적으면 테마 토큰을 바꾸는 순간
     * 거짓 실패가 된다(apps/web CLAUDE.md "초록으로 거짓말하는 방식" #2와 같은 축) — 그래서
     * 값이 아니라 **성질**(알파 < 1 인 어두운 배경)을 재고, 테두리는 배경과 **달라야** 한다.
     */
    const alpha = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(tone.bg);
    expect(
      alpha ? Number(alpha[1]) : 1,
      `배경이 반투명이어야 컨트롤 층과 톤이 맞는다 — 실측 ${tone.bg}`,
    ).toBeLessThan(1);
    expect(tone.border, "테두리는 accent 로 남아 주 액션임을 말한다").not.toBe(tone.bg);
    // #421 원 계약(터치 타깃)은 그대로다 — 톤을 바꾸느라 누를 수 없게 만들지 않는다.
    expect(tone.h, "터치 타깃 높이").toBeGreaterThanOrEqual(32);
  });

  test("b. 누르면 `phase` 를 실어 스킵을 요청하고 리포트가 뜬다", async ({ page }) => {
    const h = await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();

    await expect(page.getByTestId("half-report")).toBeVisible();
    expect(h.skips, "스킵 요청은 정확히 1회").toHaveLength(1);
    expect(h.skips[0], "phase 는 CAS 키다 — 지금 보고 있는 단계를 그대로 보낸다").toEqual({
      phase: "FIRST_HALF",
    });

    // 공지 팝업과 같은 다이얼로그 셸(role/aria) — 접근성을 새로 만들지 않았다는 증거.
    const dialog = page.getByTestId("half-report");
    await expect(dialog).toHaveAttribute("role", "dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    // ⚠️ #456: 첫 장은 **브릿지**다(전환을 먼저 알리고 자세한 것을 뒤에 붙인다). 리포트는 다음 장.
    await expect(page.getByTestId("half-report-title")).toHaveText("전반 종료");
    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("half-report-title")).toHaveText("전반 리포트");
  });

  test("c. 리포트는 골·카드 타임라인이다 — 표기 분·라벨·팀이 붙는다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();
    // #456: 브릿지가 첫 장이라 타임라인은 다음 장이다.
    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("half-report-card")).toHaveAttribute("data-card", "timeline");

    const rows = page.locator('[data-testid="half-report-timeline"] li[data-kind]');
    await expect(rows).toHaveCount(ROW_COUNT);

    const firstGoal = GOALS[0]!;
    const row = page.getByTestId(`half-report-row-${firstGoal.tick}`);
    // 시각은 **로그가 구운 minute** 이다(틱 직독이면 정확히 절반이 나온다, #388).
    await expect(row).toContainText(`${firstGoal.minute}'`);
    await expect(row).toContainText("골!");
    await expect(row).toContainText(firstGoal.team === "home" ? "테스터" : "봇 FC");

    const firstCard = CARDS[0]!;
    await expect(page.getByTestId(`half-report-row-${firstCard.tick}`)).toContainText("옐로카드");

    // 전반 리포트는 앞에 끝난 하프가 없으므로 이 하프의 골이 곧 스코어다.
    await expect(page.getByTestId("half-report-score")).toHaveText(
      `테스터 ${HALF.home} : ${HALF.away} 봇 FC`,
    );
  });

  /**
   * ⚠️ **이 계약은 후반에서만 실효가 있다.** 전반 스킵은 응답이 `HALFTIME` 이라 무대가 어차피
   * 탭으로 내려가고(#244 `managing`), 그래서 전반만 단언하면 **셸의 리포트 가드를 지워도 통과한다**
   * (변이체 검증에서 실제로 살아남았다). 후반 스킵은 `FINISHED` = 무대가 상시인 상태라, 가드가
   * 없으면 팝업 **뒤에서 캔버스가 계속 돈다**. 두 하프를 다 태운다.
   */
  test("d. 리포트 뒤에서 경기 장면이 계속 돌지 않는다(후반 = 무대 상시 상태 포함)", async ({ page }) => {
    await openMatch(page, "SECOND_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();
    // 무대가 아예 마운트돼 있지 않다(정지 플래그가 아니라 구조적 보장 — cleanup 이 v.stop() 을 부른다).
    await expect(page.getByTestId("stage-canvas")).toHaveCount(0);
    await expect(page.locator('[data-testid="viewer-canvas-half2"]')).toHaveCount(0);

    // 다음 장(브릿지)으로 넘어가도 여전히 무대는 없다 — 가드는 **스택 전체**에 걸린다.
    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("stage-canvas")).toHaveCount(0);

    // 닫으면 무대가 돌아온다(가드가 화면을 영구히 뺏지 않는다).
    await closeStack(page);
    await expect(page.getByTestId("stage-canvas")).toBeVisible();
  });

  test("d2. 전반 스킵에서도 리포트 뒤에 캔버스가 없다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();
    await expect(page.locator('[data-testid="viewer-canvas-half1"]')).toHaveCount(0);
  });

  test("e. 브릿지 → 리포트 → **주요 인물** 3장이다(#421-2 ②, W7 평점 플립)", async ({ page }) => {
    /*
     * ⚠️ 이 계약은 **세 번** 옮겨졌다. ①원래 "스택이 **1장**" → #424 가 브릿지를 마지막 카드로 더해
     * 2장(설계 §3.2). ②#403 평점 모듈이 머지되며 `주요 인물` 카드가 **실제로 들어와** 3장이 됐다.
     * ③#456 이 브릿지를 **첫 장**으로 옮겼다(hero: *"경기 브릿지 왜 없어?"* — 마지막에 있으면
     * 클릭 2회 뒤라 유저 기억엔 리포트만 남는다). 장 수와 내용은 그대로고 순서만 바뀐 것이다.
     * 지키려던 것은 그대로다 — **빈 카드가 끼어들지 않는다**. 그래서 장 수만 세지 않고
     * *그 카드가 무엇을 말하는지*(이름·평점)까지 본다. 평점이 비면 `null` 경로로 돌아가 2장이 되고,
     * 그 경로는 `HalfReportModal.test.ts` 가 계속 지킨다.
     */
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();

    await expect(page.getByTestId("half-report-pager")).toHaveText("1 / 3");
    await expect(page.getByTestId("half-report-dots").locator("span")).toHaveCount(3);
    await expect(page.getByTestId("half-report-card")).toHaveAttribute("data-card", "bridge");

    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("half-report-card")).toHaveAttribute("data-card", "timeline");

    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("half-report-card")).toHaveAttribute("data-card", "top-rated");
    await expect(page.getByTestId("half-report-title")).toHaveText("전반 주요 인물");
    // 카드가 **비어 있지 않다** — 이름이 카탈로그에서 붙고 평점이 숫자로 뜬다.
    await expect(page.getByTestId("half-report-motm-name")).toHaveText(/선수\d+/);
    await expect(page.getByTestId("half-report-motm-rating")).toHaveText(/^\d+\.\d$/);
    // 등번호는 경기장 토큰과 같은 규칙(1~11)에서 온다 — id 원문("H3")이 새 나오면 안 된다.
    await expect(page.getByTestId("half-report-motm-num")).toHaveText(/^(?:[1-9]|1[01])$/);
    /*
     * 팀 필터 기본 = **우리 팀**(유저가 자기 팀 서사를 읽는 화면). 목의 유저는 홈이므로 홈 이름이
     * 붙어야 한다 — 필터를 지우는 변이는 상대 팀 최고를 뽑아 여기서 죽는다(데모 로그의 통합
     * MOTM 이 어웨이일 수 있다).
     */
    await expect(page.getByTestId("half-report-motm")).toContainText("테스터");

    /*
     * 주요 인물이 **마지막 장**이다(#456 — 브릿지가 앞으로 갔다). 그래도 끝맺음 버튼은 `닫기` 로
     * 퇴화하지 않는다: 브릿지가 상태에서 파생한 목적지를 `finalCtaLabel` 로 내려 준다.
     * ⚠️ 이 단언이 이 웨이브의 **반쪽 구현 방지선**이다 — 순서만 뒤집고 라벨을 안 내리면 여기서 죽는다.
     */
    await expect(page.getByTestId("half-report-next")).toHaveText("감독시간으로");
  });

  test("f. 닫으면 바로 감독시간 — 기존 [후반 시작] 동선으로 이어진다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await expect(page.getByTestId("half-report")).toBeVisible();
    await closeStack(page);

    await expect(page.getByTestId("resume-button")).toBeVisible();
    // 감독시간에는 스킵할 재생이 없다 — 버튼이 남아 있으면 409 를 부르는 손잡이가 된다.
    await expect(page.getByTestId("match-skip")).toHaveCount(0);
  });

  test("g. 돌려보는 화면(감독시간 `경기장면` 탭)에는 스킵 버튼이 없다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("match-skip").click();
    await closeStack(page);
    await expect(page.getByTestId("resume-button")).toBeVisible();

    await page.getByTestId("stage-tab-stage").click();
    await page.locator('[data-testid="viewer-canvas-half1"]').waitFor({ state: "visible", timeout: 30_000 });
    await expect(page.getByTestId("match-skip")).toHaveCount(0);
  });

  test("h. 후반 스킵 → `SECOND_HALF` phase → 리포트 → 닫으면 결과 화면", async ({ page }) => {
    const h = await openMatch(page, "SECOND_HALF");
    await expect(page.getByTestId("match-skip")).toHaveAttribute("data-phase", "SECOND_HALF");
    await page.getByTestId("match-skip").click();

    await expect(page.getByTestId("half-report")).toBeVisible();
    expect(h.skips[0]).toEqual({ phase: "SECOND_HALF" });
    // #456: 첫 장은 경기 종료 브릿지, 그 다음이 후반 리포트다.
    await expect(page.getByTestId("half-report-title")).toHaveText("경기 종료");
    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("half-report-title")).toHaveText("후반 리포트");
    // 후반 리포트는 전반 확정 스코어 위에 쌓는다(#233) — 후반만의 점수를 경기 점수로 그리지 않는다.
    await expect(page.getByTestId("half-report-score")).toHaveText(
      `테스터 ${HALF.home * 2} : ${HALF.away * 2} 봇 FC`,
    );
    await expect(page.getByTestId("half-report-score")).not.toHaveText(
      `테스터 ${HALF.home} : ${HALF.away} 봇 FC`,
    );

    await closeStack(page);
    await expect(page.getByTestId("result-page")).toBeVisible();
  });

  test("i. 409(이미 넘어갔다)는 에러가 아니다 — 리포트를 열지 않고 상태를 따라간다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF", { skipConflict: true, conflictState: "HALFTIME" });
    await page.getByTestId("match-skip").click();

    // 리포트는 뜨지 않는다(이 요청이 그 하프를 끝낸 게 아니다).
    await expect(page.getByTestId("resume-button")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("half-report")).toHaveCount(0);
    // 화면이 막다른 에러로 끝나지 않는다.
    await expect(page.getByTestId("stage-shell")).toBeVisible();
  });
});
