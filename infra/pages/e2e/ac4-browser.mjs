/**
 * AC4 — **사람이 브라우저로 들어오면 앱이 그대로 뜬다** (#299).
 *
 *   node infra/pages/e2e/ac4-browser.mjs <base-url> <notice-id> <out-dir>
 *
 * OG Function 은 UA 를 보지 않고 **모두에게 같은 셸**을 준다. 그 셸이 크롤러용으로 오염되지
 * 않았음을 실브라우저로 확인한다 — 메타를 주입하느라 앱을 깨뜨렸다면 여기서 죽는다.
 *
 * 판정 축 3개:
 *   ① 공유 화면이 **live** 상태로 뜨고 그 공지 제목이 보인다(딥링크 목적지 도달, #298)
 *   ② JS 콘솔 에러 0
 *   ③ 실패 요청 0 (네트워크 실패 + 페이지 오리진의 4xx/5xx)
 *
 * 백엔드는 실제 스텁을 **그대로 탄다**(`/api/notices/{id}` 만 목킹하지 않는다) — `/config.json`
 * 의 apiBase 로 크로스오리진 호출이 실제로 성립하는지까지 봐야 "앱이 뜬다"가 참이 된다.
 * 나머지 API 는 화면 부팅에 필요한 최소치만 목킹한다(로그인·프로필·로비 피드).
 */
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:18877";
const NOTICE_ID = process.argv[3] || "01J5LIVE0000000000000000AB";
const OUT = process.argv[4] || "/tmp/hmb-og-e2e/logs";
mkdirSync(OUT, { recursive: true });

const json = (body, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const failures = [];
const consoleErrors = [];

const browser = await chromium.launch();
// 공유 링크는 카톡·문자에서 열린다 → 폰이 기본 표본이다.
const context = await browser.newContext({ ...devices["iPhone 13"], ignoreHTTPSErrors: true });
const page = await context.newPage();

await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));

// 캐치올 먼저, 구체적인 목을 나중에(Playwright 는 나중 등록이 이긴다).
await page.route(
  (url) => url.pathname.startsWith("/api/"),
  (route) => route.fulfill(json({})),
);
await page.route(
  (url) => url.pathname === "/api/config",
  (route) =>
    route.fulfill(
      json({
        currencies: [
          { code: "POINT", symbol: "G", name: "골드", icon: "●", position: "suffix", separator: " " },
          { code: "GEM", symbol: "Z", name: "다이아", icon: "💎", position: "suffix", separator: " " },
        ],
        shop: {
          gacha: { single: { currency: "GEM", cost: 300 }, ten: { currency: "GEM", cost: 3000 }, tenCount: 11 },
          dice: { normal: { currency: "POINT", cost: 5000 }, cash: { currency: "GEM", cost: 10 } },
          gemTopup: { enabled: false, packs: [] },
        },
        grants: { initialPoints: 3000, initialGems: 6000 },
      }),
    ),
);
await page.route(
  (url) => url.pathname === "/api/me",
  (route) =>
    route.fulfill(
      json({
        user: { id: "u1", nickname: "감독님", tutorialDone: true },
        wallet: { points: 62000, gems: 120 },
        records: { wins: 3, draws: 1, losses: 2 },
      }),
    ),
);
await page.route(
  (url) => url.pathname === "/api/me/active-match",
  (route) => route.fulfill(json({ match: null, locked: false, abandonable: false })),
);
await page.route(
  (url) => url.pathname === "/api/me/away-reports",
  (route) => route.fulfill(json({ reports: [], summary: null, rating: 1200, unseen: 0 })),
);
await page.route(
  (url) => url.pathname === "/api/notices/active",
  (route) => route.fulfill(json({ notices: [] })),
);
// ⚠️ 단건은 **목킹하지 않는다** — config.json → apiBase → 스텁 백엔드 실호출이 이 테스트의 절반이다.
await page.route(
  (url) => url.pathname === `/api/notices/${NOTICE_ID}`,
  (route) => route.continue(),
);

page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => failures.push(`requestfailed ${r.url()} — ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (r.status() >= 400 && r.url().startsWith(BASE)) failures.push(`http ${r.status()} ${r.url()}`);
});

const shareUrl = `${BASE}/share/notice/${NOTICE_ID}`;
await page.goto(shareUrl, { waitUntil: "networkidle" });

let live = false;
let titleSeen = "";
try {
  const card = page.locator('[data-testid="share-notice-page"][data-state="live"]');
  await card.waitFor({ state: "visible", timeout: 15000 });
  live = true;
  titleSeen = (await page.locator('[data-testid="share-notice-page"]').innerText()).slice(0, 200);
} catch (e) {
  titleSeen = `NOT VISIBLE: ${e.message.split("\n")[0]}`;
}

await page.screenshot({ path: `${OUT}/AC4-browser.png`, fullPage: false });

const docTitle = await page.title();
const ogTitle = await page
  .locator('meta[property="og:title"]')
  .getAttribute("content")
  .catch(() => null);

const report = {
  url: shareUrl,
  liveNoticeVisible: live,
  screenText: titleSeen,
  documentTitle: docTitle,
  ogTitleInDom: ogTitle,
  consoleErrors,
  failedRequests: failures,
};
writeFileSync(`${OUT}/AC4-browser.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

await browser.close();

const ok = live && consoleErrors.length === 0 && failures.length === 0;
console.log(ok ? "AC4 BROWSER: PASS" : "AC4 BROWSER: FAIL");
process.exit(ok ? 0 : 1);
