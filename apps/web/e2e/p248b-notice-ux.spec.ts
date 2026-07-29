import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * #248 후속 — **공지 UX 두 건** (route-mock 전용, 백엔드/데모 8080 무접촉).
 *
 * 계약의 축은 셋이다:
 *  ① **튜토리얼이 도는 동안 공지는 뜨지 않는다** — 게임을 처음 켠 사람이 무엇을 하라는 안내를
 *    받기 전에 "새벽 점검 안내"부터 읽는 일이 없어야 한다. 그리고 그건 **미룸이지 삼킴이 아니다**.
 *  ② **놓친 공지를 다시 볼 곳이 있다** — 억제(닫기·24시간)는 팝업에만 걸리고 목록에는 남는다.
 *    그게 이 기능의 존재 이유다(24시간 억제 중 노출 기간이 끝나면 팝업으로는 영영 못 본다).
 *  ③ **390px 헤더가 넘치지 않는다** — 진입점을 얹은 자리는 #232 이후 이미 넘치던 자리다.
 *
 * ⚠️ 라우트 매칭은 **pathname 술어**로 한다(glob 은 vite 소스까지 잡아 흰 화면이 된다 — 프로젝트 기지식).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

interface NoticeSeed {
  id: string;
  revision?: number;
  title?: string;
  body?: string;
  startsAt?: string | null;
  endsAt?: string | null;
}

function notice(seed: NoticeSeed) {
  return {
    id: seed.id,
    revision: seed.revision ?? 1,
    title: seed.title ?? `${seed.id} 제목`,
    body: seed.body ?? `${seed.id} 본문입니다`,
    startsAt: seed.startsAt ?? null,
    endsAt: seed.endsAt ?? null,
    priority: 0,
  };
}

interface LobbyMock {
  payload: unknown;
  status?: number;
  /** false = 신규 유저(온보딩 튜토리얼이 뜬다). 기본은 완료 유저. */
  tutorialDone?: boolean;
  nickname?: string;
  wallet?: { points: number; gems: number };
  /** #245 원정 레이팅 배지 — `white-space: nowrap` 이라 헤더 왼쪽의 최소 폭을 끌어올린다. */
  rating?: number;
  records?: { wins: number; draws: number; losses: number };
}

async function mockLobby(page: Page, mock: LobbyMock) {
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page);
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: {
          id: "u1",
          nickname: mock.nickname ?? "감독님",
          tutorialDone: mock.tutorialDone ?? true,
        },
        wallet: mock.wallet ?? { points: 62000, gems: 120 },
        records: mock.records ?? { wins: 3, draws: 1, losses: 2 },
        ...(mock.rating === undefined ? {} : { rating: mock.rating }),
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json({ match: null, locked: false, abandonable: false })),
  );
  await page.route((url) => url.pathname === "/api/me/away-reports", (route) =>
    route.fulfill(json({ reports: [], summary: null, rating: 1200, unseen: 0 })),
  );
  // 도감(/codex)은 "로비를 떠났다 돌아온다"를 리로드 없이 재현하는 데만 쓴다. 캐치올 `{}` 로는
  // 그 화면이 죽어(`players.filter is not a function`) 하단 네비까지 사라지므로 배열만 채워 준다.
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/notices/active", (route) =>
    route.fulfill(json(mock.payload, mock.status ?? 200)),
  );
}

