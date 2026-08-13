import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * `/event-board` route-mock E2E (에픽 #492 AC6).
 *
 * server-java 세션이 `/api/admin/events*` 를 **병렬로** 만드는 중이라, 여기서는 백엔드 없이
 * vite dev + `page.route` 로 **§Plan D3 동결 계약**을 그대로 목킹해 web 측 계약을 박제한다.
 *
 * ⚠️ 라우트 매칭은 **pathname 술어**로 한다. glob(`**\/api\/**`)은 vite 소스 `/src/api/*.ts` 까지
 *    잡아 모듈 로딩을 깨고 흰 화면이 된다(프로젝트 기지식 · `p3-admin-mock.spec.ts:10-11`).
 * ⚠️ **catch-all 을 먼저 등록**한다 — Playwright 는 나중에 등록한 핸들러가 이긴다.
 *
 * ── 목이 곧 계약이다 (#342 의 교훈) ─────────────────────────────────────────
 * 예전 admin 목은 서버가 주지 않는 모양(`{users:[…]}`·`recentLedger`)을 줬고, 그 거짓 덕에
 * **라이브에서 화면이 통째로 비어 있는데도** e2e 가 green 이었다. 그래서 이 파일은
 * ① 아래 KEYS 상수로 **응답 키 집합을 명시적으로 박고**
 * ② 테스트 (e) 가 목 페이로드가 그 키 집합과 정확히 일치함을 단언하며
 * ③ 목 페이로드 원본을 `.p492/mock-contract.json` 으로 떨궈 **실서버 curl 과 나중에 대조**한다.
 */

// ─────────── §2 동결 계약 (이슈 #492 §Plan D3 + §Plan 확정 D6) ───────────
//
// GET /api/admin/events?event=&userId=&limit=&offset=
//   → { items:[{id,event,userId,nickname,occurredAt,props}], total, limit, offset }
//     · props 는 **파싱된 객체**(문자열 아님) · 정렬 최신순 · limit 기본 50 / 최대 200
// GET /api/admin/events/funnel
//   → { generatedAt, users:[{userId,nickname,firstSeenAt,lastSeenAt,
//        reached:{signup,tutorial,deck,gacha,practice,league,away},matchesFinished,eventCount}] }
//     · 정렬 lastSeenAt DESC
const EVENT_PAGE_KEYS = ["items", "total", "limit", "offset"] as const;
const EVENT_ITEM_KEYS = ["id", "event", "userId", "nickname", "occurredAt", "props"] as const;
const FUNNEL_KEYS = ["generatedAt", "users"] as const;
const FUNNEL_USER_KEYS = [
  "userId",
  "nickname",
  "firstSeenAt",
  "lastSeenAt",
  "reached",
  "matchesFinished",
  "eventCount",
] as const;
const FUNNEL_REACHED_KEYS = [
  "signup",
  "tutorial",
  "deck",
  "gacha",
  "practice",
  "league",
  "away",
] as const;
/** 기록되는 이벤트 7종 (#492 D1). */
const EVENT_TYPES = [
  "user_signup",
  "tutorial_complete",
  "deck_save",
  "gacha_pull",
  "match_start",
  "match_finish",
  "league_season_start",
] as const;

const CAPTURE_DIR = ".p492/";

interface EventItem {
  id: string;
  event: string;
  userId: string;
  nickname: string;
  occurredAt: string;
  props: Record<string, unknown>;
}

interface FunnelUser {
  userId: string;
  nickname: string;
  firstSeenAt: string;
  lastSeenAt: string;
  reached: Record<(typeof FUNNEL_REACHED_KEYS)[number], boolean>;
  matchesFinished: number;
  eventCount: number;
}

interface MockState {
  isAdmin: boolean;
  /** true 면 admin API 만 403 — 클라 가드를 우회해 들어온 상황(서버 게이트). */
  forbidAdminApi: boolean;
  events: EventItem[];
  funnel: { generatedAt: string; users: FunnelUser[] };
  /** 서버가 실제로 받은 쿼리 — 필터가 서버로 나가는지 검사한다(클라 필터링이 아님). */
  seenQueries: string[];
}

/** 목 이벤트 생성 — 최신순(occurredAt DESC)으로 만든다(서버 정렬 계약과 같은 순서). */
function buildEvents(): EventItem[] {
  const items: EventItem[] = [];
  const push = (
    userId: string,
    nickname: string,
    event: string,
    minute: number,
    props: Record<string, unknown>,
  ) => {
    const mm = String(minute).padStart(2, "0");
    items.push({
      id: `E${String(items.length + 1).padStart(3, "0")}`,
      event,
      userId,
      nickname,
      occurredAt: `2026-08-10T0${Math.floor(minute / 60)}:${mm}:00Z`,
      props,
    });
  };

  // u1(심사위원A) — 원정까지 간 유저.
  push("u1", "심사위원A", "match_finish", 58, {
    mode: "away",
    matchId: "M9",
    result: "WIN",
    goalsFor: 3,
    goalsAgainst: 1,
    pointsAwarded: 30,
  });
  push("u1", "심사위원A", "match_start", 55, { mode: "away", matchId: "M9", defenderId: "u2" });
  push("u1", "심사위원A", "league_season_start", 50, { seasonId: "S1", seasonNo: 1, division: 10 });
  push("u1", "심사위원A", "gacha_pull", 45, {
    kind: "ten",
    count: 11,
    cost: 3000,
    currency: "POINT",
    grades: ["SILVER", "GOLD"],
  });
  push("u1", "심사위원A", "deck_save", 40, {
    source: "deck",
    formation: "4-3-3",
    slotCount: 13,
    created: true,
  });
  push("u1", "심사위원A", "tutorial_complete", 35, { grantedDeck: true });
  push("u1", "심사위원A", "user_signup", 30, { provider: "local", nickname: "심사위원A" });

  // u2(심사위원B) — 연습까지만.
  push("u2", "심사위원B", "match_start", 25, { mode: "practice", matchId: "M2", botId: "B3" });
  push("u2", "심사위원B", "deck_save", 20, { source: "preset", formation: "4-4-2", slotCount: 13 });
  push("u2", "심사위원B", "user_signup", 15, { provider: "mock-oauth", nickname: "심사위원B" });

  // 페이저를 실제로 태우기 위한 벌크(총 57건 = 2페이지: 50 + 7).
  for (let i = 0; i < 47; i += 1) {
    push("u3", "심사위원C", "match_start", 14 - Math.floor(i / 10), {
      mode: "practice",
      matchId: `MB${i}`,
      botId: "B1",
    });
  }
  return items;
}

function buildFunnel(): MockState["funnel"] {
  return {
    generatedAt: "2026-08-10T01:00:00Z",
    // ⚠️ 정렬은 **서버 몫**(lastSeenAt DESC) — 목도 그 순서로 준다. 화면은 재정렬하지 않는다.
    users: [
      {
        userId: "u1",
        nickname: "심사위원A",
        firstSeenAt: "2026-08-10T00:30:00Z",
        lastSeenAt: "2026-08-10T00:58:00Z",
        reached: {
          signup: true,
          tutorial: true,
          deck: true,
          gacha: true,
          practice: false,
          league: true,
          away: true,
        },
        matchesFinished: 1,
        eventCount: 7,
      },
      {
        userId: "u2",
        nickname: "심사위원B",
        firstSeenAt: "2026-08-10T00:15:00Z",
        lastSeenAt: "2026-08-10T00:25:00Z",
        reached: {
          signup: true,
          tutorial: false,
          deck: true,
          gacha: false,
          practice: true,
          league: false,
          away: false,
        },
        matchesFinished: 0,
        eventCount: 3,
      },
      {
        userId: "u3",
        nickname: "심사위원C",
        firstSeenAt: "2026-08-10T00:10:00Z",
        lastSeenAt: "2026-08-10T00:14:00Z",
        reached: {
          signup: false,
          tutorial: false,
          deck: false,
          gacha: false,
          practice: true,
          league: false,
          away: false,
        },
        matchesFinished: 0,
        eventCount: 47,
      },
    ],
  };
}

function freshState(): MockState {
  return {
    isAdmin: true,
    forbidAdminApi: false,
    events: buildEvents(),
    funnel: buildFunnel(),
    seenQueries: [],
  };
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const forbidden = () =>
  json({ code: "FORBIDDEN", message: "운영자 전용 API 입니다", detail: null }, 403);

async function mockApi(page: Page, state: MockState) {
  // catch-all 먼저 — 구체 라우트는 뒤에 등록해야 이긴다.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );

  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          // isAdmin 은 additive — 비admin 케이스에선 **필드 자체를 넣지 않는다**(부재=비admin).
          user: state.isAdmin
            ? { id: "u9", nickname: "관리자", isAdmin: true }
            : { id: "u2", nickname: "심사위원B" },
          wallet: { points: 100 },
          records: { wins: 0, draws: 0, losses: 0 },
        }),
      ),
  );

  await page.route(
    (url) => url.pathname === "/api/admin/events/funnel",
    (route) => {
      if (state.forbidAdminApi) return route.fulfill(forbidden());
      return route.fulfill(json(state.funnel));
    },
  );

  await page.route(
    (url) => url.pathname === "/api/admin/events",
    (route) => {
      if (state.forbidAdminApi) return route.fulfill(forbidden());
      const url = new URL(route.request().url());
      state.seenQueries.push(url.search);
      const p = url.searchParams;
      const event = p.get("event");
      const userId = p.get("userId");

      // 미지 event → 400 (서버 계약). 목이 관대하면 화면이 잘못된 값을 보내도 모른다.
      if (event && !(EVENT_TYPES as readonly string[]).includes(event)) {
        return route.fulfill(
          json({ code: "VALIDATION_ERROR", message: "unknown event", detail: null }, 400),
        );
      }

      const limit = Math.min(200, Math.max(1, Number(p.get("limit") ?? 50)));
      const offset = Math.max(0, Number(p.get("offset") ?? 0));
      const filtered = state.events.filter(
        (e) => (!event || e.event === event) && (!userId || e.userId === userId),
      );
      return route.fulfill(
        json({
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        }),
      );
    },
  );
}

