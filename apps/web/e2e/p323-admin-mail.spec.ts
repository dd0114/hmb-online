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

  /**
   * **재전송을 "발송했습니다"로 그리지 않는다**(독립검증 3R m5 — 계약이 없었다).
   *
   * 서버는 201/200 으로 구분해 주는데 화면이 같은 문구를 쓰면 그 구분에 소비자가 없다 —
   * 운영자는 "또 보냈나?"를 응답을 뜯어보지 않고는 알 수 없다.
   */
  test("멱등 재전송은 '추가 발송 없음'으로 구분해 보여준다", async ({ page }) => {
    await mockAdmin(page, {
      sendStatus: 200,
      sendBody: { campaignId: "c1", audience: "USERS", targetCount: 1, applied: false },
    });
    await gotoMails(page);
    await fillMinimal(page);
    await page.getByTestId("mail-send").click();

    await expect(page.getByTestId("mail-notice")).toContainText("추가 발송");
    await expect(page.getByTestId("mail-notice")).not.toContainText("발송했습니다.");
  });

  /**
   * 서버 409 는 "새 Idempotency-Key 로 요청하세요"라고 안내한다 — 키를 클라가 들고 있으므로
   * **그 안내를 실행할 수단이 화면에 있어야** 한다(독립검증 3R m6). 실패 재시도의 기본은 여전히
   * 같은 키다(이중 발행 방지) — 새 키는 **명시적 행동**이다.
   */
  test("409 뒤에는 [새 키로 다시 보내기]가 있고, 그때만 키가 바뀐다", async ({ page }) => {
    const sent = await mockAdmin(page, {
      sendStatus: 409,
      sendBody: { code: "CONFLICT", message: "이미 다른 내용으로 사용됐습니다" },
    });
    await gotoMails(page);
    await fillMinimal(page);

    await page.getByTestId("mail-send").click();
    await expect(page.getByTestId("mail-error")).toBeVisible();
    await page.getByTestId("mail-send").click();
    expect(sent.idemKeys[0], "재시도 기본은 같은 키").toBe(sent.idemKeys[1]);

    await page.getByTestId("mail-new-key").click();
    await page.getByTestId("mail-send").click();
    expect(sent.idemKeys[2], "새 키를 명시적으로 눌렀을 때만 바뀐다").not.toBe(sent.idemKeys[0]);
  });

  /**
   * **지정 발송도 다수면 확인**을 받는다(독립검증 3R m10 — 500명 붙여넣기가 첫 클릭에 나갔다).
   * 되돌릴 수 없는 발행의 폭은 전체 발송과 같다.
   */
  test("지정 발송도 10명 이상이면 확인을 한 번 더 받는다", async ({ page }) => {
    const sent = await mockAdmin(page);
    await gotoMails(page);
    await page.getByTestId("mail-userids").fill(
      Array.from({ length: 10 }, (_, i) => `u_${i}`).join("\n"),
    );
    await page.getByTestId("mail-title").fill("대량 보상");
    await page.getByTestId("mail-body").fill("본문");
    await page.getByTestId("mail-reason").fill("이벤트");

    await page.getByTestId("mail-send").click();
    await expect(page.getByTestId("mail-confirm")).toBeVisible();
    expect(sent.bodies, "첫 클릭에는 나가지 않는다").toHaveLength(0);

    await page.getByTestId("mail-send").click();
    expect(sent.bodies).toHaveLength(1);
  });

  /** 소수 지정(9명)은 확인 없이 바로 나간다 — 임계가 실제로 임계인지. */
  test("9명은 확인 없이 발송된다(임계가 임계로 동작한다)", async ({ page }) => {
    const sent = await mockAdmin(page);
    await gotoMails(page);
    await page.getByTestId("mail-userids").fill(
      Array.from({ length: 9 }, (_, i) => `u_${i}`).join("\n"),
    );
    await page.getByTestId("mail-title").fill("소량 보상");
    await page.getByTestId("mail-body").fill("본문");
    await page.getByTestId("mail-reason").fill("이벤트");

    await page.getByTestId("mail-send").click();
    await expect(page.getByTestId("mail-notice")).toBeVisible();
    expect(sent.bodies).toHaveLength(1);
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
