import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * #323 **라이브 스모크** — 목킹 0, 실제 서버(server-java) + 실제 브라우저.
 *
 * <p>목킹 e2e 는 "화면이 계약대로 그리는가"를 보고, 이건 **발송부터 지갑까지 한 줄로 이어지는가**를
 * 본다: admin 이 보낸다 → 유저 헤더에 뱃지가 뜬다 → 열어 [받기] → **지갑 숫자가 실제로 오른다**.
 * 목이 서버를 흉내내는 한 이 축은 구조적으로 검증되지 않는다.
 *
 * <p>계약이 아니라 <b>증빙</b>이다(`*.capture.ts` 라 판정 게이트에 섞이지 않는다).
 *
 * <p>⚠️ <b>CORS 를 반드시 열어라</b>(`--hmb.cors.allowed-origins=http://localhost:<포트>`). vite dev 의
 * `changeOrigin` 은 Host 만 바꾸고 <b>Origin 은 그대로</b> 보내므로, 기본 허용 목록
 * (`http://localhost:5173`)에 없는 포트로 띄우면 브라우저의 <b>POST 만</b> 403 "Forbidden" 이 된다 —
 * GET 은 통과해서 화면이 멀쩡해 보이고 [받기]만 조용히 실패한다(실제로 이 스모크를 처음 돌렸을 때
 * 그 모양이었다). 서버·클라 버그로 오해하기 쉬운 자리라 적어 둔다.
 *
 * <p><b>실행</b>(격리 스택 — 데모 :8080 무접촉):
 * <pre>
 *   java -jar server-java/build/libs/hmb-server-0.1.0.jar --server.port=18994 \
 *        --hmb.db.path=/tmp/smoke/hmb.db --hmb.admin.nickname=smoke_admin --hmb.admin.password=smoke-pw-1234 \
 *        --hmb.cors.allowed-origins=http://localhost:5340 \
 *        --hmb.data.players-file=../data/players/players.v2.4.json
 *   cd apps/web && CI=1 WEB_E2E_PORT=5340 VITE_API_TARGET=http://localhost:18994 \
 *        npx playwright test --config=playwright.capture.config.ts p323-live-smoke.capture.ts
 * </pre>
 */
const OUT = new URL("../.smoke/", import.meta.url).pathname;
const API = process.env.VITE_API_TARGET ?? "http://localhost:18994";
const ADMIN = { provider: "local", nickname: "smoke_admin", password: "smoke-pw-1234" };
/**
 * ⚠️ 실행마다 **새 유저**다. 같은 유저를 재사용하면 앞선 실행에서 받은 우편이 남아 "우편 1통" 전제가
 * 깨진다(두 번째 실행부터 조용히 실패한다). 라이브 스모크는 DB 를 지우지 않고도 반복 가능해야 한다.
 */
const USER_NICK = `smk${Date.now().toString(36).slice(-7)}`;

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.headers) Object.assign(headers, init.headers as Record<string, string>);
  const res = await fetch(API + path, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

test("#323 라이브 스모크: admin 발송 → 유저 뱃지 → [받기] → 지갑 증가 (390px)", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });

  // ── 1. 실제 서버에 유저·admin 을 만들고 발송한다(목 없음) ─────────────────
  const admin = await api("/api/auth/login", { method: "POST", body: JSON.stringify(ADMIN) });
  expect(admin.status, JSON.stringify(admin.body)).toBe(200);

  const user = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ nickname: USER_NICK }),
  });
  expect(user.status, JSON.stringify(user.body)).toBe(200);
  const userToken = user.body.token as string;

  const me = await api("/api/me", { token: userToken });
  const before = me.body.wallet.points as number;
  const userId = me.body.user.id as string;

  const sent = await api("/api/admin/mails", {
    method: "POST",
    token: admin.body.token,
    headers: { "Idempotency-Key": `smoke-${Date.now()}` },
    body: JSON.stringify({
      audience: "USERS",
      userIds: [userId],
      title: "라이브 스모크 보상",
      body: "실제 서버에서 보낸 우편입니다. 받아 주세요.",
      attachments: { points: 5000, gems: 10, players: [] },
      reason: "#323 라이브 스모크",
    }),
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);

  // ── 2. 브라우저는 목 없이 그 서버를 본다 ────────────────────────────────
  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ["hmb.auth.token", userToken] as const,
  );
  await page.goto("/home");
  await expect(page.getByTestId("home-page")).toBeVisible();

  // 뱃지가 **서버 값**으로 떠 있어야 한다(/api/me.mail).
  await expect(page.getByTestId("mail-center-badge")).toHaveText("1");
  await page.screenshot({ path: `${OUT}p323-live-1-badge.png` });

  await page.getByTestId("mail-center-open").click();
  await expect(page.getByTestId("mail-item")).toHaveCount(1);
  await page.getByTestId("mail-item").first().locator("button").first().click();
  await expect(page.getByTestId("mail-claim")).toBeEnabled();
  await page.screenshot({ path: `${OUT}p323-live-2-detail.png` });

  await page.getByTestId("mail-claim").click();
  await expect(page.getByTestId("mail-item").first()).toHaveAttribute("data-state", "CLAIMED");
  await page.screenshot({ path: `${OUT}p323-live-3-claimed.png` });

  // ── 3. 지갑이 **실제로** 올랐는가(서버에 직접 묻는다) ────────────────────
  const after = await api("/api/me", { token: userToken });
  expect(after.body.wallet.points - before).toBe(5000);
  expect(after.body.mail.unread).toBe(0);
  expect(after.body.mail.total).toBe(1);

  // 화면의 지갑도 따라왔는가(캐시 무효화가 실제로 도는가).
  // ⚠️ 화면 숫자는 천단위 구분이 들어간다(`Amount`) — 원시 숫자로 찾으면 못 만난다.
  await page.getByTestId("mail-center-close").click();
  await expect(page.locator("header")).toContainText(
    (after.body.wallet.points as number).toLocaleString("en-US"),
  );
  await page.screenshot({ path: `${OUT}p323-live-4-wallet.png` });

  // ── 4. 더블탭은 실패가 아니다(라이브 확인) ──────────────────────────────
  const mails = await api("/api/mails", { token: userToken });
  const mailId = mails.body.mails[0].id as string;
  const again = await api(`/api/mails/${mailId}/claim`, { method: "POST", token: userToken });
  expect(again.status).toBe(200);
  expect(again.body.applied).toBe(false);
  const finalMe = await api("/api/me", { token: userToken });
  expect(finalMe.body.wallet.points).toBe(after.body.wallet.points);
});
