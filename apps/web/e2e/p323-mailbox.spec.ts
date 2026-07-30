import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * #323 우편함 — **route-mock 전용**(백엔드/데모 8080 무접촉).
 *
 * 계약의 축은 넷이다:
 *  ① **진입점이 홈 헤더에 있고 뱃지가 숫자다** — hero 확정(A안). 공지는 점, 우편은 숫자다.
 *  ② **읽어도 안 받았으면 뱃지가 안 꺼진다** — 뱃지가 지켜야 하는 유일한 케이스(안 받은 보상이
 *    조용히 사라지는 것)를 화면에서도 확인한다.
 *  ③ **만료는 목록에 남고 [받기]는 잠긴다** — hero 확정 ④. 놓쳤다는 사실이 보여야 한다.
 *  ④ **390px 헤더가 넘치지 않는다** — 공지 진입점이 이미 서 있는 자리에 하나를 더 얹었다(#248 실측:
 *    오른쪽에 얹으면 헤더가 한 줄 접혔다).
 *
 * ⚠️ 라우트 매칭은 **pathname 술어**로 한다(glob 은 vite 소스까지 잡아 흰 화면이 된다 — 프로젝트 기지식).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface MailSeed {
  id: string;
  title?: string;
  state: "UNREAD" | "READ" | "CLAIMED" | "EXPIRED";
  points?: number;
  gems?: number;
}

function mail(seed: MailSeed) {
  return {
    id: seed.id,
    title: seed.title ?? `${seed.id} 제목`,
    body: `${seed.id} 본문입니다`,
    attachments: { points: seed.points ?? 0, gems: seed.gems ?? 0, players: [] },
    sentAt: "2026-07-30T00:00:00Z",
    expiresAt: null,
    readAt: seed.state === "UNREAD" ? null : "2026-07-30T01:00:00Z",
    claimedAt: seed.state === "CLAIMED" ? "2026-07-30T02:00:00Z" : null,
    state: seed.state,
  };
}

interface HomeMock {
  mails: ReturnType<typeof mail>[];
  unread: number;
  nickname?: string;
  wallet?: { points: number; gems: number };
  rating?: number;
  records?: { wins: number; draws: number; losses: number };
}

/** 현재 우편함 상태를 서버처럼 들고 있는 목 — 읽음·수령이 실제로 반영돼야 뱃지 계약이 성립한다. */
async function mockHome(page: Page, mock: HomeMock) {
  const state = { mails: mock.mails.map((m) => ({ ...m })), unread: mock.unread, listCalls: 0 };

  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page);
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: { id: "u1", nickname: mock.nickname ?? "감독님", tutorialDone: true },
        wallet: mock.wallet ?? { points: 62000, gems: 120 },
        records: mock.records ?? { wins: 3, draws: 1, losses: 2 },
        ...(mock.rating === undefined ? {} : { rating: mock.rating }),
        mail: { unread: state.unread, total: state.mails.length },
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json({ match: null, locked: false, abandonable: false })),
  );
  await page.route((url) => url.pathname === "/api/notices/active", (route) =>
    route.fulfill(json({ notices: [] })),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));

  await page.route((url) => url.pathname === "/api/mails", (route) => {
    state.listCalls += 1;
    return route.fulfill(json({ mails: state.mails, unread: state.unread }));
  });

  // 읽음 — **뱃지는 그대로**여야 한다(첨부가 남아 있으면 아직 할 일이다). 서버 규칙을 그대로 흉내낸다.
  await page.route(
    (url) => /^\/api\/mails\/[^/]+\/read$/.test(url.pathname),
    (route) => {
      const id = route.request().url().split("/api/mails/")[1].replace("/read", "");
      const target = state.mails.find((m) => m.id === id);
      if (target && target.state === "UNREAD") {
        target.state = "READ";
        target.readAt = "2026-07-30T03:00:00Z";
        const stillActionable =
          target.attachments.points > 0 || target.attachments.gems > 0;
        if (!stillActionable) state.unread = Math.max(0, state.unread - 1);
      }
      return route.fulfill(json(target ?? {}));
    },
  );

  await page.route(
    (url) => /^\/api\/mails\/[^/]+\/claim$/.test(url.pathname),
    (route) => {
      const id = route.request().url().split("/api/mails/")[1].replace("/claim", "");
      const target = state.mails.find((m) => m.id === id);
      if (!target) return route.fulfill(json({ code: "NOT_FOUND", message: "없음" }, 404));
      if (target.state === "EXPIRED") {
        return route.fulfill(
          json({ code: "GONE", message: "수령 기간이 지난 우편물입니다" }, 410),
        );
      }
      if (target.state !== "CLAIMED") {
        target.state = "CLAIMED";
        target.claimedAt = "2026-07-30T04:00:00Z";
        state.unread = Math.max(0, state.unread - 1);
      }
      return route.fulfill(
        json({
          id,
          claimed: true,
          applied: true,
          granted: { points: target.attachments.points, gems: target.attachments.gems, players: [] },
          wallet: { points: 62000 + target.attachments.points, gems: 120 },
        }),
      );
    },
  );

  return state;
}

