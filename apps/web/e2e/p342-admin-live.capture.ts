import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * #342 **라이브 스모크** — 운영 유저 화면을 목 없이 실서버로 확인한다.
 *
 * <p>이 화면이 라이브에서 통째로 비어 있었는데도 목킹 e2e 는 green 이었다 — <b>목이 서버와 다른
 * 모양</b>({@code {users:[{userId,…}]}})을 흉내냈기 때문이다. 그래서 이 결함 계열은 목으로 못 막는다:
 * <b>실서버로 한 번은 봐야 한다</b>.
 *
 * <p>실행(격리 스택 — 데모 :8080 · 배포 :18080 무접촉):
 * <pre>
 *   java -jar server-java/build/libs/hmb-server-0.1.0.jar --server.port=18993 \
 *        --hmb.db.path=/tmp/adm/hmb.db --hmb.admin.nickname=adm --hmb.admin.password=adm-pw-1234 \
 *        --hmb.cors.allowed-origins=http://localhost:5342 \
 *        --hmb.data.players-file=../data/players/players.v2.4.json
 *   cd apps/web && CI=1 WEB_E2E_PORT=5342 VITE_API_TARGET=http://localhost:18993 \
 *        npx playwright test --config=playwright.capture.config.ts p342-admin-live.capture.ts
 * </pre>
 */
const OUT = new URL("../.smoke/", import.meta.url).pathname;
const API = process.env.VITE_API_TARGET ?? "http://localhost:18993";
const ADMIN = { provider: "local", nickname: "adm", password: "adm-pw-1234" };

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(API + path, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

test("#342 라이브: admin 유저 목록·상세·지급이 실서버에서 동작한다", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });

  const nick = `liv${Date.now().toString(36).slice(-6)}`;
  const admin = await api("/api/auth/login", { method: "POST", body: JSON.stringify(ADMIN) });
  expect(admin.status, JSON.stringify(admin.body)).toBe(200);
  const target = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ nickname: nick }) });
  expect(target.status).toBe(200);

  await page.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    ["hmb.auth.token", admin.body.token as string] as const,
  );
  await page.goto("/admin");
  await expect(page.getByTestId("admin-page")).toBeVisible();

  // ① 목록이 **실제로 찬다**(이게 비어 있던 결함이다).
  await page.getByTestId("admin-search").fill(nick);
  const row = page.locator('[data-testid^="admin-user-row-"]').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(nick);
  await page.screenshot({ path: `${OUT}p342-admin-list.png` });

  // ② 상세 — 서버가 주는 필드만 그린다.
  await page.locator('[data-testid^="admin-user-select-"]').first().click();
  await expect(page.getByTestId("admin-user-detail")).toBeVisible();
  await expect(page.getByTestId("admin-detail-owned")).toContainText("종");
  await expect(page.getByTestId("admin-detail-record")).toBeVisible();
  await page.screenshot({ path: `${OUT}p342-admin-detail.png` });

  // ③ 지급 — 성공 직후 화면이 터지지 않고 잔액이 따라온다.
  const before = (await api("/api/me", { token: target.body.token })).body.wallet.points as number;
  await page.getByTestId("admin-grant-delta").fill("777");
  await page.getByTestId("admin-grant-reason").fill("#342 라이브 확인");
  await page.getByTestId("admin-grant-submit").click();
  await expect(page.getByTestId("admin-grant-notice")).toContainText("777");
  await expect(page.getByTestId("admin-detail-points")).toContainText((before + 777).toLocaleString("en-US"));
  await page.screenshot({ path: `${OUT}p342-admin-granted.png` });

  // ④ 서버 잔액도 실제로 올랐다.
  const after = (await api("/api/me", { token: target.body.token })).body.wallet.points as number;
  expect(after - before).toBe(777);
});
