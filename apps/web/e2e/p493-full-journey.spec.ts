import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mockAppConfig } from "./app-config-mock";
import { revealAllAndSettle } from "./gacha-reveal-settle";
import { skipSplash } from "./splash-mock";

/**
 * #493 W4 AC10 — 신규 유저 풀 플로우 (route-mock · 390×844 · **실터치 탭**).
 *
 * 가입 → 스타터 → **미니게임(/welcome) 끝까지** → 온보딩 코치마크 완주(완료 저장 1회 = 보상①)
 * → 화면 가이드(/game) → 덱 저장(보상③) → 뽑기(보상④) → 트레이드 등록(보상⑤)
 * → **우편함에서 4통 확인·수령(잔액 반영)**. 보상②(첫 경기 결과 열람)는 경기 결과 화면
 * 시나리오가 따로 태운다(테스트 B — 봉투 ack → 우편 ②).
 *
 * 목은 **서버 형상 그대로**다(#342 규율): 우편 제목·GEM 300 = `UxActionRewardService` 캠페인,
 * 지급 규칙(행동 → 1통, 반복 무증가)은 목 상태기계가 서버와 같은 축(액션당 1회)으로 재현한다.
 * 서버 실물의 같은 계약은 `UxActionRewardTest`(1203 스위트)가 이미 문다 — 여기서 보는 것은
 * **web 이 그 여정을 실제로 걷게 하는가**(화면·터치·전이·수령)다.
 */

const PHONE = { width: 390, height: 844 };
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const TITLES: Record<string, string> = {
  TUTORIAL_DONE: "튜토리얼 완주 보상",
  FIRST_RESULT_VIEW: "첫 경기 결과 확인 보상",
  FIRST_DECK_SAVE: "첫 스쿼드 저장 보상",
  FIRST_GACHA: "첫 뽑기 보상",
  FIRST_TRADE: "첫 트레이드 보상",
};

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});
const POSITIONS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW"] as const;
const OWNED = POSITIONS.map((position, i) => ({
  id: `P${i}`, name: `선수${i}`, position, grade: "SILVER", owned: true, ownedCount: 1,
  attributes: attrs(70), personality: "CALM",
}));
const DECK = {
  id: "d1",
  formation: "4-3-3",
  slots: OWNED.map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i, promptText: null })),
};

interface Machine {
  granted: Set<string>;
  mails: { id: string; action: string; claimed: boolean }[];
  gems: number;
  tutorialCompleteCalls: number;
  deckPuts: number;
}

function mailView(m: Machine["mails"][number]) {
  return {
    id: m.id,
    title: TITLES[m.action],
    body: "행동 보상이 도착했습니다. 받아 주세요.",
    attachments: { points: 0, gems: 300, players: [] },
    sentAt: "2026-08-11T00:00:00Z",
    expiresAt: null,
    readAt: m.claimed ? "2026-08-11T01:00:00Z" : null,
    claimedAt: m.claimed ? "2026-08-11T01:00:00Z" : null,
    state: m.claimed ? "CLAIMED" : "UNREAD",
  };
}

