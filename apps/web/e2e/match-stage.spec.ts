import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * P4-E1 S1 (#169) — 게임화면 "경기장면 고정 메인 + 정보 시트" 계약.
 * 설계 SoT = docs/plan-v5/layout-game-screen.md §2·§3, AC = PRD-v5 AC-W1-1.
 *
 * E2E-TDD: 이 파일이 구현보다 먼저 작성됐다(루트 CLAUDE §2-3). 백엔드 없이 route-mock 으로
 * 실화면 계약을 박제한다.
 *
 * ⚠️ **#284 에서 c·d·f 가 뒤집혔다**(hero 결정). 원래는 정보 패널이 유저 토글이고 기본 off 였는데,
 * 하단 토글바와 시트 탭바가 똑같이 생겨 중복으로 읽혔다 → 토글을 없애고 시트를 상시로 바꿨다.
 * **뒤집히지 않은 것은 a·b·e·g** — 무대가 어떤 화면에서도 살아남고 문서가 스크롤하지 않는다는 것.
 * 그게 이 파일이 원래 지키려던 것이고, 지금도 그대로다.
 *
 * 계약:
 *  a. 모바일(390×844) 페이지 세로 스크롤 0 · 가로 오버플로 0.
 *  b. 데스크탑(1280×800) 동일 + 무대가 뷰포트 안.
 *  c. **정보 시트는 처음부터 열려 있다**(#284 — 구: 3토글 기본 off).
 *     하프타임 감독 패널·종료 결과 패널은 **상태가 소유**해 맨 앞에 오고 기본 선택된다.
 *  d. 탭은 **배타** — 하나를 고르면 그 패널만(#284 — 구: 3토글 독립).
 *  e. 어떤 탭에서도 **무대(경기장면)는 화면에 남는다**(리서치 R2).
 *  f. 리로드해도 그 상태의 탭 구성이 그대로(#284 — 구: 토글 선택 localStorage 유지).
 *
 * 새 동작(상시 탭 · 후반 지시 미리작성 · 감독시간 프리필)의 계약은 `p284-info-tabs.spec.ts`.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지
 * 잡아 흰 화면이 된다(프로젝트 기지식 — web-visual-qa-mock-harness).
 */

const CAP_DIR = new URL("../.stage/", import.meta.url).pathname;
const MATCH_ID = "m-stage";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const DECK = {
  formation: "4-3-3",
  slots: [
    ...Array.from({ length: 11 }, (_, i) => ({
      slotIndex: i,
      playerId: `p${i + 1}`,
      role: "starter" as const,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      slotIndex: i,
      playerId: `b${i + 1}`,
      role: "bench" as const,
    })),
  ],
};
const PLAYERS = [
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `선수${i + 1}`,
    position: i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW",
    grade: "B",
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `b${i + 1}`,
    name: `벤치${i + 1}`,
    position: i === 0 ? "GK" : "MF",
    grade: "C",
  })),
];

async function mockApi(page: Page, state: string) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: { id: "u1", nickname: "테스터", points: 100, wins: 1, draws: 0, losses: 0, isAdmin: false },
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          scoreH1Home: 2,
          scoreH1Away: 1,
          scoreHome: 3,
          scoreAway: 2,
          result: "WIN",
          createdAt: "2026-07-22T09:00:00Z",
          opponent: { name: "봇 FC" },
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) {
      return route.fulfill({ json: MATCH_LOG });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: { result: "WIN", scoreHome: 3, scoreAway: 2, pointsAwarded: 120 },
      });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
}

/**
 * ⚠️ 기본 상태를 **관전(SECOND_HALF)** 으로 연다. 이 파일의 계약(#169 AC-W1-1)은 "관전 화면에서
 * 무대가 고정된다"이고, 감독시간은 #244 에서 **무대를 `경기장면` 탭으로 내렸다**(hero 결정:
 * 그 상태에선 할 일이 전부 패널 안이고, 무대가 세로를 먹으면 감독시간만 덱 화면과 달라진다).
 * 예전엔 편의상 `H1_BREAK` 로 열었는데, 그 상태에서 무대가 탭 뒤로 가면서 이 파일 9건이 한꺼번에
 * red 가 됐다 — 계약이 재려던 것(관전 고정)과 연 상태(감독시간)가 어긋나 있던 것이다.
 * 감독시간의 무대는 아래 "감독시간: 무대는 탭 뒤" 테스트가 따로 잰다.
 */
