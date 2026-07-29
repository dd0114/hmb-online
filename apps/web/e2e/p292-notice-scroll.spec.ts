import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * #292 — **공지 본문이 접혀 있다는 걸 알 수 있는가** (route-mock 전용, 백엔드/데모 8080 무접촉).
 *
 * hero 제보의 실체는 "페이징이 없다"가 아니었다 — 페이징은 #248 때부터 있었고(그 계약은
 * `p248-notice-popup.spec.ts` 가 소유한다), **활성 공지가 1건이라 장이 하나였을 뿐**이다.
 * 진짜 결함은 그 한 장 안에서 **496px 이 아무 신호 없이 접혀 있던 것**이다: 390×844 첫 화면에
 * 히어로 이미지와 한 줄만 보이니 그게 본문의 끝처럼 읽힌다.
 *
 * 그래서 이 파일이 지키는 성질은 셋이다.
 *  ① **접을 이유가 없으면 접지 않는다** — 화면이 남는데 본문만 `46vh` 로 묶여 있던 것.
 *  ② **접혔으면 접혔다고 보인다** — 넘칠 때만 켜지고 **끝에 닿으면 꺼지는** 하단 페이드.
 *  ③ **그 대가로 버튼이 밀리지 않는다** — 닫기·24h 는 어느 화면에서도 첫 화면에 있어야 한다.
 *
 * ⚠️ **여기에 "스크롤바가 보인다"를 단언하지 마라.** 헤드리스/모바일 크롬은 오버레이 스크롤바라
 * 폭이 **0** 이고(실측 `offsetWidth - clientWidth === 0`, `::-webkit-scrollbar` 를 선언해도 그렇다),
 * iOS 사파리는 커스텀 스크롤바를 아예 안 그린다. 막대는 데스크탑 **보조**일 뿐이고 폰에서
 * 실제로 일하는 신호는 페이드다 — 막대를 단언하면 **검사하는 척하며 항상 통과**한다.
 *
 * ⚠️ 라우트 매칭은 **pathname 술어**로 한다(glob 은 vite 소스까지 잡아 흰 화면이 된다).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/**
 * 히어로 이미지는 **목이 아니라 실제 에셋**(`public/notice/hero-kyeongnicius.webp`)을 쓴다.
 *
 * ⚠️ 더미 1×1 PNG 로 바꾸지 마라 — 고유 크기가 1px 이라 `max-width:100%`/`max-height:340px` 아래에서
 * **1px 로 그려진다**. 그러면 본문이 넘치질 않아 이 파일의 계약 절반이 "넘치는 상황"을 못 만들고
 * 조용히 통과한다(실제로 처음에 그렇게 짰다가 4건이 거짓으로 실패·통과했다).
 */
const HERO_ASSET = "public/notice/hero-kyeongnicius.webp";

/**
 * 라이브 문안을 그대로 쓴다(#292 운영 반영분). 지어낸 짧은 더미로 재면 **실제로 접히는 길이**를
 * 못 잡는다 — 이 계약이 막으려는 건 "이 공지가 잘려 보인다"이지 "긴 글은 스크롤된다"가 아니다.
 */
const KYEONGNICIUS = `![경니시우스](/notice/hero-kyeongnicius.webp)

**LEGEND** 등급 공격수. 최전방에서 버티고, 달리고, 동료를 살립니다.

피지컬 **95**. 패스 **94**. 스피드 **93**.

- 등지고 받아 내주는 연계 — 최전방의 기준점
- 슈팅 90 · 태클 90 — 마무리도, 전방 압박도
- 포지셔닝 80 — 자리를 잡아주는 미드필더와 함께

지금 상점에서 만나보세요.`;

const PATCH = `**이번 업데이트**

- **원정** — 실제 유저 팀과 대전하고 승패로 레이팅이 오르내립니다.
- **리그 디비전** — 시즌 성적에 따라 디비전이 바뀌고, 시즌 종료 시 순위 보상을 드립니다.
- **지시 화면 개편** — 덱·경기 전 브리핑·감독시간에서 팀 지시와 선수별 지시를 한 화면에서 작성합니다.
- **감독시간 3분** — 하프타임에 교체와 후반 지시를 여유 있게 준비하실 수 있습니다.
- **잠재능력 다이스** — 이제 미리 구매하지 않고, 굴릴 때 보유 재화에서 바로 결제됩니다.
- 재화 표기가 **골드 G · 다이아 Z** 로 통일됐습니다.

즐거운 시즌 되세요!`;

function notice(id: string, title: string, body: string, priority: number) {
  return { id, revision: 1, title, body, startsAt: null, endsAt: null, priority };
}

/** 운영에 반영할 **2장 분리** 상태 — 경니시우스가 앞. */
const SPLIT = {
  notices: [
    notice("N-KYEONG", "경니시우스 합류!", KYEONGNICIUS, 10),
    notice("N-PATCH", "업데이트 안내 — 원정·시즌 보상·강화 개선", PATCH, 5),
  ],
};

