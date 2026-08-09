import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * AC-W1 / Phase 2 연습 플로우 — 신규 닉네임 로그인 → **덱 구성(UI)** → 연습 경기 완주 →
 * 결과 → 전적 반영이 브라우저에서 끝까지 동작함을 검증한다. stub AI(ts-servants) + server-java
 * 가 떠 있을 때만 실행되고, 안 떠 있으면 test.skip 한다(graceful — 통합 게이트에서 orchestrator
 * 가 실제로 돌린다).
 *
 * NOTE(덱 구성 스텝): 11명 슬롯 채움은 브라우저 컨텍스트 fetch(같은 토큰/프록시)로 시드한다 —
 * 슬롯별 D&D 자체 검증은 AC-W2 덱 E2E 범위이고, 여기서는 시드된 덱을 **덱 화면 UI 로 열어
 * 확인·저장**(전술보드 렌더 + 선발 11/11 + 저장 성공 노트)해 "덱 구성" 스텝을 실 UI 로 박제한다.
 * 실제 서버 저장이므로 연습·리그가 요구하는 "활성 덱" 전제는 동일하게 충족된다.
 */

// 기본 데모 8080. 격리 스모크(대체 포트)는 HMB_E2E_API_ORIGIN 로 덮어쓴다(8080 무접촉).
const API_ORIGIN = process.env.HMB_E2E_API_ORIGIN ?? "http://localhost:8080";

async function apiLive(request: APIRequestContext): Promise<boolean> {
  // /internal/health 는 인증 무관 — 어떤 HTTP 응답이라도 오면 서버가 살아있다는 뜻.
  // 연결 자체가 안 되면(ECONNREFUSED) throw → not live.
  try {
    await request.get(`${API_ORIGIN}/internal/health`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** 브라우저 컨텍스트(토큰+프록시)로 owned 선수 11선발+벤치 덱을 저장. GK 를 slot 0 에 둔다. */
async function seedDeck(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const token = localStorage.getItem("hmb.auth.token");
    if (!token) return false;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const players: Array<{ id: string; position: string; owned: boolean }> = await (
      await fetch("/api/players", { headers })
    ).json();
    const owned = players.filter((p) => p.owned);
    const gk = owned.find((p) => p.position === "GK");
    if (!gk || owned.length < 11) return false;
    const ordered = [gk, ...owned.filter((p) => p.id !== gk.id)];
    const starters = ordered.slice(0, 11).map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i }));
    const bench = ordered.slice(11, 18).map((p, i) => ({ playerId: p.id, role: "bench", slotIndex: i }));
    const res = await fetch("/api/deck", {
      method: "PUT",
      headers,
      body: JSON.stringify({ formation: "4-4-2", slots: [...starters, ...bench] }),
    });
    return res.ok;
  });
}

