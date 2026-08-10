import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";
import { skipSplash } from "./splash-mock";

/**
 * #386 공용 목 — **라이브 공지를 그대로** 쓴다.
 *
 * ⚠️ 지어낸 짧은 더미로 재지 마라(#292 가 같은 실수를 했다). 이 이슈가 다루는 것은
 * "긴 글이 스크롤되는가"가 아니라 **실제 운영 중인 오시야스 공지가 폰에서 읽히는가**다.
 * 본문·히어로 이미지(1080×1180)의 **실제 크기**가 곧 재현 조건이다.
 *
 * ⚠️ 라우트 매칭은 glob 이 아니라 **pathname 술어**로 한다 — glob 은 vite 소스(/src/api/*.ts)까지
 * 잡아 모듈 로딩을 깨고 흰 화면이 된다(프로젝트 기지식).
 */

export const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** 라이브 `GET /api/notices/active` 응답(2026-08-01 수집) 그대로. */
export const LIVE_NOTICE = {
  notices: [
    {
      id: "01KYSPMF7SEMJA7K98D5ZMGYBX",
      revision: 1,
      title: "오시야스 합류!",
      body: `![오시야스](/api/notices/assets/01KYS71M3DHHP6J1SY52M69X9E)

**LEGEND** 등급 골키퍼. 마지막 순간에 골문 앞에 서 있는 선수입니다.

위치선정 **95**. 피지컬 **95**. 태클 **94**.

- **첫 LEGEND 골키퍼** — 그동안 골문에는 레전드가 없었습니다
- 능력치 총합 **822** — 지금 만날 수 있는 선수 165명 중 **1위**
- 스피드 91 · 기술 89 · 지구력 89 — 골문 밖으로 나와서도 버팁니다

지금 상점에서 만나보세요.`,
      startsAt: null,
      endsAt: "2026-08-06T14:25:05Z",
      priority: 10,
    },
  ],
};

/**
 * 라이브 히어로 이미지 **실바이트**(`/api/notices/assets/…`, 1080×1180 webp).
 *
 * ⚠️ 더미 1×1 PNG 로 바꾸지 마라 — 고유 크기가 1px 이라 `max-width:100%` 아래에서 1px 로 그려져
 * **본문이 넘치는 상황 자체가 안 만들어진다**(#292 가 실제로 그렇게 절반이 공허해졌다).
 */
const HERO_BYTES = readFileSync(new URL("./fixtures/p386-hero-osiyasu.webp", import.meta.url));

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

const POSITIONS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW"] as const;

export const PLAYERS = POSITIONS.map((position, i) => ({
  id: `P${i}`, name: `선수${i}`, position, grade: "SILVER",
  owned: true, ownedCount: 1, attributes: attrs(70), personality: "CALM",
}));

const DECK = {
  id: "d1",
  formation: "4-3-3",
  slots: PLAYERS.map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i, promptText: null })),
};

export interface NoticeMockState {
  /** `POST /api/me/tutorial-complete` 호출 수 — "완료가 서버에 저장됐나"의 측정점. */
  completeCalls: number;
  tutorialDone: boolean;
}

/**
 * 신규 유저 실플로우를 그릴 수 있는 목 한 벌.
 *
 * `tutorialDone: false`(기본) = **아직 온보딩을 안 마친 계정**. 완료 호출이 오면 서버처럼
 * 플래그를 세우고 덱을 만든다(#209) — 그래야 "리로드하면 코치마크가 또 도나"를 진짜로 잰다.
 */
export async function mockNoticeWorld(
  page: Page,
  opts: { tutorialDone?: boolean; notices?: unknown } = {},
): Promise<NoticeMockState> {
  const st: NoticeMockState = { completeCalls: 0, tutorialDone: opts.tutorialDone ?? false };
  let deckExists = st.tutorialDone;

  // 캐치올 먼저 — Playwright 는 나중에 등록한 핸들러가 이긴다.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page);

  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({
      user: { id: "u1", nickname: "신규감독", tutorialDone: st.tutorialDone },
      wallet: { points: 3000, gems: 0 },
      records: { wins: 0, draws: 0, losses: 0 },
    })),
  );
  await page.route((url) => url.pathname === "/api/auth/register", (route) =>
    route.fulfill(json({ token: "tok_new", user: { id: "u1", nickname: "신규감독" }, isNew: true })),
  );
  await page.route((url) => url.pathname === "/api/me/starter-grant", (route) =>
    route.fulfill(json({
      granted: true,
      player: { ...PLAYERS[0]!, id: "P005", name: "오시야스", grade: "LEGEND" },
    })),
  );
  await page.route((url) => url.pathname === "/api/me/tutorial-complete", (route) => {
    st.completeCalls += 1;
    st.tutorialDone = true;
    deckExists = true;
    return route.fulfill(json({ tutorialDone: true, deckGranted: true, deck: DECK }));
  });
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/deck", (route) =>
    deckExists
      ? route.fulfill(json(DECK))
      : route.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404)),
  );
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json({ match: null, locked: false, abandonable: false })),
  );
  await page.route((url) => url.pathname === "/api/me/away-reports", (route) =>
    route.fulfill(json({ reports: [], summary: null, rating: 1200, unseen: 0 })),
  );
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    route.fulfill(json(Object.fromEntries(PLAYERS.map((p) => [p.id, 0.7])))),
  );
  await page.route((url) => url.pathname === "/api/notices/active", (route) =>
    route.fulfill(json(opts.notices ?? LIVE_NOTICE)),
  );
  await page.route((url) => url.pathname.startsWith("/api/notices/assets/"), (route) =>
    route.fulfill({ status: 200, contentType: "image/webp", body: HERO_BYTES }),
  );
  return st;
}

/** 로컬 가입(`isNew`) → 스타터팩 공개 → 홈 착지. 신규 유저의 **실제 첫 동선**. */
export async function registerNewUser(page: Page): Promise<void> {
  await skipSplash(page);
  await page.goto("/login");
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-mode-toggle").click();
  await page.getByTestId("local-nickname").fill("newbie386");
  await page.getByTestId("local-password").fill("sup3rs3cret");
  await page.getByTestId("local-submit").click();
  await page.getByTestId("starter-reveal-card").click();
  await page.getByTestId("starter-reveal-close").click();
  // #493 W1: 신규 가입 착지가 미니게임(/welcome)이 됐다 — 건너뛰어 홈에 내린다(이 헬퍼의 호출부는
  // 전부 "홈에 도착한 신규 유저"를 전제한다).
  await page.getByTestId("minigame-skip").click();
}

/** 이미 토큰이 있는(=온보딩 마친) 유저로 바로 홈에 들어간다. */
export async function seedToken(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
}
