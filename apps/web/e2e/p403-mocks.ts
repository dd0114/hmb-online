import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #403 W2 — (A) 선수 탭 스펙과 (B) 피치 터치 스펙이 **같은 목**을 쓴다.
 *
 * ⚠️ 목은 계약의 일부다(CLAUDE.md #342). 두 파일이 각자 목을 적으면 한쪽만 낡고, 그 순간 그
 * 스펙은 자기가 만든 세계를 검증한다. 그래서 여기 한 곳이다.
 *
 * ── 표본이 계약의 절반이다 ───────────────────────────────────────────────────────────────
 * 라이브 실경기 **어웨이 라운드** 그대로다 — `01KYS2QM76YBKANGNZ6QTX8WBZ`
 * (축구왕여르 R4 vs Thunder Bay United, 픽스처 `home = 봇`). 기존 web 목·계약이 전부 유저=홈이라
 * "홈 = 나" 가정이 3개월 살았다(#322).
 *   · 전반 골 1 = tick 384, **away P034**
 *   · 후반 골 2 = tick 1364·1566, **away P108**
 *
 * ⚠️ **이 픽스처의 한계 — 후반 `minute` 이 0 부터 다시 센다**(구 엔진 산출을 잘라 온 것이라).
 * 그래서 후반 재생 중 실화면 캡션이 "1분까지의 기록"인데 표에는 **전반 골이 포함**돼 보인다.
 * 프로덕션 로그는 후반 분이 45+ 라 실제로는 어긋나지 않는다. 즉 **이 표본으로는 캡션↔데이터
 * 정합을 원리적으로 검증할 수 없다** — 캡션이 말하는 창(`statsWindow`)의 정합은 유닛
 * (`player-stats-view.test.ts` "분을 말하면 상한이 있고…")이 지킨다. 픽스처를 다시 구우려면
 * `scripts/gen-p388-fixture.ts` 처럼 **실엔진**으로 만들어라(손으로 minute 을 적으면 계약이
 * "내가 적은 규칙"을 검사한다).
 */

export const LOG_H1 = JSON.parse(
  readFileSync(new URL("./fixtures/p322-half1.json", import.meta.url).pathname, "utf8"),
);
export const LOG_H2 = JSON.parse(
  readFileSync(new URL("./fixtures/p322-half2.json", import.meta.url).pathname, "utf8"),
);

export const MATCH_ID = "01KYS2QM76YBKANGNZ6QTX8WBZ";
export const ME = "축구왕여르";
export const BOT = "Thunder Bay United";
/** 아주 긴 팀 이름 — 이름 하나가 시트를 밀어내지 않는지 재는 표본(#284/#322). */
export const LONG_BOT = "Thunder Bay United Reserves Academy First Team";
export const PHONE = { width: 390, height: 844 };

/** 전반 유일 득점자(away). BL-1 계약이 이 선수의 행을 직접 본다. */
export const H1_SCORER = "P034";
/** 후반 득점자(away, tick 1364 · 1566). 스포일러 계약이 이 둘을 쓴다. */
export const H2_SCORER = "P108";

const GK_IDS = new Set(["P116", "P014"]);
const ALL_IDS = [
  ...new Set(
    [...LOG_H1.tickSnapshots, ...LOG_H2.tickSnapshots].flatMap((s: { players: { playerId: string }[] }) =>
      s.players.map((p) => p.playerId),
    ),
  ),
] as string[];

/** 봇 로스터도 **같은 선수 카탈로그**를 쓴다(루트 #231) → 상대 이름·포지션도 여기서 나온다. */
export const PLAYERS = ALL_IDS.map((id) => ({
  id,
  name: `선수${id.slice(1)}`,
  position: GK_IDS.has(id) ? "GK" : "MF",
  grade: "SILVER",
  owned: true,
  ownedCount: 1,
}));

export type Shape = "away-fixture" | "home-fixture" | "long-name";

/** ⚠️ 라우트는 pathname 술어로 — glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면이 된다. */
export async function mockApi(page: Page, state: string, shape: Shape = "away-fixture") {
  const userAway = shape !== "home-fixture";
  const bot = shape === "long-name" ? LONG_BOT : BOT;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: ME, points: 0, wins: 4, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          // 전반이 끝난 상태부터는 서버가 확정 스코어를 준다 — 헤더가 `0 : 1` 을 말하는 그 값이다.
          scoreH1Home: state === "FIRST_HALF" ? null : 0,
          scoreH1Away: state === "FIRST_HALF" ? null : 1,
          scoreHome: state === "FINISHED" ? 0 : null,
          scoreAway: state === "FINISHED" ? 3 : null,
          result: state === "FINISHED" ? (userAway ? "WIN" : "LOSS") : null,
          createdAt: "2026-07-30T08:37:23Z",
          finishedAt: state === "FINISHED" ? "2026-07-30T08:55:31Z" : null,
          mode: "league",
          ownerName: ME,
          opponent: { name: bot, deck: [] },
          // 사이드 라벨은 **서버가 준다**(#322) — 클라가 추론하지 않는다.
          homeName: userAway ? bot : ME,
          awayName: userAway ? ME : bot,
          // 라이브 시계 없음 = 재생 상한이 없다 → 스포일러 계약을 `seek` 로 결정론적으로 잰다.
          clock: null,
          userDeckSnapshot: { formation: "4-3-3", starters: [], bench: [] },
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/1\/log$/.test(url.pathname)) return route.fulfill({ json: LOG_H1 });
    if (/\/api\/matches\/.+\/halves\/2\/log$/.test(url.pathname)) return route.fulfill({ json: LOG_H2 });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({ json: { matchId: MATCH_ID, result: "WIN", scoreHome: 0, scoreAway: 3, pointsAwarded: 0 } });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: { formation: "4-3-3", slots: [] } });
    return route.fulfill({ json: {} });
  });
}