test("AC-W1: login → 덱 구성(UI) → 연습 매치 완주 → 결과 → 전적 반영", async ({ page, request }) => {
  test.skip(!(await apiLive(request)), "server-java/ts-servants 미기동 — 통합 게이트에서 실행");
  test.setTimeout(300_000);

  const nickname = `e2e_${Date.now().toString(36)}`;

  // 1) 신규 로그인(게스트 플로우) → 스타터 팩 모달
  await skipSplash(page);
  await page.goto("/login");
  await page.getByTestId("provider-guest").click();
  await page.getByPlaceholder("2~16자").fill(nickname);
  await page.getByRole("button", { name: "계속" }).click();
  await page.getByRole("button", { name: "확인" }).click(); // 스타터 팩 확인
  await expect(page).toHaveURL(/\/home$/);

  // 2) 덱 시드(fetch, NOTE 참고) → 덱 화면 UI 로 구성 확인·저장
  expect(await seedDeck(page)).toBe(true);
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  await expect(page.getByTestId("tactics-board")).toBeVisible();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();

  // 3) 로비 → 전적 baseline (경기 후 +1 검증용)
  await page.goto("/home");
  const recordBefore = (await page.getByText(/\d+승 \d+무 \d+패/).textContent()) ?? "";

  // 4) 홈 [게임 시작] → 게임 탭 → 연습 경기 → /match/:id  (#286: 모달이 화면으로 승격됐다)
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("mode-practice").click();
  await expect(page).toHaveURL(/\/match\//);

  // 5) BRIEFING — 상대 분석 + 프롬프트 입력 → 킥오프
  await expect(page.getByTestId("briefing-panel")).toBeVisible();
  await expect(page.getByTestId("opponent-analysis")).toBeVisible();
  await page.getByTestId("editor-team-prompt").fill("초반부터 강하게 압박, 측면 활용");
  await page.getByTestId("kickoff-button").click();

  // 6) GEN1 대기 → H1_BREAK (stub servant 가 잡 처리)
  await expect(page.getByTestId("genwait-panel").or(page.getByTestId("halftime-panel"))).toBeVisible();
  await expect(page.getByTestId("halftime-panel")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("h1-score")).toBeVisible();
  await expect(page.getByTestId("match-viewer-half1")).toBeVisible();

  // 7) 하프타임 — 교체 1건 + 추가 프롬프트 → 후반 시작
  // #244 T2: 교체는 select 가 아니라 **하단 탭 + 보드 모드**다. 보드에서 뺄 선수(비-GK 선발)를
  // 누르고 벤치에서 넣을 선수를 누른다. GK 를 빼면 GK_REQUIRED 로 후반 시작이 막힌다.
  await page.getByTestId("halftime-mode-sub").click();
  const outId = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('[data-testid^="board-slot-starter-"]')];
    for (const s of slots) {
      if (s.getAttribute("data-testid") === "board-slot-starter-0") continue; // GK 슬롯 회피
      const tok = s.querySelector('[data-testid^="token-"]');
      if (tok) return tok.getAttribute("data-testid")!.replace("token-", "");
    }
    return "";
  });
  expect(outId, "non-GK 선발 OUT 후보가 있어야 함").not.toBe("");
  await page.getByTestId(`token-${outId}`).click();
  const inId = await page.evaluate(() => {
    const bench = [...document.querySelectorAll('[data-testid^="board-slot-bench-"]')];
    for (const s of bench) {
      const tok = s.querySelector('[data-testid^="token-"]');
      if (tok) return tok.getAttribute("data-testid")!.replace("token-", "");
    }
    return "";
  });
  expect(inId, "벤치 IN 후보가 있어야 함").not.toBe("");
  await page.getByTestId(`token-${inId}`).click();
  await expect(page.getByTestId("sub-chip-0")).toBeVisible();
  await page.getByTestId("halftime-mode-say").click();
  await page.getByTestId("halftime-prompt-team").click().catch(() => {}); // 선수 선택 상태면 팀으로
  await page.getByTestId("halftime-team-prompt").fill("후반은 점유율 위주로 안정적으로");
  await page.getByTestId("resume-button").click();

  // 8) GEN2 대기 → FINISHED (결과 화면)
  await expect(page.getByTestId("result-page")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("final-score")).toBeVisible();
  await expect(page.getByTestId("result-badge")).toBeVisible();
  await expect(page.getByTestId("team-stats")).toBeVisible();
  await expect(page.getByTestId("match-viewer-half2")).toBeVisible();

  // 9) 로비로 → 전적 반영(승/무/패 합 +1)
  await page.getByTestId("to-lobby").click();
  await expect(page).toHaveURL(/\/home$/);
  const recordAfter = (await page.getByText(/\d+승 \d+무 \d+패/).textContent()) ?? "";
  expect(recordAfter).not.toBe(recordBefore);
  const sum = (s: string) => (s.match(/\d+/g) ?? []).map(Number).reduce((a, b) => a + b, 0);
  expect(sum(recordAfter)).toBe(sum(recordBefore) + 1);
});