async function gotoHome(page: Page) {
  await page.goto("/home");
  await expect(page.getByTestId("home-page")).toBeVisible();
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 진입점 · 뱃지
// ─────────────────────────────────────────────────────────────────────────────

test.describe("#323 — 홈 헤더 우편함(hero 확정 A)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("헤더에 진입점 + **숫자** 뱃지가 있고, 열면 목록이 나온다", async ({ page }) => {
    await mockHome(page, {
      mails: [mail({ id: "M1", state: "UNREAD", points: 5000 }), mail({ id: "M2", state: "READ" })],
      unread: 1,
    });
    await gotoHome(page);

    const trigger = page.getByTestId("mail-center-open");
    await expect(trigger).toBeVisible();
    // 공지는 점, 우편은 숫자다 — "몇 통 받을 게 있나"가 곧 할 일 개수라서.
    await expect(page.getByTestId("mail-center-badge")).toHaveText("1");

    await trigger.click();
    await expect(page.getByTestId("mail-center")).toBeVisible();
    await expect(page.getByTestId("mail-item")).toHaveCount(2);
  });

  /** 우편이 0건이면 진입점 자체가 없다(공지 진입점과 같은 규율 — 빈 목록으로 거짓말하지 않는다). */
  test("우편 0건이면 헤더에 아무것도 그리지 않는다", async ({ page }) => {
    await mockHome(page, { mails: [], unread: 0 });
    await gotoHome(page);

    await expect(page.getByTestId("mail-center-open")).toHaveCount(0);
  });

  /**
   * ⚠️ **변이체 킬 대상.** 뱃지를 "안 읽음"만으로 계산하도록 되돌리면 여기가 죽는다 —
   * 열어 보고 안 받은 보상이 조용히 사라지는 것이 정확히 이 계약이 막는 상황이다.
   */
  test("읽어도 뱃지가 안 꺼진다 — **받아야** 꺼진다", async ({ page }) => {
    await mockHome(page, { mails: [mail({ id: "M1", state: "UNREAD", points: 5000 })], unread: 1 });
    await gotoHome(page);

    await page.getByTestId("mail-center-open").click();
    await page.getByTestId("mail-item").first().locator("button").first().click();

    // 본문이 펼쳐졌는데도 뱃지는 그대로다.
    await expect(page.getByTestId("mail-claim")).toBeVisible();
    await expect(page.getByTestId("mail-center-badge")).toHaveText("1");

    await page.getByTestId("mail-claim").click();
    await expect(page.getByTestId("mail-center-badge")).toHaveCount(0);
    await expect(page.getByTestId("mail-item").first()).toHaveAttribute("data-state", "CLAIMED");
  });

  /**
   * hero 확정 ④ — **만료된 미수령도 목록에 남는다**(놓쳤다는 사실이 보여야 한다).
   * 대신 받을 수는 없고, 뱃지에는 세지 않는다.
   */
  test("만료 우편은 목록에 남고 [받기]가 잠긴다 · 뱃지엔 안 센다", async ({ page }) => {
    await mockHome(page, {
      mails: [mail({ id: "M1", state: "EXPIRED", points: 3000 })],
      unread: 0,
    });
    await gotoHome(page);

    await expect(page.getByTestId("mail-center-badge")).toHaveCount(0);
    await page.getByTestId("mail-center-open").click();

    const item = page.getByTestId("mail-item").first();
    await expect(item).toHaveAttribute("data-state", "EXPIRED");
    await expect(item.getByTestId("mail-state-label")).toContainText("만료됨");

    await item.locator("button").first().click();
    await expect(page.getByTestId("mail-claim")).toBeDisabled();
  });

  /**
   * ⚠️ **폭 예산.** 공지 진입점이 이미 서 있는 자리에 하나를 더 얹었고, 그 대가로 **닉네임을
   * 헤더에서 뺐다**(hero 확정). 표본은 실제로 폭을 만드는 **nowrap 조각들**(7자리 잔액 2개 ·
   * 레이팅 · [로그아웃])로 잡는다 — 닉네임은 이제 렌더되지 않으므로 표본에서 아무 일도 하지 않는다.
   *
   * "넘침 0"만 보지 않는다: `overflow:hidden` 하나로도 그 수치는 0이 된다. 두 진입점과
   * [로그아웃]이 **뷰포트 안에 온전히** 있는지를 같이 본다.
   */
  test("7자리 잔액 + 레이팅 + 공지·우편 진입점 2개에서도 넘침 0 · 컨트롤이 화면 안", async ({ page }) => {
    await mockHome(page, {
      mails: [mail({ id: "M1", state: "UNREAD", points: 5000 })],
      unread: 12,
      nickname: "리버풀특급감독김철수님입니다",
      wallet: { points: 9876543, gems: 1234567 },
      rating: 1288,
      records: { wins: 123, draws: 45, losses: 67 },
    });
    await gotoHome(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    console.log(`[p323] 390px doc overflow px = ${overflow}`);
    expect(overflow).toBeLessThanOrEqual(0);

    for (const testId of ["mail-center-open", "notice-center-open"]) {
      const el = page.getByTestId(testId);
      if ((await el.count()) === 0) continue;
      const box = (await el.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      // 진입점은 눌 수 있는 크기를 유지한다(줄어들면 예산은 지켜도 못 누른다).
      expect(box.width).toBeGreaterThanOrEqual(24);
    }
  });

  /**
   * <b>홈에 들어오는 것만으로는 목록을 받지 않는다</b>(독립검증 m2 — 이 수정에 계약이 없었다).
   *
   * <p>헤더가 필요한 두 숫자는 `/api/me.mail` 에 이미 실려 온다. 목록은 본문까지 실린 응답이라
   * 홈 진입마다 받으면 그 필드는 아무도 안 쓰는 죽은 값이 되고 왕복만 는다. 우편함을 <b>열 때</b>
   * 한 번 받는다.
   */
  test("홈 진입에는 목록 요청 0건 — 우편함을 열 때 받는다", async ({ page }) => {
    const state = await mockHome(page, {
      mails: [mail({ id: "M1", state: "UNREAD", points: 5000 })],
      unread: 1,
    });
    await gotoHome(page);

    // 뱃지는 이미 떠 있다(= /api/me 로 그렸다).
    await expect(page.getByTestId("mail-center-badge")).toHaveText("1");
    expect(state.listCalls, "홈 진입만으로는 목록을 받지 않는다").toBe(0);

    await page.getByTestId("mail-center-open").click();
    await expect(page.getByTestId("mail-item")).toHaveCount(1);
    expect(state.listCalls).toBeGreaterThan(0);
  });

  /**
   * **응답 형태를 믿지 않는다** — 구 서버·프록시의 200 `{}` 가 홈을 죽이면 안 된다.
   * #245 가 로비에서 정확히 이렇게 당했고, 홈은 이제 앱 진입점이다.
   */
  test("우편함 응답이 `{}` 여도 홈이 살아 있다", async ({ page }) => {
    await mockHome(page, { mails: [], unread: 0 });
    await page.route((url) => url.pathname === "/api/mails", (route) => route.fulfill(json({})));
    await gotoHome(page);

    await expect(page.getByTestId("home-tiles")).toBeVisible();
    await expect(page.getByTestId("mail-center-open")).toHaveCount(0);
  });
});
