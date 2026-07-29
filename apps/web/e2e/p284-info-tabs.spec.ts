import { expect, test, type Page, type Request } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #284 — 정보 탭 상시 표시 + 후반 지시 미리작성(팀 + 선수별) 계약.
 *
 * hero 제보(캡처 `issue1.png`) 두 건:
 *   ① 정보 영역이 토글이라 눌러야 열리고, 켠 게 2개 이상이면 **똑같이 생긴 줄이 두 개**가 된다.
 *   ② 후반 지시 미리작성이 팀 텍스트 하나뿐이고, 적어둔 게 감독시간 화면에 **안 남는다**.
 *
 * W1 게이트에서 hero 가 확정한 것(이슈 #284 코멘트):
 *   ① 토글바 제거 · 탭은 **상태**가 정한다 · 기본 탭 = 로그
 *   ② 대상 칩 + 프롬프트 칸(덱 에디터 통짜 아님)
 *   ③ **저장 버튼 없이 자동 저장**(hero 의 "만료 시 저장" 안은 기각 — 만료는 서버 이벤트라
 *      탭이 닫혀 있으면 저장할 주체가 없다. 근거는 이슈 코멘트)
 *   ④ 감독시간에서 `후반 지시` 탭 제거(감독 탭이 같은 입력을 프리필된 채로 갖는다)
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지
 * 잡아 흰 화면이 된다(프로젝트 기지식 — web-visual-qa-mock-harness).
 */

const CAP_DIR = new URL("../.stage/", import.meta.url).pathname;
const MATCH_ID = "m-284";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);
const PHONE = { width: 390, height: 844 };

const STARTERS = Array.from({ length: 11 }, (_, i) => ({ slotIndex: i, playerId: `p${i + 1}` }));
const BENCH = Array.from({ length: 5 }, (_, i) => ({ slotIndex: i, playerId: `b${i + 1}` }));
const SNAPSHOT = {
  formation: "4-3-3",
  starters: STARTERS,
  bench: BENCH,
  teamTactics: { line: 0.5, press: 0.5, tempo: 0.5, width: 0.5 },
};
const DECK = {
  formation: "4-3-3",
  slots: [
    ...STARTERS.map((s) => ({ ...s, role: "starter" as const })),
    ...BENCH.map((s) => ({ ...s, role: "bench" as const })),
  ],
};
const PLAYERS = [
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `선수${i + 1}`,
    position: i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW",
    grade: "SILVER",
    owned: true,
    ownedCount: 1,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `b${i + 1}`,
    name: `벤치${i + 1}`,
    position: i === 0 ? "GK" : "MF",
    grade: "BRONZE",
    owned: true,
    ownedCount: 1,
  })),
];

interface PromptPost {
  phase: string;
  scope: string;
  playerId?: string | null;
  text: string;
}

/** 서버로 나간 프롬프트 저장 — 자동 저장이 "실제로 갔는가"를 재는 유일한 증거다. */
function promptRecorder(page: Page): PromptPost[] {
  const seen: PromptPost[] = [];
  page.on("request", (req: Request) => {
    if (req.method() !== "POST") return;
    if (!new URL(req.url()).pathname.endsWith("/prompts")) return;
    try {
      seen.push(JSON.parse(req.postData() ?? "{}") as PromptPost);
    } catch {
      /* 바디가 없는 요청은 계약 밖 */
    }
  });
  return seen;
}