async function seedToken(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
}

test.describe("#492 이벤트 보드 (route-mock)", () => {
  test("(a) admin: 퍼널 그리드 + 스트림 표 + 필터 동작", async ({ page }) => {
    const state = freshState();
    await mockApi(page, state);
    await seedToken(page);

    await page.goto("/event-board");
    await expect(page.getByTestId("event-board-page")).toBeVisible();

    // ── ① 퍼널 그리드: 유저 1행 × 단계 7컬럼 ──────────────────────────
    await expect(page.getByTestId("event-funnel-table")).toBeVisible();
    for (const uid of ["u1", "u2", "u3"]) {
      await expect(page.getByTestId(`funnel-row-${uid}`)).toBeVisible();
    }
    // 서버 정렬(lastSeenAt DESC)을 화면이 그대로 유지한다 — 재정렬하면 이 순서가 깨진다.
    const order = await page
      .locator('[data-testid^="funnel-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(order).toEqual(["funnel-row-u1", "funnel-row-u2", "funnel-row-u3"]);

    // 단계 7칸이 행마다 있고, 도달/미도달이 값으로 구분된다.
    for (const stage of FUNNEL_REACHED_KEYS) {
      await expect(page.getByTestId(`funnel-cell-u1-${stage}`)).toBeVisible();
    }
    await expect(page.getByTestId("funnel-cell-u1-away")).toHaveAttribute("data-reached", "true");
    await expect(page.getByTestId("funnel-cell-u1-practice")).toHaveAttribute(
      "data-reached",
      "false",
    );
    await expect(page.getByTestId("funnel-cell-u2-away")).toHaveAttribute("data-reached", "false");

    // "어디까지 갔나" — 연속 도달을 가정하지 않는다(u1 은 practice 를 건너뛰고 away 까지).
    await expect(page.getByTestId("funnel-furthest-u1")).toHaveText("원정까지");
    await expect(page.getByTestId("funnel-furthest-u2")).toHaveText("연습까지");

    // ── ② 스트림 표 ────────────────────────────────────────────────
    await expect(page.getByTestId("event-stream-table")).toBeVisible();
    await expect(page.getByTestId("event-row-E001")).toContainText("경기 종료");
    // props 는 파싱된 객체 → 요약이 키=값으로 읽힌다.
    await expect(page.getByTestId("event-row-E001")).toContainText("mode=away");
    await expect(page.getByTestId("event-row-E001")).toContainText("result=WIN");
    await expect(page.getByTestId("event-page-range")).toHaveText("1–50 / 57");

    // ── ③ 종류 필터 — 서버로 나간다(클라 필터링이 아니다) ─────────────
    state.seenQueries.length = 0;
    await page.getByTestId("event-filter-type").selectOption("gacha_pull");
    await expect(page.getByTestId("event-row-E004")).toBeVisible();
    await expect(page.getByTestId("event-row-E001")).toHaveCount(0);
    await expect(page.getByTestId("event-page-range")).toHaveText("1–1 / 1");
    expect(state.seenQueries.some((q) => q.includes("event=gacha_pull"))).toBe(true);
    // 필터가 바뀌면 offset 은 0 으로 되돌아간다(3페이지에서 필터를 바꾸면 빈 화면이 뜬다).
    expect(state.seenQueries.every((q) => q.includes("offset=0"))).toBe(true);

    // ── ④ 퍼널 행 클릭 → 그 유저로 좁힌 스트림 ────────────────────────
    await page.getByTestId("event-filter-reset").click();
    await page.getByTestId("funnel-select-u2").click();
    await expect(page.getByTestId("event-filter-user")).toHaveValue("u2");
    await expect(page.getByTestId("event-row-E008")).toBeVisible(); // u2 의 match_start
    await expect(page.getByTestId("event-row-E001")).toHaveCount(0); // u1 이벤트는 사라진다
    await expect(page.getByTestId("event-page-range")).toHaveText("1–3 / 3");

    // ── ⑤ 페이저 — total 기준(items 길이가 아니다) ────────────────────
    await page.getByTestId("event-filter-reset").click();
    await expect(page.getByTestId("event-page-range")).toHaveText("1–50 / 57");
    await expect(page.getByTestId("event-page-prev")).toBeDisabled();
    await page.getByTestId("event-page-next").click();
    await expect(page.getByTestId("event-page-range")).toHaveText("51–57 / 57");
    await expect(page.getByTestId("event-page-next")).toBeDisabled();
    await expect(page.getByTestId("event-page-prev")).toBeEnabled();

    mkdirSync(CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: `${CAPTURE_DIR}p492-desktop.png`, fullPage: true });

    // admin 진입점 = 하단탭 [운영] 1칸 + 화면 상단 서브탭 (#498 안 A).
    // ⚠️ 예전엔 `nav-events` 를 봤다. #498 이 8칸(320px 40.0px < 44pt)을 7칸으로 되돌리며
    //    이벤트 보드 칸을 없앴다 — 그 칸이 서브탭으로 왔는지를 여기서 본다.
    await expect(page.getByTestId("nav-events")).toHaveCount(0);
    await expect(page.getByTestId("nav-admin").first()).toBeAttached();
    await expect(page.getByTestId("admin-subnav-events")).toHaveAttribute("aria-current", "page");
    // 하단탭 활성 표시는 [운영] 에 남는다(어느 탭도 안 켜지면 길을 잃는다).
    await expect(page.getByTestId("nav-admin").first()).toHaveAttribute("aria-current", "page");
  });

  test("(b) 비admin 토큰으로 /event-board 직접 진입 → /home, admin DOM 0", async ({ page }) => {
    const state = freshState();
    state.isAdmin = false; // /api/me 에 isAdmin 필드 없음
    await mockApi(page, state);
    await seedToken(page);

    await page.goto("/event-board");
    await page.waitForURL("**/home");
    await expect(page.getByTestId("event-board-page")).toHaveCount(0);
    await expect(page.getByTestId("event-funnel-table")).toHaveCount(0);
    await expect(page.getByTestId("event-stream-table")).toHaveCount(0);
    // 네비 진입점도 비admin 에겐 DOM 에 없다 — 서브탭까지(#498: 그 화면 자체가 안 뜬다).
    await expect(page.getByTestId("nav-events")).toHaveCount(0);
    await expect(page.getByTestId("nav-admin")).toHaveCount(0);
    await expect(page.getByTestId("admin-subnav")).toHaveCount(0);
  });

  test("(c) 미로그인 상태로 /event-board → /login", async ({ page }) => {
    await mockApi(page, freshState());
    await page.goto("/event-board");
    await page.waitForURL("**/login");
    await expect(page.getByTestId("event-board-page")).toHaveCount(0);
  });

  test("(d) 서버 403 → 배너 노출 후 /home", async ({ page }) => {
    const state = freshState();
    state.isAdmin = true; // 클라 가드는 통과 — 서버 게이트만 거부(가드 우회 상황)
    state.forbidAdminApi = true;
    await mockApi(page, state);
    await seedToken(page);

    await page.goto("/event-board");
    await expect(page.getByTestId("event-board-forbidden")).toBeVisible();
    // 운영 데이터는 한 조각도 그리지 않는다.
    await expect(page.getByTestId("event-funnel-table")).toHaveCount(0);
    await expect(page.getByTestId("event-stream-table")).toHaveCount(0);

    mkdirSync(CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: `${CAPTURE_DIR}p492-forbidden.png`, fullPage: true });

    await page.waitForURL("**/home");
  });

  test("(e) 목 페이로드 = §2 동결 계약과 동형 + 모바일 가로 오버플로 0", async ({ page }) => {
    const state = freshState();

    // ── 목 자체를 검사한다 ─────────────────────────────────────────
    // 목이 계약보다 관대하거나 인색하면 "화면은 green 인데 라이브는 빈 화면"이 된다(#342).
    // 이 단언들이 그 드리프트를 커밋 전에 죽인다. 실서버 curl 대조용 원본은 아래에서 덤프한다.
    const page1 = {
      items: state.events.slice(0, 50),
      total: state.events.length,
      limit: 50,
      offset: 0,
    };
    expect(Object.keys(page1).sort()).toEqual([...EVENT_PAGE_KEYS].sort());
    for (const item of page1.items) {
      expect(Object.keys(item).sort()).toEqual([...EVENT_ITEM_KEYS].sort());
      // props 는 **파싱된 객체**다 — 문자열이면 계약 위반.
      expect(typeof item.props).toBe("object");
      expect(Array.isArray(item.props)).toBe(false);
      expect(typeof item.occurredAt).toBe("string");
      // 정렬은 최신순(occurredAt DESC).
    }
    const stamps = page1.items.map((i) => i.occurredAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    // 7종이 모두 표본에 있다 — 한 종류라도 빠지면 그 렌더 경로가 검사되지 않는다.
    const kinds = new Set(state.events.map((e) => e.event));
    for (const t of EVENT_TYPES) expect(kinds.has(t)).toBe(true);

    expect(Object.keys(state.funnel).sort()).toEqual([...FUNNEL_KEYS].sort());
    for (const u of state.funnel.users) {
      expect(Object.keys(u).sort()).toEqual([...FUNNEL_USER_KEYS].sort());
      expect(Object.keys(u.reached).sort()).toEqual([...FUNNEL_REACHED_KEYS].sort());
      expect(Object.values(u.reached).every((v) => typeof v === "boolean")).toBe(true);
      expect(typeof u.matchesFinished).toBe("number");
      expect(typeof u.eventCount).toBe("number");
    }
    // 서버 정렬 계약(lastSeenAt DESC)을 목도 지킨다.
    const seen = state.funnel.users.map((u) => u.lastSeenAt);
    expect([...seen].sort().reverse()).toEqual(seen);

    // 실서버 curl 과 대조할 원본 덤프(gitignore, QA 증적).
    mkdirSync(CAPTURE_DIR, { recursive: true });
    writeFileSync(
      `${CAPTURE_DIR}mock-contract.json`,
      JSON.stringify(
        {
          note: "#492 AC6 — web e2e 목 페이로드. 실서버 curl 응답과 키 집합/타입을 대조할 것.",
          "GET /api/admin/events?limit=50&offset=0": page1,
          "GET /api/admin/events/funnel": state.funnel,
          contractKeys: {
            eventPage: EVENT_PAGE_KEYS,
            eventItem: EVENT_ITEM_KEYS,
            funnel: FUNNEL_KEYS,
            funnelUser: FUNNEL_USER_KEYS,
            funnelReached: FUNNEL_REACHED_KEYS,
            eventTypes: EVENT_TYPES,
          },
        },
        null,
        2,
      ),
    );

    // ── 모바일 실화면: 가로 오버플로 0 ───────────────────────────────
    await mockApi(page, state);
    await seedToken(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/event-board");
    await expect(page.getByTestId("event-funnel-table")).toBeVisible();
    await expect(page.getByTestId("event-stream-table")).toBeVisible();

    // 퍼널 그리드는 12열이라 **자기 컨테이너 안에서만** 가로 스크롤해야 한다.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.screenshot({ path: `${CAPTURE_DIR}p492-mobile-390.png`, fullPage: true });
  });
});
