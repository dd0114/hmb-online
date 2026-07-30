import { expect, test } from "@playwright/test";
import { mockAll } from "./p286-mocks";

/**
 * #286 **W5** — 내 정보 전적 패널 **계약**(설계 §3.7). 구현 전에 먼저 박았다(E2E-TDD).
 *
 * ⚠️ 서버 `GET /api/me/record` 는 아직 없다(#319 = W4). 그래서 여기서도 **부재가 화면을
 * 깨지 않는 것**이 첫 계약이다 — 없으면 구역이 사라지고 상단 통산 전적 한 줄은 남는다.
 *
 * ⚠️ **승률은 서버 값만 쓴다.** 무승부 취급이 서버 규칙이라 클라가 나누면 조용히 어긋난다.
 */

const json = (body: unknown, status = 200) => ({
  status, contentType: "application/json", body: JSON.stringify(body),
});

const RECORD = {
  overall: { played: 23, wins: 12, draws: 3, losses: 8, winRate: 0.52 },
  byMode: {
    practice: { played: 5, wins: 3, draws: 0, losses: 2 },
    league: { played: 12, wins: 7, draws: 2, losses: 3 },
    away: { played: 6, wins: 2, draws: 1, losses: 3 },
  },
  recentForm: ["WIN", "WIN", "LOSS", "DRAW", "WIN"],
  streak: { current: 2, best: 4 },
};

async function mockRecord(page: import("@playwright/test").Page, body: unknown) {
  await page.route(
    (url) => url.pathname === "/api/me/record",
    (r) => (body === null ? r.fulfill(json({ code: "NOT_FOUND", message: "no" }, 404)) : r.fulfill(json(body))),
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("서버에 전적 API 가 없으면 패널만 사라지고 통산 한 줄은 남는다", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await mockAll(page);
  await mockRecord(page, null);
  await page.goto("/me");
  await page.getByTestId("me-page").waitFor();

  await expect(page.getByTestId("me-record-panel")).toHaveCount(0);
  // 유저가 잃는 것이 없어야 한다 — 원래 있던 통산 전적은 그대로.
  await expect(page.getByTestId("me-record")).toBeVisible();
  expect(errors).toEqual([]);
});

test("200 인데 모양이 아닌 응답도 흰 화면을 만들지 않는다", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await mockAll(page);
  await mockRecord(page, {});
  await page.goto("/me");
  await page.getByTestId("me-page").waitFor();
  await expect(page.getByTestId("me-record-panel")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("모드별 전적·최근 폼·승률 도넛이 서버 값으로 뜬다", async ({ page }) => {
  await mockAll(page);
  await mockRecord(page, RECORD);
  await page.goto("/me");

  await expect(page.getByTestId("me-record-overall")).toContainText("12승 3무 8패");
  await expect(page.getByTestId("me-winrate")).toContainText("52%");
  await expect(page.getByTestId("me-streak")).toContainText("2연승");

  /**
   * ⚠️ **상단 폴백 한 줄은 접힌다** — 안 접으면 "12승 3무 8패"가 화면에 두 번 나온다(MIN-4).
   * 이 단언이 없으면 접기 조건(`!panelShowsOverall`)을 지워도 **전 스위트가 통과한다**
   * (독립검증 2R minor-2 = 변이 8 생존). 위 `toContainText` 가 앵커라 공허하지 않다.
   */
  await expect(page.getByTestId("me-record")).toHaveCount(0);

  // 모드 순서 = 리그 · 원정 · 연습 (연습이 마지막인 것은 hero Q1 과 같은 뜻이다).
  const rows = page.getByTestId("me-record-modes").locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("리그");
  await expect(rows.nth(2)).toContainText("연습");
  await expect(page.getByTestId("me-mode-away")).toContainText("6");

  // 폼은 색 하나가 아니라 **글자**로도 읽힌다(적록색약 — #262 규율).
  await expect(page.getByTestId("me-form")).toContainText("승");
  await expect(page.getByTestId("me-form")).toContainText("무");
});

test("승률을 서버가 주지 않으면 도넛을 그리지 않는다 — 클라가 나누지 않는다", async ({ page }) => {
  /**
   * ⚠️ 무승부를 0.5승으로 치는지 제외하는지는 **서버 규칙**이다. 여기서 wins/played 로 나누면
   * 화면이 서버와 다른 승률을 말한다(#262 BL-1 과 같은 부류).
   */
  await mockAll(page);
  await mockRecord(page, { ...RECORD, overall: { ...RECORD.overall, winRate: undefined } });
  await page.goto("/me");

  await expect(page.getByTestId("me-record-panel")).toBeVisible();
  await expect(page.getByTestId("me-winrate")).toHaveCount(0);
  // 나머지는 그대로 — 도넛 하나가 없다고 패널이 사라지지 않는다.
  await expect(page.getByTestId("me-record-modes")).toBeVisible();
});

test("한 판도 안 한 모드는 줄을 만들지 않는다", async ({ page }) => {
  // 0승0무0패 세 줄은 정보가 아니라 소음이다.
  await mockAll(page);
  await mockRecord(page, {
    ...RECORD,
    byMode: { league: { played: 12, wins: 7, draws: 2, losses: 3 }, away: { played: 0, wins: 0, draws: 0, losses: 0 } },
  });
  await page.goto("/me");

  await expect(page.getByTestId("me-record-modes").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("me-mode-away")).toHaveCount(0);
});

test("통산 없이 최근 폼만 오는 부분 응답에서도 통산 전적이 화면에 남는다", async ({ page }) => {
  /**
   * ⚠️ **접기 신호는 "패널이 보이나"가 아니라 "패널이 통산을 말하나"다.**
   * `overall` 없이 `recentForm` 만 오면 패널은 뜨지만(`usable`) 통산은 없다 — 그때 상단 폴백까지
   * 접히면 통산 전적이 **화면에서 통째로 사라진다**(독립검증 2R minor-3, 실측 0회).
   * 이 앱은 스스로 "응답 형태를 믿지 않는다"(#245·#251 전례)를 전제로 만들었으므로, 부분 응답은
   * 예외 상황이 아니라 **예상된 입력**이다.
   */
  await mockAll(page);
  await mockRecord(page, { recentForm: ["WIN", "LOSS", "DRAW"] });
  await page.goto("/me");

  // 패널은 뜬다 — 폼은 보여줄 게 있다.
  await expect(page.getByTestId("me-form")).toBeVisible();
  await expect(page.getByTestId("me-record-overall")).toHaveCount(0);
  // 그러니 상단 폴백이 통산을 계속 말해야 한다.
  await expect(page.getByTestId("me-record")).toBeVisible();
  await expect(page.getByTestId("me-record")).toContainText("12승 3무 8패");
});

test("도넛 호가 승률 비율을 실제로 반영한다", async ({ page }) => {
  // 숫자만 맞고 호가 고정이면 그림이 거짓말을 한다.
  await mockAll(page);
  await mockRecord(page, RECORD);
  await page.goto("/me");

  const dash = await page.getByTestId("me-winrate-arc").getAttribute("stroke-dasharray");
  const [filled, rest] = (dash ?? "").split(" ").map(Number);
  const circumference = filled + rest;
  expect(filled / circumference, `호가 0.52 를 반영해야 한다 (실제=${filled}/${circumference})`).toBeCloseTo(0.52, 3);
});
