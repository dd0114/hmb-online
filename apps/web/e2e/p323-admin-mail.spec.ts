import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * #323 W4 — **우편 발송 운영 패널**(route-mock 전용, 백엔드/데모 8080 무접촉).
 *
 * 계약의 축은 셋이다. 전부 "되돌릴 수 없는 발행"을 막는 장치다:
 *  ① **멱등키를 클라가 만들고, 실패해도 같은 키로 재시도한다** — 새 키로 재시도하면 같은 보상이
 *    두 번 발행된다. 서버 채번에 맡기면 재전송 보호가 아예 없다.
 *  ② **전체 발송은 한 번 더 확인**받는다.
 *  ③ **서버 문구를 그대로 보여준다**(409·400) — 복구 경로가 그 문장에 있다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로(glob 은 vite 소스까지 잡아 흰 화면이 된다).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface Sent {
  idemKeys: string[];
  bodies: Record<string, unknown>[];
}

async function mockAdmin(page: Page, opts: { sendStatus?: number; sendBody?: unknown } = {}) {
  const sent: Sent = { idemKeys: [], bodies: [] };

  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_admin"));
  await page.route((u) => u.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await mockAppConfig(page);
  await page.route((u) => u.pathname === "/api/me", (r) =>
    r.fulfill(
      json({
        user: { id: "a1", nickname: "운영자", isAdmin: true, tutorialDone: true },
        wallet: { points: 0, gems: 0 },
        records: { wins: 0, draws: 0, losses: 0 },
        mail: { unread: 0, total: 0 },
      }),
    ),
  );
  await page.route((u) => u.pathname === "/api/admin/mails", (route) => {
    if (route.request().method() === "POST") {
      sent.idemKeys.push(route.request().headers()["idempotency-key"] ?? "");
      sent.bodies.push(JSON.parse(route.request().postData() ?? "{}"));
      return route.fulfill(
        json(
          opts.sendBody ?? { campaignId: "c1", audience: "USERS", targetCount: 1, applied: true },
          opts.sendStatus ?? 201,
        ),
      );
    }
    return route.fulfill(json({ campaigns: [] }));
  });
  await page.route((u) => u.pathname === "/api/admin/mails/history", (r) => r.fulfill(json([])));

  return sent;
}

async function gotoMails(page: Page) {
  await page.goto("/admin");
  await page.getByTestId("admin-tab-mails").click();
  await expect(page.getByTestId("admin-mails")).toBeVisible();
}

async function fillMinimal(page: Page) {
  await page.getByTestId("mail-userids").fill("u_1");
  await page.getByTestId("mail-title").fill("패치 보상");
  await page.getByTestId("mail-body").fill("받아 주세요");
  await page.getByTestId("mail-points").fill("5000");
  await page.getByTestId("mail-reason").fill("v3.02 보상 #323");
}

test.describe("#323 W4 — 우편 발송 패널", () => {
  test("지정 발송 — Idempotency-Key 를 클라가 싣는다", async ({ page }) => {
    const sent = await mockAdmin(page);
    await gotoMails(page);
    await fillMinimal(page);
    await page.getByTestId("mail-send").click();

    await expect(page.getByTestId("mail-notice")).toBeVisible();
    expect(sent.idemKeys).toHaveLength(1);
    expect(sent.idemKeys[0]!.length).toBeGreaterThan(8);
    expect(sent.bodies[0]).toMatchObject({
      audience: "USERS",
      userIds: ["u_1"],
      attachments: { points: 5000, gems: 0, players: [] },
    });
    // 기한을 비웠으면 **무기한** — 0 을 보내지 않는다(서버는 1 이상만 받는다).
    expect(sent.bodies[0]).not.toHaveProperty("expiresInDays");
  });

  /**
   * ⚠️ **변이체 킬.** 실패 후 키를 새로 만들면 여기가 죽는다 — 같은 내용이 두 번 발행되는 경로다.
   */
  test("발송 실패 후 재시도는 **같은 키**로 나간다", async ({ page }) => {
    const sent = await mockAdmin(page, {
      sendStatus: 500,
      sendBody: { code: "INTERNAL_ERROR", message: "서버 오류" },
    });
    await gotoMails(page);
    await fillMinimal(page);

    await page.getByTestId("mail-send").click();
    await expect(page.getByTestId("mail-error")).toBeVisible();
    await page.getByTestId("mail-send").click();
    await expect(page.getByTestId("mail-error")).toBeVisible();

    expect(sent.idemKeys).toHaveLength(2);
    expect(sent.idemKeys[0]).toBe(sent.idemKeys[1]);
  });

  test("전체 발송은 확인을 한 번 더 받는다 — 첫 클릭에 나가지 않는다", async ({ page }) => {
    const sent = await mockAdmin(page);
    await gotoMails(page);
    await page.getByTestId("mail-audience").selectOption("ALL");
    await page.getByTestId("mail-title").fill("전체 보상");
    await page.getByTestId("mail-body").fill("본문");
    await page.getByTestId("mail-reason").fill("이벤트");

    await page.getByTestId("mail-send").click();
    await expect(page.getByTestId("mail-confirm")).toBeVisible();
    expect(sent.bodies).toHaveLength(0);

    await page.getByTestId("mail-send").click();
    await expect(page.getByTestId("mail-notice")).toBeVisible();
    expect(sent.bodies).toHaveLength(1);
    expect(sent.bodies[0]).toMatchObject({ audience: "ALL" });
    expect(sent.bodies[0]).not.toHaveProperty("userIds");
  });

  test("서버 4xx 문구를 그대로 보여준다(409 같은 키 다른 내용)", async ({ page }) => {
    await mockAdmin(page, {
      sendStatus: 409,
      sendBody: {
        code: "CONFLICT",
        message: "이 Idempotency-Key 는 이미 다른 내용으로 사용됐습니다. 내용을 바꾸려면 새 Idempotency-Key 로 요청하세요",
      },
    });
    await gotoMails(page);
    await fillMinimal(page);
    await page.getByTestId("mail-send").click();

    await expect(page.getByTestId("mail-error")).toContainText("이미 다른 내용으로 사용됐습니다");
  });

  test("사유 없이 보낼 수 없다 — 요청 자체가 안 나간다", async ({ page }) => {
    const sent = await mockAdmin(page);
    await gotoMails(page);
    await page.getByTestId("mail-userids").fill("u_1");
    await page.getByTestId("mail-title").fill("제목");
    await page.getByTestId("mail-body").fill("본문");

    await page.getByTestId("mail-send").click();
    expect(sent.bodies).toHaveLength(0);
  });
});