export async function open(page: Page, state: string, shape: Shape = "away-fixture") {
  await mockApi(page, state, shape);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
}

export async function openPlayers(page: Page, state: string, shape: Shape = "away-fixture") {
  await open(page, state, shape);
  await page.getByTestId("stage-tab-players").click();
  await expect(page.getByTestId("stage-panel-players")).toHaveCount(1);
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  bottom: number;
  right: number;
  /** 박스가 뷰포트 안에 **통째로** 들어왔나. */
  inViewport: boolean;
  /** 중심점을 실제로 자기가 받나 — 잘리거나 덮였으면 false. */
  hitSelf: boolean;
  vw: number;
  vh: number;
}

/** #348 과 같은 계측 — 좌표 + 중심점 히트테스트. `toBeVisible()` 은 뷰포트 밖도 통과한다. */
export async function box(page: Page, testId: string): Promise<Box> {
  const out = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      bottom: Math.round(r.bottom),
      right: Math.round(r.right),
      inViewport:
        r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
      hitSelf: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  }, testId);
  expect(out, `[${testId}] 가 DOM 에 없다`).not.toBeNull();
  return out!;
}

export function pageScroll(page: Page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    const b = document.body;
    return {
      v: Math.max(d.scrollHeight - d.clientHeight, b.scrollHeight - d.clientHeight),
      h: Math.max(d.scrollWidth - d.clientWidth, b.scrollWidth - d.clientWidth),
    };
  });
}

export interface ViewerWin {
  __viewer?: {
    ready?(): boolean;
    pause?(): void;
    play?(): void;
    seek?(t: number): void;
    cur?(): { tick: number };
    curPlayers?(): { id: string; team: string; px: number; py: number }[];
  };
}

export async function viewerReady(page: Page) {
  await page.waitForFunction(() => (window as unknown as ViewerWin).__viewer?.ready?.() === true, null, {
    timeout: 20_000,
  });
}

/** 재생을 세우고 플레이헤드를 정확히 옮긴다 — #318("화면이 움직이는 동안 재지 마라"). */
export async function seek(page: Page, tick: number) {
  await page.evaluate((t) => {
    const v = (window as unknown as ViewerWin).__viewer;
    v?.pause?.();
    v?.seek?.(t);
  }, tick);
}

/** 지금 표에 뜬 그 팀 전원의 `골` 합계 — 화면이 말하는 값만 읽는다. */
export function goalSum(page: Page, team: "home" | "away"): Promise<number> {
  return page.evaluate((t) => {
    const cells = document.querySelectorAll(`[data-testid^="players-goals-${t}-"]`);
    let n = 0;
    for (const c of cells) n += Number(c.textContent ?? "0");
    return n;
  }, team);
}