async function mockApi(page: Page, state: string) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          scoreH1Home: 1,
          scoreH1Away: 1,
          createdAt: "2026-07-29T09:00:00Z",
          opponent: { name: "봇 FC" },
          userDeckSnapshot: SNAPSHOT,
          clock: null,
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) {
      return route.fulfill({ json: MATCH_LOG });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, state: string) {
  await mockApi(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
}

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

/** 시트에 실제로 그려진 탭 라벨 — 순서까지 계약이다. */
function tabLabels(page: Page) {
  return page.getByRole("tablist", { name: "정보 패널" }).getByRole("tab").allTextContents();
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test.use({ viewport: PHONE });

test.describe("① 토글 제거 — 정보 영역은 처음부터 열려 있다", () => {
  test("a. 토글바가 통째로 없다 — 같은 줄이 두 개이던 원인", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    // 캡처 하단 빨간 박스의 정체. 되살리면 이 계약이 잡는다.
    await expect(page.getByTestId("stage-toggle-stats")).toHaveCount(0);
    await expect(page.getByTestId("stage-toggle-log")).toHaveCount(0);
    await expect(page.getByTestId("stage-toggle-brief")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "정보 토글" })).toHaveCount(0);
  });

  test("b. 아무것도 안 눌러도 시트·탭바가 이미 있다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await expect(page.getByTestId("stage-sheet")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "정보 패널" })).toBeVisible();
    await page.screenshot({ path: `${CAP_DIR}p284-first-half-default.png` });
  });

  test("c. 전반 = 통계·로그·후반 지시 / 기본으로 열린 건 **로그**", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    expect(await tabLabels(page)).toEqual(["통계", "로그", "후반 지시"]);
    // 표시 순서의 첫 탭(통계)이 아니다 — 둘은 다른 축이다(hero 확정).
    await expect(page.getByTestId("stage-panel-log")).toBeVisible();
    await expect(page.getByTestId("stage-tab-log")).toHaveAttribute("aria-selected", "true");
  });

  test("d. 무대는 어떤 탭에서도 남는다 (#169 AC-W1-1 유지)", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    for (const key of ["stats", "log", "brief"]) {
      await page.getByTestId(`stage-tab-${key}`).click();
      await expect(page.getByTestId("stage-canvas"), `${key} 탭에서도 무대가 있어야 한다`).toBeVisible();
    }
  });

  test("e. 390px 세로/가로 스크롤 0 — 모든 탭에서", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    for (const key of ["stats", "log", "brief"]) {
      await page.getByTestId(`stage-tab-${key}`).click();
      const s = await pageScroll(page);
      expect(s.vScroll, `${key} 탭에서 문서 세로 스크롤 0(스크롤은 패널 안에만)`).toBeLessThanOrEqual(1);
      expect(s.hScroll, `${key} 탭에서 가로 오버플로 0`).toBeLessThanOrEqual(1);
    }
  });

  /**
   * ⚠️ **문서 스크롤 0 으로는 이걸 못 잡는다.** 셸이 `overflow:hidden` 이라 시트가 뷰포트보다
   * 넓어져도 문서는 여전히 스크롤 0 이다 — 실화면 캡처에서 발견했다(후반 지시 탭에서 대상 칩 줄이
   * 시트를 가로로 밀어내 **탭바가 화면 밖으로 나가고**, 프롬프트 아래가 잘렸다).
   * 그래서 **시트 자체의 폭**을 잰다.
   */
  test("g. 시트가 뷰포트보다 넓어지지 않는다 — 대상 칩 줄이 밀어내면 안 된다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    for (const key of ["stats", "log", "brief"]) {
      await page.getByTestId(`stage-tab-${key}`).click();
      const sheet = (await page.getByTestId("stage-sheet").boundingBox())!;
      expect(sheet.width, `${key} 탭에서 시트 폭이 뷰포트를 넘으면 안 됨`).toBeLessThanOrEqual(PHONE.width + 1);
      expect(sheet.x, `${key} 탭에서 시트가 왼쪽으로 밀려나면 안 됨`).toBeGreaterThanOrEqual(-1);

      // 탭바는 항상 화면 안에 있어야 한다(밀려나면 유저가 탭을 못 바꾼다).
      const tabs = (await page.getByRole("tablist", { name: "정보 패널" }).boundingBox())!;
      expect(tabs.x + tabs.width, `${key} 탭에서 탭바가 화면 밖으로 나가면 안 됨`).toBeLessThanOrEqual(PHONE.width + 1);
    }
  });

  test("h. 대상 칩 줄은 **자기 안에서** 가로 스크롤한다(줄바꿈으로 시트를 밀지 않는다)", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();

    const box = await page.getByTestId("brief-targets").evaluate((el) => ({
      client: el.clientWidth,
      scroll: el.scrollWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));
    expect(box.client, "칩 줄은 시트 폭 안에 갇힌다").toBeLessThanOrEqual(PHONE.width + 1);
    expect(box.scroll, "칩 17개는 실제로 넘친다 — 이 스펙이 공허하지 않다는 확인").toBeGreaterThan(box.client);
    expect(box.overflowX, "넘치는 만큼은 자기 안에서 스크롤").toBe("auto");
  });

  test("f. 후반·종료에는 `후반 지시` 탭이 없다 — 내봐야 서버가 409", async ({ page }) => {
    await openMatch(page, "SECOND_HALF");
    expect(await tabLabels(page)).toEqual(["통계", "로그"]);
    await expect(page.getByTestId("stage-tab-brief")).toHaveCount(0);
  });
});

