/**
 * #493 W11 — **목 0** 라이브 저니 하네스.
 *
 * 리포의 `apps/web/e2e/p493-*.spec.ts` 는 전면 목킹이라 "서버가 실제로 그렇게 답하나"를 못 본다.
 * 실제로 그 사각에서 S3 투어가 통째로 죽어 있었다(서버는 튜토리얼 매치도 `BRIEFING` 으로 만드는데
 * 목은 `FIRST_HALF` 를 줬다). 이 하네스는 **실서버 + 실 web** 으로 신규 가입부터 걸어 본다.
 *
 * 실행:
 *   1) 서버 — server-java 에서 `SERVER_PORT=8080 ./gradlew bootRun --args='--hmb.db.path=./.data/<새 경로>/hmb.db'`
 *      ⚠️ 기존 `.data/hmb.db` 재사용 금지 — 구 마이그레이션 개번(V42=coupons)이 박혀 Flyway 가 거부한다.
 *   2) web  — apps/web 에서 `npm run dev -- --port 5173 --strictPort`
 *      ⚠️ 포트 5173 고정. 서버 CORS 기본 허용 오리진이 `http://localhost:5173` 뿐이라 다른 포트는 403 이다.
 *   3) `cd apps/web && BASE=http://localhost:5173 node ../../evidence/493/live-journey.mjs`
 *      (playwright 해석 때문에 리포 안에서 실행한다. 스크린샷 = `OUT` 환경변수, 기본 `.smoke/live/`)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:5310";
const OUT = process.env.OUT ?? ".smoke/live";
const NICK = process.env.NICK ?? `live${Date.now().toString().slice(-7)}`;
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log("·", ...a);
let shotN = 0;
const shot = async (page, name) => {
  const p = `${OUT}/${String(++shotN).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: p });
  log("shot", p);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [browser error]", m.text().slice(0, 200)); });
const failures = [];
page.on("response", (r) => {
  if (r.url().includes("/api/") && r.status() >= 400) failures.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
});
await page.addInitScript(() => window.sessionStorage.setItem("hmb.splash.seen", "1"));

const tid = (id) => page.getByTestId(id);
const step = async () => (await tid("onrail-bubble").count()) ? tid("onrail-bubble").first().getAttribute("data-step-id") : null;
const waitStep = async (id, ms = 25000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await step();
    if (s === id) return;
    if (Date.now() - t0 > ms) throw new Error(`step "${id}" 미도달 — 현재 "${s}"`);
    await page.waitForTimeout(300);
  }
};
const tap = async (id, ms = 15000) => { await tid(id).first().waitFor({ state: "visible", timeout: ms }); await tid(id).first().tap(); };

try {
  // ── S0 가입 ─────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await tap("provider-local");
  await tap("local-mode-toggle");
  await tid("local-nickname").fill(NICK);
  await tid("local-password").fill("sup3rs3cret");
  await tap("local-submit");
  log("가입", NICK);
  await page.waitForTimeout(1500);
  await shot(page, "s0-starter");
  if (await tid("starter-reveal-open").count()) { await tap("starter-reveal-open"); await page.waitForTimeout(2500); }
  await shot(page, "s0-starter-open");
  await tap("starter-reveal-close", 20000);

  // 온보딩 코치마크
  for (let i = 0; i < 14 && (await tid("tutorial-overlay").count()) > 0; i++) {
    await tap("tutorial-next", 8000).catch(() => {});
    await page.waitForTimeout(200);
  }
  await shot(page, "s0-home");

  // ── S1 제안 모달 ─────────────────────────────────────────────────────────
  await tap("home-tile-game");
  await tid("practice-tutorial-dialog").waitFor({ timeout: 15000 });
  await shot(page, "s1-offer");
  await tap("practice-tutorial-accept");

  // ── S2 덱셋팅 ────────────────────────────────────────────────────────────
  await waitStep("deck-auto");
  await shot(page, "s2-auto");
  await tid("auto-fill").first().waitFor({ timeout: 15000 });
  const autoEnabled = await tid("auto-fill").first().isEnabled();
  log("AUTO 활성?", autoEnabled);
  await tap("auto-fill");
  await page.waitForTimeout(800);
  await shot(page, "s2-filled");

  // 선수 한 명 → 감독의 한마디
  const s2 = await step();
  log("AUTO 뒤 스텝", s2);
  if (s2 === "deck-player") {
    const hi = tid("onrail-highlight");
    const box = await hi.boundingBox();
    if (box) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    if (await tid("pmenu-say").count()) await tap("pmenu-say");
  }
  await page.waitForTimeout(500);
  log("스텝", await step());
  if (await tid("rail-prompt-input").count()) {
    await tid("rail-prompt-input").first().fill("측면을 넓게 쓰고 과감하게 슛해라");
    await tid("rail-prompt-input").first().blur();
    await page.waitForTimeout(600);
    await shot(page, "s2-prompt");
  }
  await waitStep("deck-save");
  await tap("save-deck"); log("덱 저장");
  await waitStep("deck-done");
  await page.waitForTimeout(1500);
  await shot(page, "s2-saved");
  log("스텝", await step());

  // ── S3 경기 ─────────────────────────────────────────────────────────────
  await waitStep("match-go", 20000).catch(async () => log("match-go 대신", await step()));
  await tap("onrail-next");
  log("경기 시작 → URL", page.url());
  // #493 W11 — 브리핑 한 겹. 무대가 열리기 전에는 투어가 타면 안 된다.
  await waitStep("match-brief");
  await shot(page, "s3-brief");
  await page.waitForTimeout(5000);
  log("브리핑 5초 뒤 스텝(=match-brief 여야 한다):", await step());
  await tap("kickoff-button");
  await waitStep("match-scoreboard", 60000);
  log("킥오프 후 스텝:", await step());
  await page.waitForTimeout(1000);
  await shot(page, "s3-match");
  const skipDisabled = (await tid("match-skip").count()) ? !(await tid("match-skip").first().isEnabled()) : null;
  log("스킵 잠김?", skipDisabled, "스텝", await step());

  // 탭 투어 — 투어 밖으로 나올 때까지
  const TOUR = new Set(["match-scoreboard", "match-pitch", "match-timeline", "match-controls", "match-stats", "match-skip"]);
  for (let i = 0; i < 30; i++) {
    const cur = await step();
    if (cur && !TOUR.has(cur)) break;
    if (await tid("onrail-next").count()) await tid("onrail-next").first().tap().catch(() => {});
    await page.waitForTimeout(400);
  }
  log("투어 종료 — 스텝", await step());
  await shot(page, "s3-tour-end");
  log("스킵 활성?", (await tid("match-skip").count()) ? await tid("match-skip").first().isEnabled() : null);
} catch (e) {
  console.log("!! 중단:", e.message);
  await shot(page, "err");
} finally {
  console.log("\n[4xx/5xx API]", failures.length ? [...new Set(failures)].join(" | ") : "없음");
  console.log("[최종 스텝]", await step().catch(() => "?"), "[URL]", page.url());
  await browser.close();
}