async function gotoLobby(page: Page) {
  await page.goto("/home");
  await expect(page.getByTestId("home-page")).toBeVisible();   // #286: 로비 → 홈
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 튜토리얼 중에는 공지를 미룬다
// ─────────────────────────────────────────────────────────────────────────────

test.describe("#248 후속 — 튜토리얼이 공지보다 먼저다", () => {
  const oneNotice = { notices: [notice({ id: "N1", title: "새벽 정기 점검 안내" })] };

  /**
   * ⚠️ **변이체 킬 대상 ①.** `pickLobbyPopup` 의 `tutorialActive` 게이트를 되돌리면 여기가 죽는다.
   *
   * 고치기 전 실제 동작: 공지 팝업이 뜨고, 코치마크는 (다른 다이얼로그가 열리면 스스로 숨는
   * 규칙 때문에) **조용히 사라져 있었다** — 즉 신규 유저의 첫 화면이 점검 공지였다.
   */
  test("신규 유저(tutorialDone=false) 첫 진입 — 코치마크가 뜨고 공지는 안 뜬다", async ({ page }) => {
    await mockLobby(page, { payload: oneNotice, tutorialDone: false });
    await gotoLobby(page);

    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);
    // 화면을 덮는 다이얼로그는 코치마크 하나뿐이다.
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);
    // 첫 스텝이 실제로 온보딩 스텝인지까지 본다(공지가 아니라 게임 안내를 먼저 본다).
    await expect(page.getByTestId("tutorial-bubble")).toHaveAttribute("data-step-id", "play");
  });

  /**
   * **튜토리얼이 끝나는 순간에도 띄우지 않는다**(매니저 확정).
   *
   * 완료 저장(`persistTutorialDone`)이 `["deck"]`·`["me"]` 캐시를 무효화해 덱 지급 결과로 화면이
   * 바뀌는 바로 그 프레임이다 — 거기에 점검 공지를 얹으면 **지금 고치려는 상황이 그대로 재현된다**.
   * 그렇다고 삼키지도 않는다: **다음 로비 진입**에 정상적으로 뜬다.
   *
   * ⚠️ 마지막 단언(억제 저장소가 비어 있다)이 이 계약의 핵심이다 — 안 띄운 공지를 "봤다"로
   * 기록해 버리면 그 유저는 **영영 못 본다**. 미룸과 삼킴의 차이가 정확히 이 저장소에 있다.
   */
  test("튜토리얼 완료 **직후 같은 화면**에도 안 뜨고, **다음 진입**에 뜬다 (소진 기록 0)", async ({
    page,
  }) => {
    await mockLobby(page, { payload: oneNotice, tutorialDone: false });
    await gotoLobby(page);
    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    // ① 완료(건너뛰기) — 코치마크는 사라지지만 공지는 아직 아니다.
    await page.getByTestId("tutorial-skip").click();
    await expect(page.getByTestId("tutorial-bubble")).toHaveCount(0);
    // 완료 처리·캐시 무효화가 다 끝날 시간을 준다(늦게 튀어나오는 것도 잡는다).
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("notice-popup"), "완료 직후 같은 화면에는 안 뜬다").toHaveCount(0);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // ② 아직 아무것도 소진되지 않았다 — 미룬 것이지 본 것이 아니다.
    expect(
      await page.evaluate(() => window.sessionStorage.getItem("hmb.notice.closed.v1")),
    ).toBeNull();
    expect(
      await page.evaluate(() => window.localStorage.getItem("hmb.notice.dismissed.v1")),
    ).toBeNull();

    // ③ 화면을 떠났다 돌아오는 것(**리로드 없는 SPA 라우트 이동**)만으로 다음 진입이 성립한다.
    //    래치가 컴포넌트 수명에 살아야 여기서 풀린다 — 모듈 변수나 서버 플래그로 만들었다면
    //    SPA 이동은 그것들을 건드리지 않으므로 공지가 계속 미뤄진다.
    await page.getByTestId("home-tile-players").click();
    await expect(page.getByTestId("play-cta")).toHaveCount(0);
    // 네비는 하단탭(모바일)·사이드바(데스크탑) 두 벌이 렌더된다 — 보이는 쪽을 누른다.
    await page.locator('[data-testid="nav-home"]:visible').first().click();
    await expect(page.getByTestId("home-page")).toBeVisible();   // #286: 로비 → 홈
    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("notice-title")).toHaveText("새벽 정기 점검 안내");
    // 튜토리얼이 다시 뜨지도 않는다(완료가 저장됐다).
    await expect(page.getByTestId("tutorial-bubble")).toHaveCount(0);
  });

  test("리로드로 다시 들어와도 미룬 공지는 살아 있다 (영구 미룸이 아니다)", async ({ page }) => {
    await mockLobby(page, { payload: oneNotice, tutorialDone: false });
    await gotoLobby(page);
    await page.getByTestId("tutorial-skip").click();
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    // ⚠️ 서버 플래그는 여전히 tutorialDone=false 다(목이 안 바뀐다) — 그럼에도 리로드 뒤엔
    // 튜토리얼이 안 뜨고(로컬 완료 저장) 공지가 뜬다. 서버 값 변화로 판정했다면 여기서 깨진다.
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toBeVisible();
  });

  test("무회귀 — 튜토리얼을 이미 마친 유저는 예전처럼 진입 즉시 공지를 본다", async ({ page }) => {
    await mockLobby(page, { payload: oneNotice, tutorialDone: true });
    await gotoLobby(page);

    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("tutorial-bubble")).toHaveCount(0);
  });

  test("튜토리얼 중에도 **공지 다시 보기 진입점은 살아 있다** (막는 건 자동 팝업뿐)", async ({ page }) => {
    await mockLobby(page, { payload: oneNotice, tutorialDone: false });
    await gotoLobby(page);

    await expect(page.getByTestId("tutorial-bubble")).toBeVisible();
    // 미룬 것이지 감춘 것이 아니다 — 궁금하면 지금도 읽을 수 있다.
    await expect(page.getByTestId("notice-center-open")).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 놓친 공지를 다시 볼 곳
// ─────────────────────────────────────────────────────────────────────────────

test.describe("#248 후속 — 공지 다시 보기 목록", () => {
  test("공지가 0건이면 진입점 자체가 없다 (헤더를 빈 버튼이 차지하지 않는다)", async ({ page }) => {
    await mockLobby(page, { payload: { notices: [] } });
    await gotoLobby(page);
    await expect(page.getByTestId("notice-center-open")).toHaveCount(0);
  });

  test("조회가 실패해도(500·구 서버 `{}`) 진입점 없이 로비는 산다", async ({ page }) => {
    for (const c of [
      { payload: { code: "INTERNAL_ERROR", message: "boom" }, status: 500 },
      { payload: {}, status: 200 },
    ]) {
      const ctx = await page.context().newPage();
      const errors: string[] = [];
      ctx.on("pageerror", (e) => errors.push(String(e)));
      await mockLobby(ctx, c);
      await gotoLobby(ctx);
      await expect(ctx.getByTestId("notice-center-open")).toHaveCount(0);
      await expect(ctx.getByTestId("home-tile-deck")).toBeVisible();
      expect(errors, "렌더 중 예외 0").toEqual([]);
      await ctx.close();
    }
  });

  /**
   * ⚠️ **변이체 킬 대상 ②** — 목록을 `visibleNotices`(억제 적용)로 바꾸면 여기가 죽는다.
   *
   * 이 시나리오가 곧 기능의 존재 이유다: [24시간 안 보기]를 누른 뒤 그 사이 노출 기간이 끝나면
   * 팝업으로는 **영영 못 본다**. "점검이 몇 시부터랬지?" 에 답할 곳이 있어야 한다.
   */
  test("[24시간 안 보기]를 누른 공지도 목록에서는 보인다", async ({ page }) => {
    await mockLobby(page, {
      payload: {
        notices: [
          notice({ id: "N1", title: "정기 점검", body: "03:00 ~ 05:00 입니다" }),
          notice({ id: "N2", title: "신규 유닛" }),
        ],
      },
    });
    await gotoLobby(page);

    // 두 장 모두 억제해 팝업을 완전히 비운다.
    await page.getByTestId("notice-dismiss-24h").click();
    await page.getByTestId("notice-dismiss-24h").click();
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);

    // 재진입해도 팝업은 안 뜬다(억제는 살아 있다).
    await gotoLobby(page);
    await expect(page.getByTestId("notice-popup")).toHaveCount(0);
    // 안 읽음 점도 꺼져 있다.
    await expect(page.getByTestId("notice-center-dot")).toHaveCount(0);

    // 그래도 목록에는 둘 다 있고, 본문을 다시 읽을 수 있다.
    await page.getByTestId("notice-center-open").click();
    await expect(page.getByTestId("notice-center-item")).toHaveCount(2);
    await page.getByTestId("notice-center-item-toggle").first().click();
    await expect(page.getByTestId("notice-center-body")).toContainText("03:00 ~ 05:00");
  });

  test("안 읽음 점 — 팝업으로 처리하면 꺼지고, 목록에서 읽어도 꺼진다", async ({ page }) => {
    await mockLobby(page, {
      payload: { notices: [notice({ id: "N1" }), notice({ id: "N2" })] },
    });
    await gotoLobby(page);

    await expect(page.getByTestId("notice-center-open")).toHaveAttribute("data-unread", "2");
    await page.getByTestId("notice-close").click(); // 첫 장 처리
    await expect(page.getByTestId("notice-center-open")).toHaveAttribute("data-unread", "1");
    await page.getByTestId("notice-close").click(); // 둘째 장 처리
    await expect(page.getByTestId("notice-center-open")).toHaveAttribute("data-unread", "0");
    await expect(page.getByTestId("notice-center-dot")).toHaveCount(0);

    // 새 탭 세션이면 다시 안 읽음 — 그 상태에서 목록으로 읽어도 점이 꺼진다.
    await page.evaluate(() => window.sessionStorage.clear());
    await gotoLobby(page);
    await page.getByTestId("notice-close").click();
    await page.getByTestId("notice-close").click();
    await page.evaluate(() => window.sessionStorage.clear());
    await gotoLobby(page);
    await expect(page.getByTestId("notice-center-open")).toHaveAttribute("data-unread", "2");
    await page.getByTestId("notice-popup").getByTestId("notice-close").click();
    await page.getByTestId("notice-popup").getByTestId("notice-close").click();
    await page.getByTestId("notice-center-open").click();
    await page.getByTestId("notice-center-item-toggle").first().click();
    await page.getByTestId("notice-center-close").click();
    await expect(page.getByTestId("notice-center-open")).toHaveAttribute("data-unread", "0");
  });

  test("목록 본문은 **팝업과 같은 렌더러** — 서식은 되고 스크립트는 안 된다", async ({ page }) => {
    const body = [
      "**굵게** 안내",
      "",
      "- 항목 하나",
      "",
      "[게시판](https://example.test/n)",
      "",
      '<script>window.__pwned = "list"</script>',
      "",
      "[눌러](javascript:window.__pwned='href')",
    ].join("\n");
    await mockLobby(page, { payload: { notices: [notice({ id: "N1", body })] } });
    await gotoLobby(page);
    await page.getByTestId("notice-close").click();

    await page.getByTestId("notice-center-open").click();
    await page.getByTestId("notice-center-item-toggle").first().click();
    const el = page.getByTestId("notice-center-body");

    await expect(el.locator("strong")).toHaveText("굵게");
    await expect(el.locator("ul li")).toHaveCount(1);
    await expect(el.locator("a")).toHaveCount(1); // javascript: 는 링크가 되지 않는다
    await expect(el.locator("a")).toHaveAttribute("href", "https://example.test/n");
    expect(await el.locator("script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ 390px 폭 예산 — 진입점을 얹은 자리는 이미 넘치던 자리다
// ─────────────────────────────────────────────────────────────────────────────

test.describe("#248 후속 — 390px 헤더가 넘치지 않는다", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /** 문서 전체 가로 넘침(px). 0 이하여야 한다. */
  async function docOverflow(page: Page): Promise<number> {
    return page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  }

  async function headerHeight(page: Page): Promise<number> {
    return page.evaluate(() =>
      Math.round(document.querySelector("header")!.getBoundingClientRect().height),
    );
  }

  /**
   * ⚠️ **변이체 킬 대상 ③.** `LobbyPage.module.css` 의 폭 예산(줄바꿈 허용 · 닉네임 말줄임)을
   * 되돌리면 여기가 죽는다. 되돌린 상태의 실측 = 문서 넘침 11px · 헤더 행 내부 27px,
   * 화면에서는 **[로그아웃]이 오른쪽으로 잘려 나갔다**.
   *
   * ⚠️ **표본 구성이 계약의 절반이다.** 처음 쓴 표본(긴 닉네임 + 7자리 잔액)만으로는 변이체가
   * **살아남았다** — 한글 닉네임은 글자 단위로 줄바꿈돼 왼쪽 열의 최소 폭이 1글자까지 줄기
   * 때문이다. 실제 넘침을 만드는 것은 **`nowrap` 인 조각들**(#245 레이팅 배지 · 전적)이다.
   * 그래서 레이팅과 세 자리 전적을 표본에 넣는다 — 이게 라이브 유저의 실제 헤더다.
   *
   * 단언을 "넘침 0"만으로 두지 않는 이유: `overflow:hidden` 하나로도 넘침 수치는 0이 된다.
   * **모든 컨트롤이 뷰포트 안에 온전히 들어와 있는지**를 같이 본다.
   */
  test("긴 닉네임 + 7자리 잔액 + 레이팅 배지 + 공지 진입점에서도 넘침 0 · 모든 컨트롤이 화면 안", async ({
    page,
  }) => {
    await mockLobby(page, {
      payload: { notices: [notice({ id: "N1" })] },
      nickname: "리버풀특급감독김철수님입니다",
      wallet: { points: 9876543, gems: 1234567 },
      rating: 1288,
      records: { wins: 123, draws: 45, losses: 67 },
    });
    await gotoLobby(page);
    await page.getByTestId("notice-close").click(); // 팝업을 치우고 헤더만 본다

    const overflow = await docOverflow(page);
    console.log(`[p248b] 390px doc overflow px = ${overflow}`);
    expect(overflow).toBeLessThanOrEqual(0);

    for (const id of ["notice-center-open", "points-badge", "wallet-gems"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} 가 렌더돼 있다`).not.toBeNull();
      expect(box!.x, `${id} 좌측이 화면 안`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${id} 우측이 화면 안`).toBeLessThanOrEqual(390);
    }
    const logout = await page.getByRole("button", { name: "로그아웃" }).boundingBox();
    expect(logout!.x + logout!.width, "로그아웃이 화면 밖으로 잘리지 않는다").toBeLessThanOrEqual(390);

    // 진입점은 눌 수 있는 크기다(줄어들어 사라지지 않는다).
    const trigger = (await page.getByTestId("notice-center-open").boundingBox())!;
    expect(trigger.width).toBeGreaterThanOrEqual(28);
    expect(trigger.height).toBeGreaterThanOrEqual(28);
  });

  /**
   * **진입점이 헤더를 한 줄 늘리지 않는다.**
   *
   * 절대 임계(“헤더는 N px 이하”)를 쓰지 않는다 — 그건 내가 정한 숫자라 폰트·전적 길이가 바뀌면
   * 의미가 사라진다. 대신 **같은 계정의 대조군**과 비교한다: 공지 0건이면 진입점이 스스로 사라지므로
   * (설계 결정 2) *다른 모든 것이 동일하고 진입점만 없는* 화면을 공짜로 얻는다.
   *
   * 이 관계식이 실제로 판별한다 — 진입점을 지갑 배지 옆(오른쪽)으로 옮긴 변이체의 실측은
   * 69 → **113px**(한 줄 접힘)이고 여기서 죽는다. 닉네임 옆은 +4~8px 다.
   */
  test("진입점이 헤더를 한 줄 늘리지 않는다 (같은 계정 대조군 대비)", async ({ page, context }) => {
    const control = await context.newPage();
    await mockLobby(control, { payload: { notices: [] } });
    await gotoLobby(control);
    await expect(control.getByTestId("notice-center-open"), "대조군엔 진입점이 없다").toHaveCount(0);
    const controlH = await headerHeight(control);
    await control.close();

    await mockLobby(page, { payload: { notices: [notice({ id: "N1" })] } });
    await gotoLobby(page);
    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-center-open")).toBeVisible();
    const withEntryH = await headerHeight(page);

    console.log(`[p248b] header height — control=${controlH} withEntry=${withEntryH}`);
    expect(await docOverflow(page)).toBeLessThanOrEqual(0);
    // 텍스트 한 줄(≈20px) 이상 늘어나면 접힌 것이다.
    expect(withEntryH - controlH, "진입점 때문에 헤더가 한 줄 접혔다").toBeLessThan(20);
  });

  test("아주 긴 공지에서도 목록은 안에서만 스크롤하고 [닫기]는 항상 화면 안", async ({ page }) => {
    const long = Array.from({ length: 60 }, (_, i) => `${i + 1}번째 줄 — 아주 긴 점검 안내 본문입니다.`).join("\n");
    await mockLobby(page, {
      payload: {
        notices: [notice({ id: "N1", body: long }), notice({ id: "N2" }), notice({ id: "N3" })],
      },
    });
    await gotoLobby(page);
    await page.getByTestId("notice-close").click();
    await page.getByTestId("notice-close").click();
    await page.getByTestId("notice-close").click();

    await page.getByTestId("notice-center-open").click();
    await page.getByTestId("notice-center-item-toggle").first().click();

    expect(await docOverflow(page), "가로 넘침 0").toBeLessThanOrEqual(0);
    const close = (await page.getByTestId("notice-center-close").boundingBox())!;
    expect(close.y + close.height, "[닫기]가 화면 아래로 밀려나지 않는다").toBeLessThanOrEqual(844);
    expect(close.y, "[닫기]가 화면 위로도 벗어나지 않는다").toBeGreaterThanOrEqual(0);
    // 페이지가 아니라 목록이 스크롤한다.
    const pageScroll = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    expect(pageScroll, "본문이 길다고 페이지가 늘어나지 않는다").toBeLessThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ 캐릭터 합류 공지의 세로형 히어로 이미지 (#248 후속 — 이미지 상한 220 → 340)
// ─────────────────────────────────────────────────────────────────────────────

test.describe("#248 후속 — 세로형 히어로 이미지가 잘리지 않는다", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /** 실제 리포 에셋을 쓴다 — 파일이 사라지거나 규격이 바뀌면 이 계약이 먼저 깨진다. */
  const HERO = "/notice/hero-kyeongnicius.webp";

  test("히어로 이미지가 폭을 채우고, [닫기]는 스크롤 없이 보인다", async ({ page }) => {
    await mockLobby(page, {
      payload: { notices: [notice({ id: "N1", body: `![경니시우스](${HERO})\n\n**LEGEND** 등급 공격수.` })] },
    });
    await gotoLobby(page);

    const img = page.locator('[data-testid="notice-popup"] img').first();
    await expect(img).toBeVisible();
    // 실제로 픽셀이 도착했는지 — 깨진 이미지는 naturalWidth 0 이다.
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth), "에셋이 실제로 로드된다")
      .toBeGreaterThan(0);

    const box = (await img.boundingBox())!;
    // 상한이 220 이면 contain 이 폭을 220×0.92≈202px 로 묶어 **좌우가 빈다**.
    expect(box.width, "좌우가 비지 않고 폭을 채운다").toBeGreaterThan(250);
    expect(box.height, "상한(340)을 넘지 않는다").toBeLessThanOrEqual(340);

    // 가로 넘침 0 + 닫기 버튼이 첫 화면에 보인다(상한을 더 키우면 여기서 깨진다).
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      "가로 넘침 0",
    ).toBeLessThanOrEqual(0);
    const close = (await page.getByTestId("notice-close").boundingBox())!;
    expect(close.y + close.height, "[닫기]가 화면 아래로 밀려나지 않는다").toBeLessThanOrEqual(844);
  });
});