test.describe("② 후반 지시 미리작성 — 팀 + 선수별", () => {
  test("a. 대상 칩에 팀 전체와 **로스터 전원**이 있다 (스냅샷 기준)", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();

    await expect(page.getByTestId("brief-target-team")).toBeVisible();
    // 선발 11 + 벤치 5 — 서버가 playerId 를 매치 스냅샷으로 검증하므로 목록도 스냅샷이어야 한다.
    for (const id of [...STARTERS, ...BENCH].map((s) => s.playerId)) {
      await expect(page.getByTestId(`brief-target-${id}`), `${id} 칩이 있어야 한다`).toHaveCount(1);
    }
  });

  test("b. 칩을 누르면 그 대상의 칸으로 바뀐다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();

    await expect(page.getByTestId("brief-prompt-target")).toContainText("팀 전체");
    await page.getByTestId("brief-target-p7").click();
    await expect(page.getByTestId("brief-prompt-target")).toContainText("선수7");
    // 대상이 바뀌면 칸도 그 대상의 값이다(팀 문장이 새어 들어오면 안 된다).
    await expect(page.getByTestId("brief-team-prompt")).toHaveValue("");
  });

  test("c. **저장 버튼이 없다** — 타이핑만으로 서버에 저장된다 (hero 확정 C)", async ({ page }) => {
    const posts = promptRecorder(page);
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();

    await expect(page.getByTestId("brief-save"), "저장 버튼은 되살리지 않는다").toHaveCount(0);

    await page.getByTestId("brief-team-prompt").fill("후반은 라인 내리고 역습");
    await expect(page.getByTestId("brief-save-status")).toHaveAttribute("data-status", "saved");

    expect(posts.filter((p) => p.scope === "team")).toEqual([
      { phase: "halftime", scope: "team", text: "후반은 라인 내리고 역습" },
    ]);
  });

  test("d. 선수별도 같은 방식으로 저장된다 — playerId 가 실려야 한다", async ({ page }) => {
    const posts = promptRecorder(page);
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();

    await page.getByTestId("brief-target-p9").click();
    await page.getByTestId("brief-team-prompt").fill("과감하게 슛 노려");
    await expect(page.getByTestId("brief-save-status")).toHaveAttribute("data-status", "saved");

    expect(posts.filter((p) => p.scope === "player")).toEqual([
      { phase: "halftime", scope: "player", playerId: "p9", text: "과감하게 슛 노려" },
    ]);
  });

  test("e. 적어둔 대상에 표시가 붙는다 — 어디까지 했는지 보여야 한다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();

    await expect(page.getByTestId("brief-target-p9")).toHaveAttribute("data-written", "false");
    await page.getByTestId("brief-target-p9").click();
    await page.getByTestId("brief-team-prompt").fill("과감하게 슛 노려");
    await expect(page.getByTestId("brief-target-p9")).toHaveAttribute("data-written", "true");
    // 색 하나로만 말하지 않는다(적록색약) — 점에 이름이 있다.
    await expect(page.getByTestId("brief-dot-p9")).toHaveAttribute("aria-label", "적어둠");
    await page.screenshot({ path: `${CAP_DIR}p284-brief-written.png` });
  });

  test("f. 탭을 옮겼다 와도 적은 게 남아 있다", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();
    await page.getByTestId("brief-team-prompt").fill("라인 내려");

    await page.getByTestId("stage-tab-stats").click();
    await page.getByTestId("stage-tab-brief").click();
    await expect(page.getByTestId("brief-team-prompt")).toHaveValue("라인 내려");
  });
});

/**
 * 저장이 **조용해진 대가**(hero 확정 C). 버튼이 없으니 유저는 "눌렀는데 안 됐다"를 볼 기회가 없다 —
 * 실패까지 조용하면 적어둔 게 서버에 있다고 믿은 채 감독시간을 놓친다. 그래서 실패는 반드시 시끄럽다.
 */
