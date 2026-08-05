/**
 * 라이브 링크 제출 전 리허설 (#444).
 *
 *   node apps/web/scripts/verify-live.mjs        # 기본 https://hmb-online.pages.dev
 *   HMB_LIVE_BASE=https://... node apps/web/scripts/verify-live.mjs
 *
 * **왜 있나**: `infra/status.sh` 가 증명하는 것은 「인프라가 떠 있다」이지
 * 「심사자가 한 판 끝까지 간다」가 아니다. 이 스크립트는 후자를 브라우저로 직접 확인한다 —
 * 게스트 시작 → 덱 → 연습 경기 → ⏩ 스킵 → 결과 → 전적 반영.
 *
 * ⚠️ 목킹·시드·API 지름길을 쓰지 않는다. 리포 e2e 는 덱을 fetch 로 시드하지만 여기서는
 * 화면의 「Auto 배치로 시작」을 실제로 누른다 — 심사자가 밟는 경로 그대로여야 의미가 있다.
 *
 * ⚠️ 라이브 무접촉: **읽기+플레이만** 한다(배포·설정·재기동 0). 게스트 계정 1개가
 * 실서버에 생기는 것은 감수한다 — 그게 심사자가 하는 일 그대로다.
 *
 * ⚠️ AI 생성 지연은 콜드에서 2분까지 간다(실측 6s~125s). 타임아웃이 넉넉한 이유다.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.HMB_LIVE_BASE ?? "https://hmb-online.pages.dev";
// 캡처는 기본적으로 리포 밖으로 — 실수로 커밋되지 않게.
const SHOT = process.env.HMB_SHOT_DIR ?? `${process.env.TMPDIR ?? "/tmp"}/hmb-verify-live`;
await (await import("node:fs/promises")).mkdir(SHOT, { recursive: true });
const nickname = `리허설${Date.now().toString(36).slice(-4)}`;

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const netErrors = [];
page.on("response", (r) => {
  if (r.status() >= 400 && r.url().includes("/api/")) netErrors.push(`${r.status()} ${r.url()}`);
});
page.on("pageerror", (e) => netErrors.push(`pageerror: ${e.message}`));

// 신규 유저에겐 온보딩 코치마크(tutorial-overlay)가 뜬다 — 심사자가 하듯 '건너뛰기'로 넘긴다.
// 여러 화면에서 반복해서 뜨므로 백그라운드로 계속 지켜본다.
let tutorialSkips = 0;
const dismisser = setInterval(async () => {
  try {
    const skip = page.getByTestId("tutorial-skip");
    if (await skip.isVisible({ timeout: 200 })) {
      await skip.click({ timeout: 2000 });
      tutorialSkips += 1;
    }
  } catch {
    /* 오버레이 없음/전환 중 — 무시 */
  }
}, 700);

/**
 * ⏩ 스킵 — 버튼이 나타날 때까지(AI 생성 대기 동안엔 없다) 기다렸다가 누르고,
 * 뒤이어 뜨는 하프 리포트 모달을 닫는다. 심사자가 「1~2분에 한 판」을 보는 경로 그 자체다.
 */
async function skipHalf(label) {
  const btn = page.getByTestId("match-skip");
  try {
    await btn.waitFor({ state: "visible", timeout: 300_000 });
    await btn.click();
    log(`⏩ ${label} 스킵 클릭`);
    await page.waitForTimeout(2500);
    // 하프 리포트는 여러 장(스코어·주요 인물·…)이다 — 모달이 사라질 때까지 '다음'을 넘긴다.
    for (let i = 0; i < 6; i += 1) {
      let clicked = false;
      for (const name of ["다음", "감독시간으로", "결과 보기", "시작하기", "확인", "계속", "닫기"]) {
        const b = page.getByRole("button", { name, exact: true });
        if (await b.isVisible({ timeout: 600 }).catch(() => false)) {
          await b.click().catch(() => {});
          clicked = true;
          break;
        }
      }
      if (!clicked) break;
      await page.waitForTimeout(600);
    }
  } catch {
    log(`⏩ ${label} 스킵 버튼 미노출 — 실시간 재생으로 진행`);
  }
}