async function mockApi(page: Page): Promise<Machine> {
  const st: Machine = { granted: new Set(), mails: [], gems: 6000, tutorialCompleteCalls: 0, deckPuts: 0 };
  const grant = (action: string) => {
    // 서버와 같은 축: 액션당 1회(uq_user_mails_user_campaign). 반복 행동은 no-op.
    if (st.granted.has(action)) return;
    st.granted.add(action);
    st.mails.push({ id: `M-${action}`, action, claimed: false });
  };
  let deckExists = false;

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page);
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({
      user: { id: "u493j", nickname: "여정감독", tutorialDone: st.tutorialCompleteCalls > 0 },
      wallet: { points: 3000, gems: st.gems },
      records: { wins: 0, draws: 0, losses: 0 },
      mail: { unread: st.mails.filter((m) => !m.claimed).length },
    })),
  );
  await page.route((url) => url.pathname === "/api/auth/register", (route) =>
    route.fulfill(json({ token: "tok_j", user: { id: "u493j", nickname: "여정감독" }, isNew: true })),
  );
  await page.route((url) => url.pathname === "/api/me/starter-grant", (route) =>
    route.fulfill(json({ granted: false, player: null })),
  );
  await page.route((url) => url.pathname === "/api/me/tutorial-complete", (route) => {
    st.tutorialCompleteCalls++;
    grant("TUTORIAL_DONE"); // 서버 훅 ① 미러
    deckExists = true;
    return route.fulfill(json({ tutorialDone: true, deckGranted: true, deck: DECK }));
  });
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(OWNED)));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    route.fulfill(json(Object.fromEntries(OWNED.map((p) => [p.id, 0.7])))),
  );
  await page.route((url) => url.pathname === "/api/deck", (route) => {
    if (route.request().method() === "PUT") {
      st.deckPuts++;
      deckExists = true;
      grant("FIRST_DECK_SAVE"); // 서버 훅 ③ 미러
      return route.fulfill(json(DECK));
    }
    return deckExists
      ? route.fulfill(json(DECK))
      : route.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404));
  });
  await page.route((url) => url.pathname === "/api/shop/gacha", (route) => {
    grant("FIRST_GACHA"); // 서버 훅 ④ 미러
    return route.fulfill(json({
      results: [{ player: { id: "P900", name: "새 선수", position: "MF", grade: "SILVER" }, isNew: true }],
      wallet: { points: 3000, gems: st.gems - 300 },
    }));
  });
  await page.route((url) => url.pathname === "/api/trade", (route) =>
    route.fulfill(json({
      wallet: { points: 3000, gems: st.gems },
      slots: [
        { slot: 1, state: "IDLE", offerKind: null, target: null, demand: null, targetGrade: null, speedupCost: null },
      ],
    })),
  );
  await page.route((url) => url.pathname === "/api/trade/1/start", (route) => {
    grant("FIRST_TRADE"); // 서버 훅 ⑤ 미러
    return route.fulfill(json({
      slot: { slot: 1, state: "WAITING", offerKind: "FA", target: null, demand: null, targetGrade: "GOLD", opensAt: "2026-08-12T00:00:00Z", remainingSec: 3600, speedupCost: 300 },
      wallet: { points: 3000, gems: st.gems },
    }));
  });
  await page.route((url) => url.pathname === "/api/mails", (route) =>
    route.fulfill(json({ mails: st.mails.map(mailView), unread: st.mails.filter((m) => !m.claimed).length })),
  );
  await page.route((url) => /^\/api\/mails\/[^/]+\/claim$/.test(url.pathname), (route) => {
    const id = route.request().url().split("/api/mails/")[1]!.split("/")[0]!;
    const mail = st.mails.find((m) => m.id === id);
    if (mail && !mail.claimed) {
      mail.claimed = true;
      st.gems += 300;
    }
    return route.fulfill(json({ applied: true, wallet: { points: 3000, gems: st.gems } }));
  });
  return st;
}

/** 코치마크 오버레이가 떠 있으면 건너뛴다(가이드가 다음 탭을 가리지 않게). */
async function skipGuideIfShown(page: Page) {
  const skip = page.getByTestId("tutorial-skip");
  if (await skip.count()) await skip.tap();
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
}

test.use({ viewport: PHONE, hasTouch: true });