/** 분리 전 상태 — 두 문안이 한 장에 들어 있던 라이브 본문. */
const MERGED = {
  notices: [notice("N-MERGED", "경니시우스 합류!", `${KYEONGNICIUS}\n\n${PATCH}`, 5)],
};

interface Options {
  /** 히어로 이미지 응답을 지연시킨다 — 늦게 온 이미지가 높이를 바꾸는 경로 검증용. */
  imageDelayMs?: number;
}

async function mockLobby(page: Page, payload: unknown, options: Options = {}) {
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page);
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: { id: "u1", nickname: "감독님", tutorialDone: true },
        wallet: { points: 62000, gems: 120 },
        records: { wins: 3, draws: 1, losses: 2 },
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json({ match: null, locked: false, abandonable: false })),
  );
  await page.route((url) => url.pathname === "/api/me/away-reports", (route) =>
    route.fulfill(json({ reports: [], summary: null, rating: 1200, unseen: 0 })),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/notices/active", (route) =>
    route.fulfill(json(payload)),
  );
  // 지연이 필요할 때만 가로챈다 — 평소엔 vite 가 `public/` 에서 그대로 서빙한다.
  if (options.imageDelayMs) {
    await page.route(
      (url) => url.pathname === "/notice/hero-kyeongnicius.webp",
      async (route) => {
        await new Promise((r) => setTimeout(r, options.imageDelayMs));
        await route.fulfill({ status: 200, contentType: "image/webp", path: HERO_ASSET });
      },
    );
  }
}

async function openLobby(page: Page) {
  await page.goto("/lobby");
  await expect(page.getByTestId("notice-popup")).toBeVisible();
}

/** 본문 스크롤러의 실측치 — 계산이 아니라 **브라우저가 배치한 결과**를 읽는다. */
async function bodyMetrics(page: Page) {
  return page.getByTestId("notice-body").evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
  }));
}

/** 버튼이 첫 화면에 있는가 + 문서가 가로로 밀렸는가 — 본문을 키운 대가를 재는 자리. */
async function chromeIntact(page: Page) {
  const vh = page.viewportSize()!.height;
  const box = await page.getByTestId("notice-dismiss-24h").boundingBox();
  return {
    lastButtonBottom: (box?.y ?? 0) + (box?.height ?? 0),
    viewportHeight: vh,
    docOverflowX: await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  };
}

test.use({ viewport: { width: 390, height: 844 } });

// ─────────────────────────────────────────────────────────────────────────────
// ① 접을 이유가 없으면 접지 않는다
// ─────────────────────────────────────────────────────────────────────────────