async function openMatch(page: Page, state = "SECOND_HALF") {
  await mockApi(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
  const managing = state === "HALFTIME" || state === "H1_BREAK";
  if (!managing) await expect(page.getByTestId("stage-canvas")).toBeVisible();
}

/** 페이지(문서) 자체가 스크롤되는지 — 무대 고정의 핵심 지표. */
function pageScroll(page: Page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    const b = document.body;
    return {
      vScroll: Math.max(d.scrollHeight - d.clientHeight, b.scrollHeight - d.clientHeight),
      hScroll: Math.max(d.scrollWidth - d.clientWidth, b.scrollWidth - d.clientWidth),
    };
  });
}

/** 실제로 그려지는 피치 캔버스의 렌더 크기(무대가 살아있는지의 진짜 지표).
 *  S3: iframe 제거 — web 이 코어를 직접 마운트하므로 캔버스는 무대 안 직계 요소다. */
async function pitchCanvasBox(page: Page): Promise<{ width: number; height: number } | null> {
  const canvas = page.locator('[data-testid^="viewer-canvas-half"]');
  await canvas.waitFor({ state: "visible", timeout: 20_000 });
  return canvas.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
}

/**
 * #284: **토글이 사라졌다.** 정보 패널을 껐다 켜는 하단 줄이 있었고(그래서 시트 위 탭바와 함께
 * 똑같이 생긴 줄이 두 개였다), 이제는 시트가 상시고 탭만 고른다. 이 헬퍼는 그 전환의 흔적이다 —
 * 옛 이름(`toggle`)을 남기지 않은 이유는 "켠다"와 "고른다"가 다른 동작이기 때문.
 */
async function pickTab(page: Page, key: "stats" | "log" | "brief" | "stage") {
  await page.getByTestId(`stage-tab-${key}`).click();
}

