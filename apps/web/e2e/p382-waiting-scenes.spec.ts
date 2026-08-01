import { expect, test, type Page } from "@playwright/test";
import { WAITING_SCENE_LINES, WAITING_SCENE_ROTATE_SEC } from "../src/match/waiting-scenes";

/**
 * #382 — **경기 준비 대기 화면은 축구장 정경을 묘사한다** (E2E-TDD, 전면 목킹).
 *
 * hero 라이브 제보: *"'감독의 지시가 선수들에게 전달되고 있습니다 (보통 10초 안팎, 전술을 크게 바꾼
 * 경우 1~2분)' 경기 준비할 때 문구 이렇게 하지 않기로 했잖아. 축구장 상황을 묘사하는 문구로 바꿔.
 * (…) 기다리기 지루하니까."*
 *
 * 유닛 계약(`waiting-scenes.test.ts` · `GenWaitPanel.test.ts`)은 가짜 타이머로 도는 로직을 본다.
 * 여기서 보는 것은 **실제 브라우저에서 실제 시간이 흘렀을 때** 화면 글자가 바뀌는가다 — 로테이션이
 * 순수함수에만 있고 화면에 배선되지 않아도 유닛은 green 이기 때문이다.
 *
 * ⚠️ 전면 목킹이다(메모리 `web-e2e-live-specs-hit-demo`) — 라우트 글롭은 **오리진 앵커**
 * (`url.pathname` 판정)라야 데모 서버로 새지 않는다.
 */

const PHONE = { width: 390, height: 844 };

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** GEN1(전반 생성 대기) / GEN2(후반 생성 대기) 매치 하나만 있는 최소 목. */
async function openGenWait(page: Page, state: "GEN1" | "GEN2") {
  const match = {
    id: "m382",
    createdAt: "2026-08-01T00:00:00Z",
    state,
    scoreHome: 0,
    scoreAway: 0,
    opponent: { name: "연습 봇", analysisText: "", deck: [] },
  };

  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (r) =>
    r.fulfill(
      json({
        user: { id: "u1", nickname: "테스터", provider: "guest", tutorialDone: true },
        wallet: { points: 1000 },
        records: { played: 0, wins: 0, draws: 0, losses: 0 },
      }),
    ));
  await page.route((url) => url.pathname === "/api/me/active-match", (r) =>
    r.fulfill(json({ match, locked: true, abandonable: false })));
  await page.route((url) => url.pathname === "/api/players", (r) => r.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/matches/m382", (r) => r.fulfill(json(match)));

  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/match/m382");
  await expect(page.getByTestId("genwait-panel")).toBeVisible({ timeout: 30_000 });
}

const sceneText = (page: Page) => page.getByTestId("genwait-scene").innerText();

test.use({ viewport: PHONE });

test("대기 화면 서술이 축구장 정경 문장이다 (시스템 설명이 아니다)", async ({ page }) => {
  await openGenWait(page, "GEN1");

  expect(WAITING_SCENE_LINES).toContain((await sceneText(page)).trim());

  /**
   * ⚠️ 패널 **전체 텍스트**를 본다 — 정경 문장을 새로 넣고 구 안내를 아래 줄에 그대로 남기는
   * "추가만 하고 안 지운" 회귀가 이 화면에서 제일 그럴듯한 실패 모양이다.
   */
  const panel = (await page.getByTestId("genwait-panel").innerText()).replace(/\s+/g, " ");
  for (const banned of [
    "AI 감독",
    "작전 반영",
    "지시가 선수들에게",
    "전달되고",
    "10초",
    "1~2분",
    "70초",
  ]) {
    expect(panel, `시스템 설명이 남아 있다 ← "${banned}"`).not.toContain(banned);
  }
});

test("기다리는 동안 문구가 실제로 갈린다 (한 문장에 굳지 않는다)", async ({ page }) => {
  await openGenWait(page, "GEN1");

  const first = (await sceneText(page)).trim();
  // 회전 주기 + 여유 1초. `toPass` 로 재시도하지 않는다 — "언젠가 바뀐다"가 아니라
  // "한 주기 안에 바뀐다"가 계약이다(주기를 10분으로 늘리는 회귀를 통과시키지 않는다).
  await page.waitForTimeout((WAITING_SCENE_ROTATE_SEC + 1) * 1000);
  const second = (await sceneText(page)).trim();

  expect(second, `문구가 "${first}" 에서 바뀌지 않았다`).not.toBe(first);
  expect(WAITING_SCENE_LINES).toContain(second);
});

test("경과 시계는 그대로 돈다 — 걷어낸 것은 서술이지 기능 정보가 아니다", async ({ page }) => {
  await openGenWait(page, "GEN1");

  await expect(page.getByTestId("genwait-elapsed")).toContainText("경과 0:0");
  await page.waitForTimeout(3_000);
  await expect(page.getByTestId("genwait-elapsed")).toContainText(/경과 0:0[2-9]/);
});

/**
 * #382 MIN-3 (hero 확정) — **같은 대기 상태를 설명하는 다른 화면**도 톤이 같아야 한다.
 *
 * 홈 잠금 카드(`home-lock-note`)는 대기 화면이 아니라 *"멈춘 매치를 포기할까"* 를 판단하는
 * 자리라 구 문구(*"전반 작전을 생성하는 중입니다"*)가 살아남아 있었다. 여기서 보는 것은 두
 * 가지가 **동시에** 성립하는가다 — 시스템 어휘가 없고, 그러면서도 판단 근거(어느 단계·포기 버튼)가
 * 죽지 않았는가.
 */
test("홈 잠금 카드도 시스템 어휘를 쓰지 않는다 — 단, 포기 판단 근거는 살아 있다", async ({ page }) => {
  const match = { id: "m382", createdAt: "2026-08-01T00:00:00Z", state: "GEN1" };
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (r) =>
    r.fulfill(
      json({
        user: { id: "u1", nickname: "테스터", provider: "guest", tutorialDone: true },
        wallet: { points: 1000 },
        records: { played: 0, wins: 0, draws: 0, losses: 0 },
      }),
    ));
  // abandonable=true = 회수 가능한 사고 매치 → 강제 이동 없이 홈에 카드가 뜬다(#217 AC3).
  await page.route((url) => url.pathname === "/api/me/active-match", (r) =>
    r.fulfill(json({ match, locked: true, abandonable: true })));
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/home");

  const note = page.getByTestId("home-lock-note");
  await expect(note).toBeVisible({ timeout: 30_000 });
  const text = await note.innerText();
  for (const banned of ["작전", "생성", "AI", "반영"]) {
    expect(text, `시스템 어휘가 남아 있다: "${text}" ← "${banned}"`).not.toContain(banned);
  }
  // 기능이 죽지 않았다: 어느 단계에서 멈췄는지 + 탈출구(포기 버튼)가 그대로다.
  expect(text, `어느 단계에서 멈췄는지 알 수 없다: "${text}"`).toContain("전반");
  await expect(page.getByTestId("home-abandon")).toBeEnabled();
});

test("후반 대기(GEN2)도 같은 정경 풀을 쓴다 — 한쪽만 낡지 않는다", async ({ page }) => {
  await openGenWait(page, "GEN2");

  expect(await page.getByTestId("genwait-panel").innerText()).toContain("후반");
  expect(WAITING_SCENE_LINES).toContain((await sceneText(page)).trim());
  expect(await page.getByTestId("genwait-panel").innerText()).not.toContain("작전 반영");
});