test.describe("#292 — 본문을 이유 없이 접지 않는다", () => {
  /**
   * ⚠️ **변이체 킬 대상 ①.** `.body` 에 `max-height: 46vh` 를 되돌리면 여기가 죽는다.
   *
   * 고치기 전 실동작: 화면에 200px 넘게 남는데도 본문이 388px 로 묶여, 경니시우스 장(529px)의
   * **141px — 스탯 세 줄과 클로징 —** 이 잘려 있었다. 이 공지는 접힐 이유가 없다.
   */
  test("경니시우스 장은 390×844 에서 스크롤 없이 통째로 보인다", async ({ page }) => {
    await mockLobby(page, SPLIT);
    await openLobby(page);
    await expect(page.getByTestId("notice-title")).toHaveText("경니시우스 합류!");

    const m = await bodyMetrics(page);
    expect(m.scrollHeight, "본문이 스크롤 영역을 넘지 않는다").toBeLessThanOrEqual(m.clientHeight + 1);
    // 실제로 마지막 문장이 화면 안에 있다 — 높이 숫자만 맞고 글이 잘려 있으면 의미가 없다.
    await expect(page.getByTestId("notice-body")).toContainText("지금 상점에서 만나보세요.");
    await expect(page.getByTestId("notice-body-area")).toHaveAttribute("data-more", "false");
  });

  /**
   * ⚠️ **변이체 킬 대상 ②.** `.stack` 의 `display:flex` 를 지우면 여기가 죽는다.
   *
   * 높이가 auto 인 부모에 걸린 `.card { max-height: 100% }` 는 퍼센트가 `none` 으로 풀려
   * **카드가 화면 밖으로 자란다**. 그동안은 본문의 `46vh` 가 그 사실을 가려 주고 있었을 뿐이라,
   * 본문을 "남는 만큼" 쓰게 바꾸는 순간 24시간 버튼이 화면 아래로 나간다.
   */
  test("합본(긴 공지)이어도 두 버튼이 첫 화면 안에 있다", async ({ page }) => {
    await mockLobby(page, MERGED);
    await openLobby(page);

    const m = await bodyMetrics(page);
    expect(m.scrollHeight, "이 공지는 실제로 넘친다(전제)").toBeGreaterThan(m.clientHeight);

    const chrome = await chromeIntact(page);
    expect(chrome.lastButtonBottom).toBeGreaterThan(0);
    expect(chrome.lastButtonBottom, "24시간 버튼이 화면 밖으로 밀리지 않는다").toBeLessThanOrEqual(
      chrome.viewportHeight,
    );
    expect(chrome.docOverflowX, "가로로 밀리지 않는다").toBe(0);
  });

  /**
   * 본문 높이가 **뷰포트를 따라온다**는 성질. `46vh` 같은 고정 비율이면 이 비교도 통과하므로
   * 위 두 테스트와 **함께** 읽어야 한다(여기 단독으로는 변이체를 못 죽인다 — 의도한 역할 분담).
   */
  test("화면이 커지면 본문 영역도 커진다", async ({ page }) => {
    await mockLobby(page, MERGED);
    await openLobby(page);
    const short = (await bodyMetrics(page)).clientHeight;

    await page.setViewportSize({ width: 390, height: 900 });
    await expect
      .poll(async () => (await bodyMetrics(page)).clientHeight)
      .toBeGreaterThan(short);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 접혔으면 접혔다고 보인다
// ─────────────────────────────────────────────────────────────────────────────

test.describe("#292 — 더 있으면 더 있다고 보인다", () => {
  test.use({ viewport: { width: 390, height: 667 } });

  /**
   * ⚠️ **변이체 킬 대상 ③.** `data-more` 를 상수로 바꾸면 죽는다 — `true` 고정이면 "끝에 닿으면
   * 꺼진다"가, `false` 고정이면 "넘치면 켜진다"가 깨진다. **양방향**이라 한쪽만 박아도 안 통과한다.
   *
   * 신호가 꺼지는 것이 켜지는 것만큼 중요하다: 다 읽었는데도 그라데이션이 남아 있으면
   * 그 자체가 "아직 더 있다"는 거짓말이라 유저가 없는 내용을 찾는다.
   */
  test("짧은 화면에서 넘치면 켜지고, 끝까지 내리면 꺼진다", async ({ page }) => {
    await mockLobby(page, SPLIT);
    await openLobby(page);

    const area = page.getByTestId("notice-body-area");
    const m = await bodyMetrics(page);
    expect(m.scrollHeight, "이 화면에서는 실제로 넘친다(전제)").toBeGreaterThan(m.clientHeight);
    await expect(area).toHaveAttribute("data-more", "true");

    await page.getByTestId("notice-body").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(area, "끝에 닿으면 신호가 꺼진다").toHaveAttribute("data-more", "false");

    // 되돌아 올라오면 다시 켜진다 — 한 번 꺼지고 마는 래치가 아니다.
    await page.getByTestId("notice-body").evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(area).toHaveAttribute("data-more", "true");
  });

  /**
   * ⚠️ **변이체 킬 대상 ④.** 마운트 시 한 번만 재고 마는 구현(ResizeObserver·load 재측정 제거)이면
   * 죽는다. 공지 본문은 **이미지가 늦게 온다** — 로드 전 높이로 판단하면 히어로 이미지가 도착해
   * 본문이 두 배가 되어도 화면엔 아무 신호가 없다. 실제 라이브 공지가 정확히 그 모양이다.
   */
  test("늦게 도착한 이미지가 본문을 늘리면 그때 신호가 붙는다", async ({ page }) => {
    await mockLobby(page, SPLIT, { imageDelayMs: 900 });
    await openLobby(page);

    // 이미지가 오기 전 — 텍스트만으로는 이 화면에 다 들어간다.
    await expect(page.getByTestId("notice-body-area")).toHaveAttribute("data-more", "false");
    // 이미지가 도착해 높이가 늘면 신호가 붙는다.
    await expect(page.getByTestId("notice-image")).toBeVisible();
    await expect(page.getByTestId("notice-body-area")).toHaveAttribute("data-more", "true");
  });

  test("짧은 화면에서도 두 버튼은 첫 화면 안에 있다", async ({ page }) => {
    await mockLobby(page, SPLIT);
    await openLobby(page);

    const chrome = await chromeIntact(page);
    expect(chrome.lastButtonBottom).toBeGreaterThan(0);
    expect(chrome.lastButtonBottom).toBeLessThanOrEqual(chrome.viewportHeight);
    expect(chrome.docOverflowX).toBe(0);
  });

  /** 넘치지 않는 장에는 신호가 없다 — 장을 넘겨도 상태가 이월되지 않는다. */
  test("2장으로 넘어가면 그 장 기준으로 다시 판정한다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockLobby(page, SPLIT);
    await openLobby(page);
    await expect(page.getByTestId("notice-pager")).toHaveText("1 / 2");

    await page.getByTestId("notice-close").click();
    await expect(page.getByTestId("notice-pager")).toHaveText("2 / 2");
    const m = await bodyMetrics(page);
    expect(m.scrollHeight, "패치 장은 이 화면에 다 들어간다").toBeLessThanOrEqual(m.clientHeight + 1);
    await expect(page.getByTestId("notice-body-area")).toHaveAttribute("data-more", "false");
    await expect(page.getByTestId("notice-body")).toContainText("즐거운 시즌 되세요!");
  });
});