function selected(page: Page, key: "stats" | "log" | "brief") {
  return page.getByTestId(`stage-tab-${key}`).getAttribute("aria-selected");
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test.describe("AC-W1-1 경기장면 고정 (모바일 390×844)", () => {
  test.use({ viewport: PHONE });

  test("a. 페이지 세로 스크롤 0 · 가로 오버플로 0 — 어떤 탭에서도", async ({ page }) => {
    await openMatch(page);

    const base = await pageScroll(page);
    expect(base.vScroll, "기본 상태에서 문서 세로 스크롤이 있으면 안 됨(무대가 스크롤 밖으로 나감)").toBeLessThanOrEqual(1);
    expect(base.hScroll, "390px 에서 가로 오버플로 0").toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${CAP_DIR}phone-default.png` });

    // 관전(SECOND_HALF)의 정보 탭은 통계·로그 둘이다 — `후반 지시` 는 전반에만(#284, p284 스펙이 잰다).
    for (const key of ["stats", "log"] as const) {
      await pickTab(page, key);
      const s = await pageScroll(page);
      expect(s.vScroll, `${key} 탭에서 문서 스크롤이 생기면 안 됨(스크롤은 패널 내부에만)`).toBeLessThanOrEqual(1);
      expect(s.hScroll, `${key} 탭에서 가로 오버플로 0`).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: `${CAP_DIR}phone-all-panels.png` });
  });

  /**
   * ⚠️ #169 의 "기본은 경기장면만(3토글 off)" 은 **#284 에서 hero 가 뒤집었다** — 토글바와 시트
   * 탭바가 똑같이 생겨 중복으로 읽혔고, "탭 구조면 그 안에서 조정하면 되지 껐다켰다 할 필요가 없다".
   * 그래서 이 자리의 계약은 반대 방향으로 다시 선다: **시트는 처음부터 열려 있다.**
   * 무대가 살아남는지(원래 의도)는 아래 e 가 계속 잰다 — 그건 뒤집히지 않았다.
   */
  test("c. 정보 시트는 처음부터 열려 있다 — 토글은 없다 (#284)", async ({ page }) => {
    await openMatch(page);

    await expect(page.getByTestId("stage-sheet")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "정보 패널" })).toBeVisible();
    for (const key of ["stats", "log", "brief"] as const) {
      await expect(page.getByTestId(`stage-toggle-${key}`), "토글바는 되살리지 않는다").toHaveCount(0);
    }
  });

  test("d. 탭은 배타 — 하나를 고르면 그 패널만 뜬다", async ({ page }) => {
    await openMatch(page);

    await pickTab(page, "stats");
    await expect(page.getByTestId("stage-panel-stats")).toBeVisible();
    await expect(page.getByTestId("stage-panel-log")).toHaveCount(0);
    expect(await selected(page, "log")).toBe("false");

    await pickTab(page, "log");
    await expect(page.getByTestId("stage-panel-log")).toBeVisible();
    await expect(page.getByTestId("stage-panel-stats"), "탭은 하나만 열린다").toHaveCount(0);
    expect(await selected(page, "stats")).toBe("false");
  });

  test("e. 어떤 탭에서도 무대(경기장면)는 화면에 남는다", async ({ page }) => {
    await openMatch(page);

    await pickTab(page, "stats");
    await pickTab(page, "log");

    const box = await page.getByTestId("stage-canvas").boundingBox();
    expect(box, "무대 박스가 존재해야 함").not.toBeNull();
    expect(box!.height, "패널을 다 켜도 무대는 접히면 안 됨").toBeGreaterThan(80);
    expect(box!.y, "무대가 뷰포트 위로 밀려나면 안 됨").toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, "무대가 뷰포트 아래로 넘치면 안 됨").toBeLessThanOrEqual(PHONE.height + 1);

    // 박스만 남고 경기장면이 죽어도 위 단언은 통과한다 → **실제 캔버스**를 재서 계약을 닫는다.
    const canvas = await pitchCanvasBox(page);
    expect(canvas, "iframe 안 경기 캔버스가 실제로 존재해야 함").not.toBeNull();
    expect(canvas!.width, "캔버스가 무대 폭을 채워야 함").toBeGreaterThan(box!.width * 0.9);
    expect(canvas!.height, "캔버스가 납작해지면 안 됨").toBeGreaterThan(80);
  });

  /*
   * ── #456 B0 — 경기바가 경기장을 가린다 ──────────────────────────────────
   *
   * hero: *"바는 경기장 밖으로 빼. 경기 안 가리게 화면 늘려달라 했잖아."*
   *
   * ⚠️ **이 두 계약은 한 쌍으로만 뜻이 있다.** h 만 있으면 컨트롤을 아래로 내리면서 캔버스를
   * 그만큼 줄이는 구현이 통과하고(가린 건 없어졌지만 피치가 작아졌다 = hero 가 거부한 답),
   * i 만 있으면 컨트롤을 다시 피치 위에 얹어도 통과한다. 둘을 같이 걸어야 *"무대 행이 세로를
   * 더 가져간다(시트가 양보한다)"* 만 남는다.
   */
  test("h. #456 B0 — 재생 컨트롤이 피치 **밖**에 선다 (경기장을 가리지 않는다)", async ({ page }) => {
    await openMatch(page);
    const canvas = (await page.locator('[data-testid^="viewer-canvas-half"]').boundingBox())!;
    expect(canvas, "캔버스가 있어야 이 계약이 성립한다").toBeTruthy();

    // 컨트롤 층 = `VisualPlayback` 이 자기 표지를 단 그 층(#406 W10 M-1 과 같은 축).
    const controls = page.locator("[data-p406-controls]");
    await expect(controls, "컨트롤 층은 하나다").toHaveCount(1);
    const cb = (await controls.boundingBox())!;

    expect(
      cb.y,
      "컨트롤 층은 캔버스가 끝난 **뒤**에 시작한다(겹치면 그 띠 아래 피치가 안 보인다)",
    ).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);

    // 무대 행(= `stage-canvas` 박스)이 컨트롤까지 담는다 — 시트 위로 흘러넘치지 않는다.
    const stage = (await page.getByTestId("stage-canvas").boundingBox())!;
    expect(stage.y + stage.height, "무대 행이 컨트롤까지 담는다").toBeGreaterThanOrEqual(
      cb.y + cb.height - 1,
    );
    const sheet = (await page.getByTestId("stage-sheet").boundingBox())!;
    expect(sheet.y, "시트는 컨트롤 아래에서 시작한다").toBeGreaterThanOrEqual(cb.y + cb.height - 1);
  });

  test("i. #456 B0 — 컨트롤을 밖으로 내도 **피치가 줄지 않는다**", async ({ page }) => {
    await openMatch(page);
    const canvas = (await page.locator('[data-testid^="viewer-canvas-half"]').boundingBox())!;

    /*
     * 폰에서 피치 크기를 정하는 것은 **가로**다(세로 상한 58svh 에 한참 못 미친다).
     * 그래서 "안 줄었다"의 정의는 두 축이다 — ①화면 폭을 그대로 쓰고 ②그 폭에서 피치 비율.
     * 절대값(253px)만 걸면 폭이 줄어드는 구현을 못 잡고, 비율만 걸면 통째로 축소해도 통과한다.
     */
    expect(canvas.width, "캔버스가 화면 폭을 그대로 쓴다").toBeGreaterThanOrEqual(PHONE.width - 2);
    const byAspect = (canvas.width * 680) / 1050;
    expect(canvas.height, "그 폭에서 피치 비율만큼의 높이(1050:680)").toBeGreaterThanOrEqual(
      byAspect - 1,
    );
    // 현행 실측 기준선 — 회귀를 절대값으로도 한 번 더 잡는다(#456 B0 착지 시점 252.57px).
    expect(canvas.height, "폰 피치 높이 기준선").toBeGreaterThanOrEqual(252);
  });

  /**
   * #284 로 **저장할 토글이 없어졌다**(탭 구성은 상태가 정한다). 그래서 이 자리의 계약은
   * "선택이 유지되나"가 아니라 **"리로드해도 그 상태의 탭 구성이 그대로 선다"** 로 바뀐다.
   * 감독시간을 쓰는 이유는 그대로다 — 상태 패널이 정보 탭보다 먼저 오는 규칙을 같이 재기 때문.
   */
  test("f. 리로드해도 상태에 맞는 탭 구성이 그대로 — 감독이 먼저", async ({ page }) => {
    await openMatch(page, "HALFTIME");
    await expect(page.getByTestId("halftime-panel")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("stage-shell")).toBeVisible();

    // 하프타임엔 유저가 해야 할 일(교체·후반 시작)이 정보 패널보다 우선이다(stage-state 규칙).
    await expect(page.getByTestId("halftime-panel")).toBeVisible();
    await pickTab(page, "log");
    await expect(page.getByTestId("stage-panel-log")).toBeVisible();
  });

  test("결과 화면(FINISHED)도 무대 + 결과 탭으로 고정된다(기존 testid 보존)", async ({ page }) => {
    await openMatch(page, "FINISHED");

    // 상태가 소유하는 패널 — 토글과 무관하게 자동 표시.
    await expect(page.getByTestId("result-page")).toBeVisible();
    await expect(page.getByTestId("final-score")).toBeVisible();
    await expect(page.getByTestId("result-badge")).toBeVisible();
    await expect(page.getByTestId("team-stats")).toBeVisible();
    await expect(page.getByTestId("to-lobby")).toBeVisible();

    const s = await pageScroll(page);
    expect(s.vScroll, "결과 화면도 문서 스크롤 0").toBeLessThanOrEqual(1);
    expect(s.hScroll).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("stage-canvas")).toBeVisible();
    await page.screenshot({ path: `${CAP_DIR}phone-result.png` });
  });

  // 감독시간 상태명이 **둘**이라(현행 `HALFTIME` / 레거시 `H1_BREAK`) 두 이름 다 태운다.
  // 이 파일이 `H1_BREAK` 하나로만 열려 있던 탓에 #226(감독시간 헤더가 재생 플레이헤드를 따라감)이
  // 계약 밖에서 배포까지 갔다. 상태 소유 패널 규칙을 손대면 여기도 같이 본다.
  for (const state of ["HALFTIME", "H1_BREAK"]) {
    test(`하프타임 감독 패널은 상태 소유 — 정보 탭이 있어도 감독이 먼저 열린다 (${state})`, async ({ page }) => {
      await openMatch(page, state);

      await expect(page.getByTestId("halftime-panel")).toBeVisible();
      await expect(page.getByTestId("h1-score")).toBeVisible();
      await expect(page.getByTestId("resume-button")).toBeVisible();
      // #284: 정보 탭은 이제 상시다. 그래도 **기본 선택은 감독**이다(지금 해야 할 일이 먼저).
      expect(await selected(page, "stats")).toBe("false");
      expect(await selected(page, "log")).toBe("false");
      // 후반 지시 탭은 감독 탭과 같은 입력이라 감독시간엔 없다(#284 ④).
      await expect(page.getByTestId("stage-tab-brief")).toHaveCount(0);
      if (state === "H1_BREAK") await page.screenshot({ path: `${CAP_DIR}phone-halftime.png` });
    });

    /**
     * #244: 감독시간에는 무대가 **상시가 아니라 탭**이다. "무대가 사라졌다"가 아니라
     * "한 번 눌러서 간다"임을 계약으로 박아 둔다 — 안 그러면 다음 변경이 무대를 통째로
     * 잃어버려도 아무도 모른다(이 규칙을 넣을 때 기존 9건이 조용히 red 가 된 전례가 있다).
     */
    test(`감독시간: 무대는 탭 뒤에 있고 한 번 눌러 도달한다 (${state})`, async ({ page }) => {
      await openMatch(page, state);
      await expect(page.getByTestId("stage-canvas"), "감독시간엔 무대가 상시가 아니다").toHaveCount(0);
      await expect(page.getByTestId("stage-tab-stage")).toBeVisible();
      await page.getByTestId("stage-tab-stage").click();
      await expect(page.getByTestId("stage-canvas")).toBeVisible();
      const s = await pageScroll(page);
      expect(s.vScroll, "경기장면 탭에서도 문서 스크롤 0").toBeLessThanOrEqual(1);
      expect(s.hScroll).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("AC-W1-1 경기장면 고정 (데스크탑 1280×800)", () => {
  test.use({ viewport: DESKTOP });

  test("b. 데스크탑도 문서 스크롤 0 + 무대가 뷰포트 안 + **가운데 정렬**(도크 없음)", async ({ page }) => {
    await openMatch(page);

    const base = await pageScroll(page);
    expect(base.vScroll).toBeLessThanOrEqual(1);
    expect(base.hScroll).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${CAP_DIR}desktop-default.png` });

    await pickTab(page, "stats");
    await pickTab(page, "log");
    const s = await pageScroll(page);
    expect(s.vScroll, "패널을 열어도 문서 스크롤 0").toBeLessThanOrEqual(1);
    expect(s.hScroll).toBeLessThanOrEqual(1);

    const box = (await page.getByTestId("stage-canvas").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(DESKTOP.height + 1);
    expect(box.width, "데스크탑에서 무대가 모바일 폭(480)에 갇히면 안 됨").toBeGreaterThan(480);

    // hero 결정(2026-07-22): 데스크탑은 **폰의 넓은 버전**이다 — 우측 도크를 없애고 무대를 가운데 둔다.
    // 도크 시절엔 무대 중심이 왼쪽으로 180px 쏠려 화면이 비대칭이었다. 그 회귀를 여기서 막는다.
    const stageCenter = box.x + box.width / 2;
    expect(Math.abs(stageCenter - DESKTOP.width / 2), "무대가 가로 가운데에 있어야 함(좌 쏠림 금지)").toBeLessThanOrEqual(4);

    // 시트는 무대 **옆**이 아니라 **아래**에 있다(도크 폐기의 실체).
    const sheet = (await page.getByTestId("stage-sheet").boundingBox())!;
    expect(sheet.y, "시트는 무대 아래에서 시작").toBeGreaterThanOrEqual(box.y + box.height - 1);
    expect(sheet.width, "시트는 화면 폭을 쓴다(측면 도크 아님)").toBeGreaterThan(DESKTOP.width * 0.9);

    const canvas = await pitchCanvasBox(page);
    expect(canvas!.width, "데스크탑 캔버스도 무대 폭을 채운다").toBeGreaterThan(480);
    await page.screenshot({ path: `${CAP_DIR}desktop-panels.png` });
  });

  test("g. 로그가 쌓여도 무대 크기가 변하지 않는다(시트 높이는 콘텐츠와 무관)", async ({ page }) => {
    await openMatch(page);
    await pickTab(page, "log");
    await expect(page.getByTestId("stage-panel-log")).toBeVisible();

    const lines = page.locator('[data-testid="stage-panel-log"] li');
    const before = (await page.getByTestId("stage-canvas").boundingBox())!;
    const beforeCount = await lines.count();

    // 재생이 진행되며 로그가 실제로 늘어날 때까지 기다린다(가짜 통과 방지 — 안 늘면 이 테스트는 의미 없다).
    await expect
      .poll(() => lines.count(), { timeout: 30_000, message: "재생 중 로그 라인이 늘어야 한다" })
      .toBeGreaterThan(beforeCount + 2);

    const after = (await page.getByTestId("stage-canvas").boundingBox())!;
    // 시트가 내용만큼 자라면 무대가 그만큼 줄어든다(실제로 그랬다) → 크기 불변을 못박는다.
    expect(after.height, "로그가 늘어도 무대 높이 불변").toBeCloseTo(before.height, 0);
    expect(after.width, "로그가 늘어도 무대 폭 불변").toBeCloseTo(before.width, 0);
    expect(after.y, "무대 위치도 그대로").toBeCloseTo(before.y, 0);

    // 넘치는 로그는 패널 **안에서만** 스크롤된다(문서는 여전히 스크롤 0).
    const panelScroll = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stage-panel-log"]')?.parentElement;
      return el ? { scrollH: el.scrollHeight, clientH: el.clientHeight } : null;
    });
    expect(panelScroll, "로그 패널 스크롤 컨테이너가 있어야 함").not.toBeNull();
    expect((await pageScroll(page)).vScroll).toBeLessThanOrEqual(1);
  });
});