test.describe("④ 자동 저장이 실패하면 화면이 말한다", () => {
  /** 프롬프트 저장만 실패시킨다(나머지 API 는 정상 — 화면이 뜨긴 해야 한다). */
  async function failPromptSaves(page: Page, status = 500) {
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/prompts") && route.request().method() === "POST") {
        return route.fulfill({ status, json: { code: "INTERNAL", message: "서버 오류" } });
      }
      return route.fallback();
    });
  }

  test("a. 전반 — 실패가 상태 줄에 남는다(조용히 삼키지 않는다)", async ({ page }) => {
    await openMatch(page, "FIRST_HALF");
    await failPromptSaves(page);
    await page.getByTestId("stage-tab-brief").click();

    await page.getByTestId("brief-team-prompt").fill("후반은 라인 내리고 역습");
    await expect(page.getByTestId("brief-save-status")).toHaveAttribute("data-status", "error");
    await expect(page.getByTestId("brief-error")).toBeVisible();
  });

  test("b. 감독시간 — 여기서도 말한다 (만료되면 조용히 날아가는 자리)", async ({ page }) => {
    await openMatch(page, "HALFTIME");
    await failPromptSaves(page);
    await expect(page.getByTestId("halftime-panel")).toBeVisible();

    await page.getByTestId("editor-team-prompt").fill("후반은 라인 내리고 역습");
    await expect(page.getByTestId("halftime-autosave-error")).toBeVisible();
  });

  test("c. 저장에 실패했으면 **후반이 시작되지 않는다** — 지시 없이 경기가 돌면 안 된다", async ({ page }) => {
    const started: string[] = [];
    page.on("request", (req) => {
      const p = new URL(req.url()).pathname;
      if (req.method() === "POST" && (p.endsWith("/halftime") || p.endsWith("/resume"))) started.push(p);
    });

    await openMatch(page, "HALFTIME");
    await failPromptSaves(page);
    await expect(page.getByTestId("halftime-panel")).toBeVisible();

    await page.getByTestId("editor-team-prompt").fill("후반은 라인 내리고 역습");
    await page.getByTestId("resume-button").click();
    await page.waitForTimeout(500);

    expect(started, "프롬프트 저장이 실패했는데 후반이 시작되면 그 지시는 영영 사라진다").toEqual([]);
  });
});

test.describe("③ 감독시간으로 이어진다 — 다시 타이핑 금지", () => {
  /** 전반에서 미리 적어두고 그 브라우저 상태 그대로 감독시간을 연다. */
  async function prewriteThenHalftime(page: Page) {
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();
    await page.getByTestId("brief-team-prompt").fill("후반은 라인 내리고 역습");
    await page.getByTestId("brief-target-p9").click();
    await page.getByTestId("brief-team-prompt").fill("과감하게 슛 노려");
    await expect(page.getByTestId("brief-save-status")).toHaveAttribute("data-status", "saved");

    // 같은 매치가 감독시간으로 넘어간 상태로 다시 연다(초안은 그 매치에 묶여 있다).
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockApi(page, "HALFTIME");
    await page.goto(`/match/${MATCH_ID}`);
    await expect(page.getByTestId("halftime-panel")).toBeVisible();
  }

  test("a. 팀 문장이 감독 탭에 채워져 있다", async ({ page }) => {
    await prewriteThenHalftime(page);
    await expect(page.getByTestId("editor-team-prompt")).toHaveValue("후반은 라인 내리고 역습");
    await page.screenshot({ path: `${CAP_DIR}p284-halftime-prefill.png` });
  });

  test("b. 선수 문장도 그 선수 칸에 채워져 있다", async ({ page }) => {
    await prewriteThenHalftime(page);
    // 보드에서 그 선수를 열면 레일에 미리 적은 문장이 있어야 한다.
    await page.getByTestId("token-p9").click();
    await expect(page.getByTestId("rail-title")).toContainText("선수9");
    await expect(page.getByTestId("rail-prompt-input")).toHaveValue("과감하게 슛 노려");
  });

  test("c. 감독시간에는 `후반 지시` 탭이 없다 — 같은 문장을 두 칸에서 고치지 않는다", async ({ page }) => {
    await prewriteThenHalftime(page);
    expect(await tabLabels(page)).toEqual(["감독", "경기장면", "통계", "로그"]);
    await expect(page.getByTestId("stage-tab-brief")).toHaveCount(0);
  });

  test("d. [후반 시작] 은 **달라진 것만** 다시 보낸다 — 이미 저장된 12건을 재전송하지 않는다", async ({ page }) => {
    await prewriteThenHalftime(page);
    const posts = promptRecorder(page);

    // 아무것도 안 고치고 바로 시작 → 프롬프트 POST 0건.
    await page.getByTestId("resume-button").click();
    await page.waitForTimeout(300);
    expect(posts, "무변경이면 프롬프트 재전송 0").toEqual([]);
  });

  test("e. 감독시간에서 고친 문장은 나간다", async ({ page }) => {
    await prewriteThenHalftime(page);
    const posts = promptRecorder(page);

    await page.getByTestId("editor-team-prompt").fill("생각이 바뀌었다 — 올라가서 압박");
    await page.getByTestId("resume-button").click();
    await expect
      .poll(() => posts.filter((p) => p.scope === "team").map((p) => p.text))
      .toEqual(["생각이 바뀌었다 — 올라가서 압박"]);
  });
});