let step = "init";
try {
  step = "1. 로그인 화면";
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByTestId("provider-guest").click({ timeout: 30_000 });
  await page.getByPlaceholder("2~16자").fill(nickname);
  await page.getByRole("button", { name: "계속" }).click();
  log(`게스트 로그인 시도: ${nickname}`);

  step = "2. 스타터 팩 → 홈";
  // 스타터 팩 모달은 뜰 때도 안 뜰 때도 있다(이미 지급/타이밍) — 있으면 닫고 홈만 확인한다.
  await page.getByRole("button", { name: "확인" }).click({ timeout: 30_000 }).catch(() => {});
  await page.waitForURL(/\/home$/, { timeout: 60_000 });
  log("홈 진입 (스타터 팩 지급됨)");
  await page.screenshot({ path: `${SHOT}/live-1-home.png` });

  step = "3. 덱 구성 (자동 채움 → 저장)";
  await page.goto(`${BASE}/deck`, { waitUntil: "domcontentloaded" });
  // ⚠️ 데스크탑 폭에서 보이는 것은 `board-empty-auto`(「Auto 배치로 시작」)다.
  // 리포 e2e 가 쓰는 `auto-fill-top` 은 이 폭에서 0x0 — 심사자가 실제로 누르는 버튼으로 간다.
  // 온보딩 오버레이가 클릭을 가로챌 수 있어 11/11 이 될 때까지 다시 누른다.
  let filled = false;
  for (let i = 0; i < 6 && !filled; i += 1) {
    await page.getByTestId("tutorial-skip").click({ timeout: 1000 }).catch(() => {});
    await page.getByTestId("board-empty-auto").click({ timeout: 10_000 }).catch(() => {});
    await page.getByTestId("auto-fill").click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);
    filled = /11\/11/.test((await page.getByTestId("starter-count").textContent()) ?? "");
  }
  if (!filled) throw new Error("선발 11/11 채우기 실패");
  await page.getByTestId("save-deck").click();
  await page.getByTestId("deck-saved-note").waitFor({ timeout: 30_000 });
  log("덱 11/11 저장 완료");
  await page.screenshot({ path: `${SHOT}/live-2-deck.png` });

  step = "4. 연습 경기 진입";
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("home-tile-game").click({ timeout: 30_000 });
  await page.getByTestId("mode-practice").click({ timeout: 30_000 });
  await page.waitForURL(/\/match\//, { timeout: 60_000 });
  log(`매치 생성: ${page.url()}`);

  step = "5. 브리핑 — 프롬프트 입력 → 킥오프";
  await page.getByTestId("briefing-panel").waitFor({ timeout: 60_000 });
  await page.getByTestId("editor-team-prompt").fill("초반부터 강하게 압박하고 측면을 적극적으로 활용해라");
  await page.screenshot({ path: `${SHOT}/live-3-briefing.png` });
  await page.getByTestId("kickoff-button").click();
  log("킥오프 — AI 인풋 생성 대기 시작");

  step = "6. AI 생성 → 전반 → (⏩ 스킵) → 하프타임";
  const tGen = Date.now();
  // README 가 심사자에게 안내하는 경로 그대로 — 재생을 기다리지 않고 ⏩ 스킵으로 하프를 넘긴다.
  await skipHalf("전반");
  await page.getByTestId("halftime-panel").waitFor({ timeout: 420_000 });
  log(`하프타임 도달 (전반 생성+재생 ${((Date.now() - tGen) / 1000).toFixed(1)}s)`);
  await page.getByTestId("h1-score").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOT}/live-4-halftime.png` });

  step = "7. 하프타임 지시 → 후반";
  // 화면에 보이는 것으로 간다(감독의 한마디 탭 → 팀 전체 지시 → [후반 시작]).
  await page.getByTestId("halftime-mode-say").click({ timeout: 8000 }).catch(() => {});
  await page
    .getByTestId("halftime-team-prompt")
    .fill("후반은 점유율 위주로 안정적으로 운영해라", { timeout: 20_000 })
    .catch(async () => {
      await page.getByPlaceholder(/팀 작전/).first().fill("후반은 점유율 위주로 안정적으로 운영해라");
    });
  await page
    .getByRole("button", { name: "후반 시작" })
    .click({ timeout: 20_000 })
    .catch(() => page.getByTestId("resume-button").click({ timeout: 20_000 }));
  log("후반 시작");

  step = "8. (⏩ 스킵) → 결과 화면";
  await skipHalf("후반");
  await page.getByTestId("result-page").waitFor({ timeout: 420_000 });
  await page.getByTestId("final-score").waitFor({ timeout: 20_000 });
  const score = (await page.getByTestId("final-score").textContent())?.trim();
  const badge = (await page.getByTestId("result-badge").textContent())?.trim();
  await page.screenshot({ path: `${SHOT}/live-5-result.png` });
  log(`결과 도달 — score="${score}" badge="${badge}"`);

  step = "9. 로비 복귀 + 전적 반영";
  // 결과 화면 위에 마지막 리포트 카드('보상과 결과 보기')가 남아 있으면 먼저 닫는다.
  for (const name of ["보상과 결과 보기", "다음", "확인", "닫기"]) {
    const b = page.getByRole("button", { name, exact: true });
    if (await b.isVisible({ timeout: 600 }).catch(() => false)) await b.click().catch(() => {});
  }
  await page
    .getByTestId("to-lobby")
    .click({ timeout: 10_000 })
    .catch(() => page.getByText("로비", { exact: false }).first().click({ timeout: 20_000 }));
  await page.waitForURL(/\/home$/, { timeout: 30_000 });
  const record = (await page.getByText(/\d+승 \d+무 \d+패/).first().textContent())?.trim();
  log(`전적: ${record}`);

  console.log(`\n✅ PASS — 라이브 링크로 한 판 완주 (총 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
} catch (e) {
  await page.screenshot({ path: `${SHOT}/live-FAIL.png` }).catch(() => {});
  console.log(`\n❌ FAIL at [${step}] — ${e.message?.split("\n")[0]}`);
  console.log(`   url=${page.url()}`);
  process.exitCode = 1;
} finally {
  clearInterval(dismisser);
  console.log(`   (온보딩 코치마크 건너뛰기 ${tutorialSkips}회)`);
  if (netErrors.length) console.log(`\n⚠️ API 오류/예외 ${netErrors.length}건:\n  ${netErrors.slice(0, 12).join("\n  ")}`);
  await browser.close();
}