test("A. 가입 → 미니게임 → 온보딩 완주 → 행동 ①③④⑤ → 우편 수령·잔액 반영 (실터치)", async ({ page }) => {
  // 뷰포트·터치 자기전제(#386 교훈 — 조용히 데스크탑으로 돌면 전부 초록이 된다).
  expect(page.viewportSize()).toEqual(PHONE);
  const st = await mockApi(page);
  await skipSplash(page);

  // ── 가입 → 스타터 안내 ──────────────────────────────────────────────────
  await page.goto("/login");
  await page.getByTestId("provider-local").tap();
  await page.getByTestId("local-mode-toggle").tap();
  await page.getByTestId("local-nickname").fill("journey493");
  await page.getByTestId("local-password").fill("sup3rs3cret");
  await page.getByTestId("local-submit").tap();
  await page.getByTestId("starter-reveal-close").tap();

  // ── 미니게임: 재생 확인 → 끝까지(시크 압축) → CTA ───────────────────────────
  await expect(page).toHaveURL(/\/welcome$/);
  await page.waitForFunction(() => {
    const v = (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer;
    return Boolean(v?.ready?.());
  });
  await page.evaluate(() => {
    const v = (window as unknown as { __viewer?: { seek?: (t: number) => void; play?: () => void } }).__viewer!;
    v.seek!(340);
    v.play!();
  });
  await expect(page.getByTestId("minigame-end")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("minigame-cta").tap();

  // ── 온보딩 코치마크 완주(홈 스텝 전부 [다음]) → 완료 저장 1회 = 보상① ─────────
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  for (let i = 0; i < 12 && (await page.getByTestId("tutorial-overlay").count()) > 0; i++) {
    await page.getByTestId("tutorial-next").tap();
  }
  await expect(page.getByTestId("tutorial-overlay")).toHaveCount(0);
  await expect.poll(() => st.tutorialCompleteCalls, { timeout: 5000 }).toBe(1);
  expect(st.granted.has("TUTORIAL_DONE")).toBe(true);

  // ── 화면 가이드가 실제로 발화한다(/game 첫 진입) ───────────────────────────
  await page.goto("/game");
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await expect(page.getByTestId("tutorial-progress")).toContainText("1 / 3");
  await skipGuideIfShown(page);

  // ── 행동 ③ 첫 덱 저장 ────────────────────────────────────────────────────
  await page.goto("/deck");
  await skipGuideIfShown(page); // /deck 은 가이드 밖이지만 방어적으로
  await page.getByTestId("save-deck").tap();
  await expect.poll(() => st.deckPuts, { timeout: 5000 }).toBe(1);
  expect(st.granted.has("FIRST_DECK_SAVE")).toBe(true);

  // ── 행동 ④ 첫 뽑기 ──────────────────────────────────────────────────────
  await page.goto("/recruit");
  await skipGuideIfShown(page);
  await page.getByTestId("gacha-single").tap();
  await revealAllAndSettle(page);
  await page.getByTestId("gacha-close").tap(); // 결과 오버레이를 닫아야 탭이 눌린다
  expect(st.granted.has("FIRST_GACHA")).toBe(true);

  // ── 행동 ⑤ 첫 트레이드 등록 ──────────────────────────────────────────────
  await page.getByTestId("recruit-tab-trade").tap();
  await page.getByTestId("trade-slot-1-start").tap();
  await expect.poll(() => st.granted.has("FIRST_TRADE"), { timeout: 5000 }).toBe(true);

  // ── 우편함: 4통 도착 → 수령 → 잔액 반영 ────────────────────────────────────
  await page.goto("/home");
  await page.getByTestId("mail-center-open").tap();
  for (const action of ["TUTORIAL_DONE", "FIRST_DECK_SAVE", "FIRST_GACHA", "FIRST_TRADE"]) {
    await expect(page.getByText(TITLES[action]!)).toBeVisible();
  }
  await page.getByText(TITLES.TUTORIAL_DONE!).tap();
  await page.getByTestId("mail-claim").first().tap();
  await expect.poll(() => st.gems, { timeout: 5000 }).toBe(6300);

  mkdirSync(new URL("../.smoke/", import.meta.url).pathname, { recursive: true });
  await page.screenshot({ path: new URL("../.smoke/p493-journey-mailbox.png", import.meta.url).pathname });
});

test("B. 첫 경기 결과 열람(봉투 ack) → 보상② 우편", async ({ page }) => {
  const st = await mockApi(page);
  const acks: string[] = [];
  const MATCH_ID = "M493r";
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) =>
    route.fulfill(json({
      id: MATCH_ID, state: "FINISHED",
      opponent: { name: "붉은늑대 FC", analysisText: "", deck: [] },
      scoreHome: 2, scoreAway: 1, result: "WIN", createdAt: "2026-08-11T00:00:00Z",
    })),
  );
  await page.route((url) => new RegExp(`/api/matches/${MATCH_ID}/halves/[12]/log$`).test(url.pathname), (route) =>
    route.fulfill(json({ events: [] })),
  );
  let acked = false;
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}/result`, (route) =>
    route.fulfill(json({
      matchId: MATCH_ID, scoreHome: 2, scoreAway: 1, result: "WIN", pointsAwarded: 1200,
      rewardBundle: {
        bundleId: "B493", source: "MATCH", sourceRef: MATCH_ID,
        acknowledgedAt: acked ? "2026-08-11T01:00:00Z" : null,
        sections: [{ kind: "CURRENCY", entries: [{ code: "POINT", amount: 1200 }] }],
      },
    })),
  );
  await page.route((url) => /^\/api\/rewards\/[^/]+\/ack$/.test(url.pathname), (route) => {
    acked = true;
    acks.push(route.request().url().split("/api/rewards/")[1]!.split("/")[0]!);
    // 서버 훅 ② 미러: 첫 ack 전이 시점에 행동 보상 우편이 생긴다.
    st.mails.push({ id: "M-FIRST_RESULT_VIEW", action: "FIRST_RESULT_VIEW", claimed: false });
    st.granted.add("FIRST_RESULT_VIEW");
    return route.fulfill(json({
      bundleId: "B493", source: "MATCH", sourceRef: MATCH_ID,
      acknowledgedAt: "2026-08-11T01:00:00Z",
      sections: [{ kind: "CURRENCY", entries: [{ code: "POINT", amount: 1200 }] }],
    }));
  });
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_j"));
  await skipSplash(page);

  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("reward-sheet")).toBeVisible();
  await page.getByTestId("reward-confirm").tap();
  await expect(page.getByTestId("result-page")).toBeVisible();
  expect(acks).toEqual(["B493"]);

  // 보상② 우편이 우편함에 있다 → 수령 → 잔액 반영.
  await page.goto("/home");
  await page.getByTestId("mail-center-open").tap();
  await expect(page.getByText(TITLES.FIRST_RESULT_VIEW!)).toBeVisible();
  await page.getByText(TITLES.FIRST_RESULT_VIEW!).tap(); // 항목을 펼쳐야 [받기]가 보인다
  await page.getByTestId("mail-claim").first().tap();
  await expect.poll(() => st.gems, { timeout: 5000 }).toBe(6300);
});
