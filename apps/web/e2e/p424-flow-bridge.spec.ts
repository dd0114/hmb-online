import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #424 W1 — **경기 흐름 브릿지 4지점**을 백엔드 없이 route-mock 으로 박제한다.
 *
 * 설계 SoT = `docs/plan-v5/match-flow-bridge.md`. 이 스펙이 지키는 것(설계 §12.2 + 에픽 요구):
 *  ① **첫 관측 무발화** — 새로고침·`FINISHED` 재입장에 브릿지가 다시 뜨지 않는다.
 *  ② **전이별 발화 1회** — 스킵 응답과 전이 관측 두 소스가 겹쳐도 스택은 하나다.
 *  ③ **내용은 현재 상태 파생** — 감독시간이 만료돼도 카드가 거짓말하지 않는다.
 *  ④ **오토 모드 특수분기 0** — `FIRST_HALF → GEN2` 직행도 같은 브릿지가 받는다.
 *  ⑤ **D6 회귀** — 스킵 응답이 `GEN2` 여서 `StageShell` 이 언마운트돼도 리포트/브릿지가 살아 있다.
 *  ⑥ continuation(#405) 없이도 흐름이 완결된다(`결과 보기` 폴백 = 현행 동작).
 *  ⑦ **대기형은 대기 화면을 가리지 않는다** — 경과 시계·[경기 포기](#217 AC3)가 눌린다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면.
 * ⚠️ `toBeVisible()` 로만 단언하지 않는다 — 주 CTA 는 `elementFromPoint` 로 실제 피격을 잰다(#294·#355 실적).
 */

const MATCH_ID = "m-p424";
const LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
) as { events: { tick: number; minute: number; type: string; team?: string; playerId?: string }[] };

const GOALS = LOG.events.filter((e) => e.type === "goal");
const HALF = {
  home: GOALS.filter((g) => g.team === "home").length,
  away: GOALS.filter((g) => g.team === "away").length,
};

const PLAYERS = [...new Set(LOG.events.map((e) => e.playerId).filter(Boolean))].map((id, i) => ({
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
  /** 서버가 들고 있는 현재 상태 — 테스트가 이 값을 바꾸면 다음 폴링(1초)에 화면이 따라온다. */
  state: string;
  auto: boolean;
  /** 스킵 응답이 돌려줄 상태. 오토·프리페치 완료 여부에 따라 HALFTIME/GEN2/SECOND_HALF/FINISHED. */
  skipTo: string;
  skips: unknown[];
  abandonable: boolean;
}

/** 감독시간 창(3분) — 카운트다운이 실제로 도는지 보려면 시계가 있어야 한다. */
function clockOf(h: Harness) {
  if (h.state !== "HALFTIME") return null;
  const now = Date.now();
  return {
    phase: "HALFTIME",
    kickoffAt: new Date(now - 400_000).toISOString(),
    phaseStartAt: new Date(now - 13_000).toISOString(),
    phaseEndsAt: new Date(now + 167_000).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: 220_000,
    halftimeMs: 180_000,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
  };
}

function detailOf(h: Harness) {
  const finished = h.state === "FINISHED";
  const afterH1 = h.state !== "FIRST_HALF" && h.state !== "BRIEFING" && h.state !== "GEN1";
  return {
    id: MATCH_ID,
    state: h.state,
    auto: h.auto,
    // 전반이 끝나기 전에는 확정 스코어를 내려주지 않는다(스포일러 금지 계약).
    scoreH1Home: afterH1 ? HALF.home : null,
    scoreH1Away: afterH1 ? HALF.away : null,
    scoreHome: finished ? HALF.home * 2 : null,
    scoreAway: finished ? HALF.away * 2 : null,
    result: finished ? "WIN" : null,
    clock: clockOf(h),
    createdAt: "2026-08-03T09:00:00Z",
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
      h.state = h.skipTo;
      return route.fulfill({ json: detailOf(h) });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill({ json: detailOf(h) });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: { matchId: MATCH_ID, result: "WIN", scoreHome: HALF.home * 2, scoreAway: HALF.away * 2, rewardPoints: 500 },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: LOG });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    if (url.pathname === "/api/me/active-match") {
      return route.fulfill({ json: { match: detailOf(h), locked: true, abandonable: h.abandonable } });
    }
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, over: Partial<Harness> = {}): Promise<Harness> {
  const h: Harness = {
    state: "FIRST_HALF",
    auto: false,
    skipTo: "HALFTIME",
    skips: [],
    abandonable: false,
    ...over,
  };
  await mockApi(page, h);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  return h;
}

/** 라이브 하프가 실제로 재생을 시작할 때까지 — 전이 시점을 예측 가능하게 만든다. */
async function waitLive(page: Page, half: 1 | 2) {
  await expect(page.getByTestId("stage-shell")).toBeVisible();
  await page.locator(`[data-testid="viewer-canvas-half${half}"]`).waitFor({ state: "visible", timeout: 30_000 });
}

/** 겹친 층이 CTA 를 덮지 않는지 — 보임(visible)과 눌림(hit)은 다르다. */
async function hitTestId(page: Page, target: Locator): Promise<string | null> {
  const box = await target.boundingBox();
  expect(box, "CTA 가 레이아웃에 존재해야 한다").not.toBeNull();
  return page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return el ? (el.getAttribute("data-testid") ?? el.tagName) : null;
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2],
  );
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe("#424 경기 흐름 브릿지 — 폰", () => {
  test("① 첫 관측에서는 브릿지가 뜨지 않는다(FINISHED 재입장·새로고침)", async ({ page }) => {
    // ⚠️ 이 계약이 죽이는 변이: `prev == null` 가드 제거 → 끝난 경기를 열 때마다 종료 브릿지가 뜬다.
    await openMatch(page, { state: "FINISHED" });
    await expect(page.getByTestId("result-page")).toBeVisible();
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);
    await expect(page.getByTestId("half-report")).toHaveCount(0);

    // 새로고침해도 같다(브릿지는 저장된 플래그가 아니라 전이가 연다).
    await page.reload();
    await expect(page.getByTestId("result-page")).toBeVisible();
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);
  });

  test("①-b 감독시간 매치에 재입장해도 전반 종료 브릿지가 되살아나지 않는다", async ({ page }) => {
    await openMatch(page, { state: "HALFTIME" });
    await expect(page.getByTestId("resume-button")).toBeVisible();
    // 폴링 몇 바퀴를 돌려도 조용하다.
    await page.waitForTimeout(2500);
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);
  });

  test("B2 전반 종료 — 창 만료 전이가 브릿지를 열고 CTA 가 실제로 눌린다", async ({ page }) => {
    const h = await openMatch(page, { state: "FIRST_HALF" });
    await waitLive(page, 1);
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);

    h.state = "HALFTIME"; // 서버 창 만료(스위퍼)
    await expect(page.getByTestId("flow-bridge")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("flow-bridge-title")).toHaveText("전반 종료");
    await expect(page.getByTestId("flow-bridge-text")).toContainText("감독시간");
    // 남은 감독시간을 **표시한다** — 브릿지를 읽는 동안 3분이 흐르므로 손해가 보여야 스스로 닫는다.
    await expect(page.getByTestId("flow-bridge-note")).toContainText("남은 감독시간");
    await expect(page.getByTestId("flow-bridge-note")).toContainText(/\d:\d\d/);
    // 스킵하지 않았으므로 리포트 카드는 없다(스택 1장 = 페이저 없음).
    await expect(page.getByTestId("flow-bridge-pager")).toHaveCount(0);

    const cta = page.getByTestId("flow-bridge-next");
    await expect(cta).toHaveText("감독시간으로");
    expect(await hitTestId(page, cta), "CTA 를 덮는 층이 없어야 한다").toBe("flow-bridge-next");

    await cta.click();
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);
    // 닫으면 **그 순간의 패널**이 그대로 뒤에 있다(브릿지는 서버 상태를 앞지르지 않는다).
    await expect(page.getByTestId("resume-button")).toBeVisible();

    // 폴링이 같은 상태를 계속 돌려줘도 다시 열리지 않는다(소비 이력).
    await page.waitForTimeout(2500);
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);
  });

  test("③ 내용은 현재 상태 파생 — 감독시간이 만료돼도 카드가 거짓말하지 않는다", async ({ page }) => {
    // ⚠️ 변이: 본문을 열림 시점에 문자열로 굳히면 `이제 감독시간입니다`가 만료 뒤에도 남는다.
    const h = await openMatch(page, { state: "FIRST_HALF" });
    await waitLive(page, 1);
    h.state = "HALFTIME";
    await expect(page.getByTestId("flow-bridge-text")).toContainText("감독시간입니다", { timeout: 15_000 });

    // 유저가 안 닫은 채로 감독시간이 만료됐다.
    h.state = "GEN2";
    await expect(page.getByTestId("flow-bridge-text")).toContainText("후반을 준비", { timeout: 15_000 });
    await expect(page.getByTestId("flow-bridge-next")).toHaveText("후반 준비로");
    await expect(page.getByTestId("flow-bridge-note")).toHaveCount(0);

    // 후반이 이미 시작됐다.
    h.state = "SECOND_HALF";
    await expect(page.getByTestId("flow-bridge-text")).toContainText("이미 시작", { timeout: 15_000 });
    await expect(page.getByTestId("flow-bridge-next")).toHaveText("후반 보기");
  });

  test("④ 오토 모드 — FIRST_HALF → GEN2 직행도 같은 브릿지가 한 번만 받는다", async ({ page }) => {
    // ⚠️ 변이: 전이표에서 GEN2/SECOND_HALF 타겟 제거 → 오토 유저는 전반 종료 브릿지를 영영 못 본다.
    const h = await openMatch(page, { state: "FIRST_HALF", auto: true });
    await waitLive(page, 1);

    h.state = "GEN2"; // 오토는 감독시간을 0초로 열고 같은 스윕에서 넘어간다
    await expect(page.getByTestId("flow-bridge")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("flow-bridge-next")).toHaveText("후반 준비로");

    h.state = "SECOND_HALF";
    await expect(page.getByTestId("flow-bridge-next")).toHaveText("후반 보기", { timeout: 15_000 });
    // 두 전이가 지나갔지만 스택은 **하나**다(오토용 특수분기가 없다는 증거).
    await expect(page.getByTestId("flow-bridge")).toHaveCount(1);
  });

  test("⑤ D6 — 스킵 응답이 GEN2 여도 리포트·브릿지가 살아 있다(셸이 언마운트돼도)", async ({ page }) => {
    /*
     * 이 웨이브의 존재 이유 중 하나다. #421 은 리포트를 `StageShell` 에 매달아 뒀는데,
     * 스킵 응답이 `GEN2` 면 `panelForState("GEN2") === "genwait"` 이라 셸이 통째로 언마운트되며
     * 리포트가 같이 사라졌다(에러는 없고 유저만 못 본다). 소유자를 `MatchPage` 로 올려 닫는다.
     */
    const h = await openMatch(page, { state: "FIRST_HALF", auto: true, skipTo: "GEN2" });
    await waitLive(page, 1);
    await page.getByTestId("match-skip").click();

    // 셸은 실제로 사라졌다 = 이 상황이 D6 그 자체다(가짜 재현이 아니다).
    await expect(page.getByTestId("genwait-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("stage-shell")).toHaveCount(0);
    // 그런데 리포트는 살아 있다.
    await expect(page.getByTestId("half-report")).toBeVisible();
    await expect(page.getByTestId("half-report-title")).toHaveText("전반 리포트");
    expect(h.skips).toEqual([{ phase: "FIRST_HALF" }]);

    // 다음 장이 브릿지다 — **하나의 스택, 하나의 닫기**.
    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("half-report-card")).toHaveAttribute("data-card", "bridge");
    await expect(page.getByTestId("half-report-title")).toHaveText("전반 종료");
    await expect(page.getByTestId("flow-bridge-text")).toContainText("후반을 준비");

    await page.getByTestId("half-report-next").click();
    await expect(page.getByTestId("half-report")).toHaveCount(0);
    await expect(page.getByTestId("genwait-panel")).toBeVisible();
  });

  test("② 스킵 응답 + 전이 관측 두 소스가 겹쳐도 스택은 하나다", async ({ page }) => {
    // ⚠️ 변이: 큐 dedupe 제거 → 리포트 스택과 브릿지 스택이 각자 한 번씩 뜬다(두 번 닫아야 한다).
    await openMatch(page, { state: "FIRST_HALF", skipTo: "HALFTIME" });
    await waitLive(page, 1);
    await page.getByTestId("match-skip").click();

    await expect(page.getByTestId("half-report")).toBeVisible();
    // 리포트(1) + 브릿지(1) = 2장. 평점 모듈(#403) 전이라 `주요 인물` 카드는 없다.
    await expect(page.getByTestId("half-report-pager")).toHaveText("1 / 2");
    // 폴링이 몇 바퀴 더 돌아도 다이얼로그는 하나뿐이다.
    await page.waitForTimeout(2500);
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);
  });

  test("⑥ B4 경기 종료 — continuation 없이도 흐름이 완결된다(`결과 보기` 폴백)", async ({ page }) => {
    const h = await openMatch(page, { state: "SECOND_HALF" });
    await waitLive(page, 2);
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);

    h.state = "FINISHED";
    await expect(page.getByTestId("flow-bridge")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("flow-bridge-title")).toHaveText("경기 종료");
    await expect(page.getByTestId("flow-bridge-text")).toContainText("승리");
    await expect(page.getByTestId("flow-bridge-next-hint")).toContainText("보상");
    await expect(page.getByTestId("flow-bridge-score")).toHaveText(
      `테스터 ${HALF.home * 2} : ${HALF.away * 2} 봇 FC`,
    );

    const cta = page.getByTestId("flow-bridge-next");
    // #405 미머지 상태의 라벨 — 이것이 선배포 형태다(C2).
    await expect(cta).toHaveText("결과 보기");
    expect(await hitTestId(page, cta)).toBe("flow-bridge-next");
    await cta.click();
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);
    await expect(page.getByTestId("result-page")).toBeVisible();
  });

  test("B1 대기형 — 스텝퍼가 뜨고 경과 시계·[경기 포기]를 가리지 않는다", async ({ page }) => {
    // ⚠️ 변이: 대기형을 오버레이 큐에 넣으면 이 화면이 딤 뒤로 들어가 [경기 포기]가 안 눌린다(#217 AC3).
    await openMatch(page, { state: "GEN1", abandonable: true });
    await expect(page.getByTestId("genwait-panel")).toBeVisible();
    await expect(page.getByTestId("flow-stepper")).toBeVisible();
    await expect(page.getByTestId("flow-stepper-next")).toHaveText("다음 · 전반 킥오프");
    await expect(page.getByTestId("flow-step-gen1")).toHaveAttribute("data-status", "current");
    await expect(page.getByTestId("flow-step-briefing")).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("flow-step-result")).toHaveAttribute("data-status", "upcoming");

    // 오버레이가 아니다 = 대기 화면의 기능 정보가 그대로 산다.
    await expect(page.getByTestId("flow-bridge")).toHaveCount(0);
    await expect(page.getByTestId("genwait-elapsed")).toBeVisible();
    const abandon = page.getByTestId("genwait-abandon");
    await expect(abandon).toBeVisible();
    expect(await hitTestId(page, abandon), "[경기 포기]가 무엇에도 덮이지 않는다").toBe("genwait-abandon");
  });

  test("B3 대기형 — 후반 준비 스텝 + 오토면 감독시간이 `건너뜀`으로 남는다", async ({ page }) => {
    await openMatch(page, { state: "GEN2", auto: true });
    await expect(page.getByTestId("genwait-panel")).toBeVisible();
    await expect(page.getByTestId("flow-stepper-next")).toHaveText("다음 · 후반 킥오프");
    await expect(page.getByTestId("flow-step-gen2")).toHaveAttribute("data-status", "current");
    // 스텝을 **지우지 않는다** — 개수가 달라지면 유저가 오토/일반 두 화면을 다르게 배운다.
    const halftime = page.getByTestId("flow-step-halftime");
    await expect(halftime).toBeVisible();
    await expect(halftime).toHaveAttribute("data-skipped", "true");
    await expect(halftime).toContainText("건너뜀");
  });

  test("킥오프 비트 — 전반 시작에 뜨고 스스로 사라진다(무대를 덮지 않는다)", async ({ page }) => {
    const h = await openMatch(page, { state: "GEN1" });
    await expect(page.getByTestId("genwait-panel")).toBeVisible();

    h.state = "FIRST_HALF";
    const beat = page.getByTestId("flow-beat");
    await expect(beat).toBeVisible({ timeout: 15_000 });
    await expect(beat).toContainText("전반 시작");
    // 백드롭이 없다 = 뒤 경기 화면이 계속 그려진다(무대가 언마운트되지 않는다).
    await expect(page.getByTestId("stage-shell")).toBeVisible();
    await expect(beat).toHaveCount(0, { timeout: 15_000 });
  });
});

test.describe("#424 경기 흐름 브릿지 — 데스크탑", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("넓은 화면에서도 브릿지 카드가 화면 안에 갇히고 CTA 가 눌린다", async ({ page }) => {
    const h = await openMatch(page, { state: "SECOND_HALF" });
    await waitLive(page, 2);
    h.state = "FINISHED";
    await expect(page.getByTestId("flow-bridge")).toBeVisible({ timeout: 15_000 });

    const box = await page.getByTestId("flow-bridge-card").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y, "카드 위쪽이 화면 밖으로 나가지 않는다").toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, "카드 아래쪽이 화면 밖으로 나가지 않는다").toBeLessThanOrEqual(800);

    expect(await hitTestId(page, page.getByTestId("flow-bridge-next"))).toBe("flow-bridge-next");
  });
});
