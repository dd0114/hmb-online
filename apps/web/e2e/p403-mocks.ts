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

export type MockPosition = "GK" | "DF" | "MF" | "FW";

/**
 * ⚠️ **포지션도 표본이다.** 한때 이 목은 `GK 2명 + 나머지 전원 MF` 였고, 그래서 평점의
 * **`DF`·`FW` 포지션 배수가 (A) e2e·실화면에서 원리적으로 발화하지 않았다** — W1b/W1c 가 가장
 * 크게 움직인 축이 정확히 그 둘인데, 그 재보정을 되돌리는 변이가 전부 green 이었다
 * (#403 통합 검증 minor-3/minor-4). 이제 **네 포지션이 다 나온다**.
 *
 * 값은 지어낸 것이 아니라 **픽스처 킥오프 스냅샷의 좌표**에서 읽은 4-3-3 이다(x = 자기 골문에서의
 * 거리, 105m 피치):
 *   home  GK 4 · DF 19~29 · MF 53 · FW 82~89
 *   away  GK 100 · DF 79~84 · MF 47~58 · FW 21~32
 * 후반 교체(P179→P092 · P175→P108 · P034→P093)도 **같은 슬롯**으로 들어온다.
 *
 * ⚠️ `/api/players` 는 **id 축**이다(팀이 없다) — 이 픽스처는 양 팀 id 가 겹치지 않아 성립한다.
 * 겹치는 픽스처로 갈아타면 이 표가 아니라 서버 계약부터 다시 봐야 한다(루트 #231).
 */
export const POSITION_BY_ID: Record<string, MockPosition> = {
  // home (봇) — 4-3-3
  P116: "GK",
  P118: "DF", P121: "DF", P124: "DF", P126: "DF",
  P166: "MF", P129: "MF", P127: "MF",
  P171: "FW", P141: "FW", P172: "FW",
  // away (유저) — 4-3-3 + 후반 교체 3명
  P014: "GK",
  P078: "DF", P079: "DF", P077: "DF", P090: "DF",
  P145: "MF", P179: "MF", P025: "MF", P092: "MF",
  P175: "FW", P034: "FW", P106: "FW", P108: "FW", P093: "FW",
};

/** 양 팀 골키퍼 — GK 축 계약이 이 두 행을 직접 본다. */
export const HOME_GK = "P116";
export const AWAY_GK = "P014";

const ALL_IDS = [
  ...new Set(
    [...LOG_H1.tickSnapshots, ...LOG_H2.tickSnapshots].flatMap((s: { players: { playerId: string }[] }) =>
      s.players.map((p) => p.playerId),
    ),
  ),
] as string[];

// 표가 조용히 낡지 않게 — 픽스처에 있는 선수인데 포지션이 없으면 **여기서 터진다**.
// (없으면 그 선수만 포지션 미상으로 떨어져 계약이 검사하는 척만 한다.)
const MISSING = ALL_IDS.filter((id) => !POSITION_BY_ID[id]);
if (MISSING.length > 0) {
  throw new Error(`p403-mocks: 픽스처 선수 ${MISSING.join(",")} 의 포지션이 POSITION_BY_ID 에 없다`);
}

/**
 * ⚠️ **`attributes` 는 `CatalogPlayer` 의 필수 필드인데 이 목이 안 싣고 있었다** (#403 W3 발견).
 * 그동안 소비자가 없어 드러나지 않았는데, 선수 상세의 **축소 모드**(상대·타 유저 = 카탈로그
 * 능력치가 유일한 재료)가 그걸 읽는 순간 표본이 통째로 비었다 — 목이 낡으면 그 스펙은 자기가
 * 만든 세계를 검증한다(#342).
 *
 * 값은 id 에서 **결정론적으로** 만든다. 전원 같은 값이면 레이더가 정육각형이라 "포지션마다 축이
 * 정말 다른가"도, "막대 길이가 값을 따라가나"도 화면에서 확인할 수 없다.
 */
const ATTR_KEYS = [
  "shooting", "pace", "positioning", "technical", "passing",
  "stamina", "physical", "mental", "tackling",
] as const;

export function attrsFor(id: string): Record<string, number> {
  const seed = Number(id.slice(1)) || 1;
  const out: Record<string, number> = {};
  ATTR_KEYS.forEach((k, i) => {
    out[k] = 40 + ((seed * 7 + i * 13) % 45);
  });
  return out;
}

/** 봇 로스터도 **같은 선수 카탈로그**를 쓴다(루트 #231) → 상대 이름·포지션도 여기서 나온다. */
export const PLAYERS = ALL_IDS.map((id) => ({
  id,
  name: `선수${id.slice(1)}`,
  position: POSITION_BY_ID[id]!,
  grade: "SILVER",
  owned: true,
  ownedCount: 1,
  attributes: attrsFor(id),
}));

export type Shape = "away-fixture" | "home-fixture" | "long-name";

export interface MockOpts {
  /**
   * `GET /api/me` 응답을 이만큼 늦춘다 (#403 W4 R1 — 독립검증 major-1 의 표본).
   *
   * ⚠️ **이건 인위적인 상황이 아니다.** `App.tsx RequireAuth` 는 **토큰만** 보고 화면을 띄우므로
   * `/api/me` 는 애초에 기다려지지 않는다 — `/api/matches/:id` 가 먼저 오면 패널은 `myTeamSide`
   * 를 **모른 채로** 마운트된다. 목이 두 응답을 같은 틱에 주면 그 순서가 구조적으로 안 생겨서,
   * 계약이 *"내 팀 칩과 선택된 세그먼트가 같은가"* 를 영영 못 잰다.
   * 직접 잰 지연 스윕(수정 전 코드 · `chip`/`selected`): `0ms away/away` · **`20·40·80·150·300ms`
   * 전부 `away/home`**(= 칩과 표가 다른 팀). 수정 후에는 여섯 지연 전부 `away/away`.
   */
  meDelayMs?: number;
  /**
   * 하프 로그의 **팀 라벨만** 뒤집어 서빙한다 (#403 W4 R2).
   *
   * ⚠️ `shape` 로는 이 축을 못 만든다 — `away-fixture`/`home-fixture` 는 **매치 메타**의 사이드
   * 라벨(`homeName`/`awayName`)만 뒤집고 로그는 그대로라, 두 shape 모두 MOTM 이 **away 사이드**다.
   * 그래서 *"MOTM 이 home 사이드"* 라는 상태가 리포 e2e 에 한 번도 없었고, `motmRowOf` 의
   * `home` 항을 떨어뜨리는 변이가 e2e 전체를 통과했다(R1 이 그것을 *"구조적으로 불가능"* 이라고
   * 적었는데 **거짓이었다** — 뒤집으면 MOTM = `home:P079` 다. 실측은 R2 커밋 메시지).
   *
   * ⚠️ **이건 합성 표본이다** — 로그만 뒤집으므로 매치 메타의 스코어(`0:3`)와는 어긋난다.
   * 그 축을 재는 계약에 쓰지 마라. 쓰는 자리는 *"MOTM 을 양 팀에서 찾는가"* 하나뿐이다.
   *
   * ⚠️ **불일치는 로그 **안**에도 하나 더 있다**(R3 — 독립검증 minor-1). `flipTeams` 는
   * `tickSnapshots[].players[].team` 과 `events[].team` 만 뒤집고 **로그 자신의 `finalScore` 는
   * 안 뒤집는다** — 뒤집힌 로그에서 골 이벤트는 `home` 소속인데 `finalScore` 는 `{home:0, away:1}`
   * (H1) / `{home:0, away:2}`(H2) 그대로다. 실소비자는 `match-logic.ts:fallbackScore` 이고,
   * 지금 이 목을 쓰는 유일한 계약(MOTM)은 스코어를 안 읽으므로 **무해하다**.
   * **고치지 않은 이유**: 뒤집으면 매치 메타(`scoreHome/scoreAway`)·스코어바·타임라인이 같이
   * 움직여 이 목이 재려던 축 하나가 흔들린다. 대신 여기 적어 둔다 — 다음 사람이 *"이 로그는
   * 내부적으로 정합하다"* 고 읽으면 그 자리에서 틀린다. **스코어를 읽는 계약에 이 목을 쓰지 마라.**
   */
  flipLogTeams?: boolean;
}

/** 팀 라벨만 뒤집은 하프 로그(위 `flipLogTeams`). 로그는 크므로 한 번만 만든다. */
function flipTeams(log: typeof LOG_H1) {
  const flip = (t: string) => (t === "home" ? "away" : t === "away" ? "home" : t);
  return {
    ...log,
    tickSnapshots: log.tickSnapshots.map((s: { players: { team: string }[] }) => ({
      ...s,
      players: s.players.map((p) => ({ ...p, team: flip(p.team) })),
    })),
    events: (log.events ?? []).map((e: { team?: string }) => (e.team ? { ...e, team: flip(e.team) } : e)),
  };
}
let flippedH1: unknown;
let flippedH2: unknown;

/** ⚠️ 라우트는 pathname 술어로 — glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면이 된다. */
export async function mockApi(
  page: Page,
  state: string,
  shape: Shape = "away-fixture",
  opts: MockOpts = {},
) {
  const userAway = shape !== "home-fixture";
  const bot = shape === "long-name" ? LONG_BOT : BOT;
  const meDelayMs = opts.meDelayMs ?? 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      if (meDelayMs > 0) await new Promise((r) => setTimeout(r, meDelayMs));
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
    if (/\/api\/matches\/.+\/halves\/1\/log$/.test(url.pathname)) {
      if (!opts.flipLogTeams) return route.fulfill({ json: LOG_H1 });
      return route.fulfill({ json: (flippedH1 ??= flipTeams(LOG_H1)) as object });
    }
    if (/\/api\/matches\/.+\/halves\/2\/log$/.test(url.pathname)) {
      if (!opts.flipLogTeams) return route.fulfill({ json: LOG_H2 });
      return route.fulfill({ json: (flippedH2 ??= flipTeams(LOG_H2)) as object });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({ json: { matchId: MATCH_ID, result: "WIN", scoreHome: 0, scoreAway: 3, pointsAwarded: 0 } });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: { formation: "4-3-3", slots: [] } });
    return route.fulfill({ json: {} });
  });
}

/** 로그인 상태 주입 — 목 스펙이 `/match` 밖(예: `/me` 목록)에서 시작할 때도 같은 경로를 쓴다. */
export async function authInit(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
}

/**
 * 매치 화면을 연다.
 *
 * ⚠️ **추가 목이 필요해도 이 함수를 풀어 쓰지 마라** — `beforeGoto` 로 끼워라(R2, 독립검증
 * minor-3). R1 이 성장 리포트·`/api/me` 지연 목을 얹으려고 호출부에서
 * `mockApi → authInit → goto → expect(stage-shell)` 를 복제했는데, 그러면 여는 순서가 두 벌이 돼
 * 한쪽만 낡는다(`ChoiceCards.tsx` 머리말 — R1 자신이 `useTeamSegment` 를 합칠 때 인용한 원칙이다).
 * 등록 순서는 여기서 지킨다: **catch-all(`mockApi`) 먼저 → 세부 목(`beforeGoto`) 나중**
 * (playwright 는 나중에 등록한 라우트가 먼저 매칭된다).
 */
export async function open(
  page: Page,
  state: string,
  shape: Shape = "away-fixture",
  opts: MockOpts = {},
  beforeGoto?: (page: Page) => Promise<void>,
) {
  await mockApi(page, state, shape, opts);
  await beforeGoto?.(page);
  await authInit(page);
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
}

export async function openPlayers(page: Page, state: string, shape: Shape = "away-fixture") {
  await open(page, state, shape);
  await page.getByTestId("stage-tab-players").click();
  await expect(page.getByTestId("stage-panel-players")).toHaveCount(1);
}

/**
 * ── W4 (종료·과거 경기) 추가 목 ─────────────────────────────────────────────────────────
 *
 * ⚠️ 아래 헬퍼들은 전부 **`mockApi`(=`open`) 뒤에** 등록한다 — playwright 는 나중에 등록한
 * 라우트가 먼저 매칭되므로 catch-all 을 이긴다(`mockGrowthCard` 와 같은 규율).
 */

/**
 * **하프 로그가 없는 경기** — `match_halves` 행이 없으면 서버가 404 `해당 half 로그가 없습니다`
 * 를 준다(`MatchService.halfLogJson` 실측). 과거 경기 목록이 그런 매치를 `hasHalves:false` 로
 * 구분해 그리므로 **정상적으로 존재하는 상태**이고, 그 경기의 결과 화면이 무엇을 말하는지가
 * W4 의 빈 상태 계약이다.
 *
 * ⚠️ 404 **본문 형태까지 서버와 같게** 준다(`{code,message}`) — 형태가 다르면 `apiFetch` 가
 * `ApiError.status` 를 못 실어 주고, 그러면 화면이 "기록 없음"과 "불러오지 못함"을 못 가른다.
 * 목이 낡으면 그 스펙은 자기가 만든 세계를 검증한다(#342).
 */
export const NO_LOG_MATCH_ID = "01KYS2QM76YBKANGNZ6QTX8W00";

export async function mockNoLogMatch(page: Page, id: string = NO_LOG_MATCH_ID) {
  await page.route(
    (url) => url.pathname.startsWith(`/api/matches/${id}`),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (/\/halves\/[12]\/log$/.test(p)) {
        return route.fulfill({
          status: 404,
          json: { code: "NOT_FOUND", message: "해당 half 로그가 없습니다" },
        });
      }
      if (p.endsWith("/result")) {
        return route.fulfill({
          json: { matchId: id, result: "LOSS", scoreHome: 3, scoreAway: 0, pointsAwarded: 0 },
        });
      }
      return route.fulfill({
        json: {
          id,
          state: "FINISHED",
          scoreH1Home: 2,
          scoreH1Away: 0,
          scoreHome: 3,
          scoreAway: 0,
          result: "LOSS",
          createdAt: "2026-06-01T10:00:00Z",
          finishedAt: "2026-06-01T10:20:00Z",
          mode: "practice",
          ownerName: ME,
          opponent: { name: "구경기봇", deck: [] },
          homeName: "구경기봇",
          awayName: ME,
          clock: null,
        },
      });
    },
  );
}

/**
 * 과거 경기 목록(`GET /api/logs/matches`) — **요구 D 의 진입 경로**다.
 * `/logs` 는 `/me` 로 리다이렉트되고 `MePage` 가 `LogsPage embedded` 를 그린다(App.tsx).
 *
 * 두 행을 싣는다: 로그가 있는 경기(뱃지 있음)와 **없는 경기**(뱃지 없음) — 규칙 하나당 표본 하나.
 */
export const PAST_LOGS = [
  {
    id: MATCH_ID,
    mode: "league",
    opponentName: BOT,
    result: "WIN",
    scoreHome: 0,
    scoreAway: 3,
    userWasHome: false,
    seasonNo: 1,
    round: 4,
    hasHalves: true,
    createdAt: "2026-07-30T08:37:23Z",
  },
  {
    id: NO_LOG_MATCH_ID,
    mode: "practice",
    opponentName: "구경기봇",
    result: "LOSS",
    scoreHome: 3,
    scoreAway: 0,
    userWasHome: false,
    hasHalves: false,
    createdAt: "2026-06-01T10:00:00Z",
  },
];

export async function mockPastLogs(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/logs/matches",
    (route) => route.fulfill({ json: PAST_LOGS }),
  );
}

/**
 * **성장 리포트가 실제로 렌더되는 목** (#403 W4 R1 — 독립검증 minor-6a).
 *
 * ⚠️ 기본 `mockApi` 는 `/api/growth/report/*` 를 catch-all `{}` 로 흘린다 →
 * `GrowthReportSection` 은 `entries.length === 0` 이면 **null 을 돌려준다** = 섹션이 DOM 에 없다.
 * 그 상태에서 *"개인 성적이 성장 리포트보다 앞에 있다"* 를 `if (count > 0)` 로 감싸면 그 블록은
 * **한 번도 실행되지 않는다** — 실제로 그 단언을 `<GrowthReportSection>` 뒤로 옮기는 변이가
 * SURVIVED 했다. 목이 계약의 일부다(#342).
 *
 * 값은 `MatchGrowthEntry`(`api/growth.ts`) 모양 그대로 — 서버가 안 주는 필드(`statXp` 등)를
 * 지어내지 않는다.
 */
export const GROWTH_ENTRIES = [
  {
    playerId: "P014",
    name: "선수014",
    position: "GK",
    grade: "SILVER",
    xpGained: 120,
    levelBefore: 3,
    levelAfter: 4,
    cardXp: 40,
    xpToNext: 200,
    minutes: "starter",
    pendingChoices: [],
  },
  {
    playerId: "P034",
    name: "선수034",
    position: "FW",
    grade: "SILVER",
    xpGained: 180,
    levelBefore: 5,
    levelAfter: 5,
    cardXp: 90,
    xpToNext: 260,
    minutes: "starter",
    pendingChoices: [],
  },
];

export async function mockGrowthReport(page: Page, entries: unknown[] = GROWTH_ENTRIES) {
  await page.route(
    (url) => url.pathname.startsWith("/api/growth/report/"),
    (route) => route.fulfill({ json: { matchId: MATCH_ID, entries } }),
  );
}

/**
 * **하프 로그 조회가 진짜 오류인 경우**(500) (#403 W4 R1 — 독립검증 minor-2).
 *
 * `usePlayerStats.logMissing` 은 **404 일 때만** 참이어야 한다 — 500·네트워크 단절을
 * *"이 경기는 기록이 남아 있지 않습니다"* 로 덮으면 있는 기록을 없다고 말한다. 그 방향을
 * 검사하는 단언이 리포 전체에 0건이라 `error.status === 404` 를 지우는 변이가 SURVIVED 했다.
 */
export async function mockHalfLogError(page: Page, status = 500) {
  await page.route(
    (url) => /\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname),
    (route) => route.fulfill({ status, json: { code: "INTERNAL", message: "일시적인 오류입니다" } }),
  );
}

/**
 * 그 경로로 나간 **요청 수**를 세는 살아 있는 카운터.
 *
 * 게이트 합성(`needsPlayerStats(activeTab)` → 훅 `enabled`)은 소비 화면이 없으면 **관측되지
 * 않는다** — 출하 코드에 계측을 심지 않고 재려면 *"그 게이트가 켜져야만 나가는 요청"* 이
 * 필요하다. 그게 **전반 로그**다(아래 스펙 ⑧ 주석 참조).
 */
export function countRequests(page: Page, re: RegExp): { n: number } {
  const c = { n: 0 };
  page.on("request", (req) => {
    if (re.test(new URL(req.url()).pathname)) c.n += 1;
  });
  return c;
}

/**
 * ── W3 선수 상세 모달용 추가 목 ─────────────────────────────────────────────────────────
 *
 * 기본 `mockApi` 는 `/api/growth/card/*` 를 catch-all `{}` 로 흘린다 — 그게 **상대·타 유저의
 * 실제 상태**(서버가 남의 카드를 안 준다)이자 `attributeViewOf` 가 축소 모드로 떨어지는 경로다.
 * `full` 모드를 태우려면 내 선수 하나에 카드가 실려야 하므로 여기서 명시적으로 얹는다.
 *
 * ⚠️ **`open()` 뒤에 부른다.** playwright 는 나중에 등록한 라우트가 먼저 매칭되므로 catch-all 을
 * 이긴다. 카드 조회는 모달을 연 뒤에 일어나니 순서상 안전하다.
 */
export const CARD_ATTRS = {
  shooting: 55, pace: 60, positioning: 45, technical: 44, passing: 42,
  stamina: 43, physical: 40, mental: 41, tackling: 30,
};
export const CARD_CAPS = {
  shooting: 80, pace: 82, positioning: 71, technical: 70, passing: 69,
  stamina: 66, physical: 65, mental: 68, tackling: 55,
};
/** 서버 `startLo`(등급 시작 밴드 하한) — 막대·레이더의 좌측 원점. */
export const CARD_START_LO = 50;

export async function mockGrowthCard(page: Page, playerId: string) {
  await page.route(
    (url) => url.pathname === `/api/growth/card/${playerId}`,
    (route) =>
      route.fulfill({
        json: {
          playerId,
          grade: "SILVER",
          star: 3,
          attributes: CARD_ATTRS,
          prePotential: CARD_ATTRS,
          base: CARD_ATTRS,
          caps: CARD_CAPS,
          statAdd: { shooting: 2.5 },
          cardLevel: 12,
          maxLevel: 40,
          cardXp: 60,
          xpToNext: 346,
          startLo: CARD_START_LO,
          growCeil: 72,
          starCeilBonus: 1,
          attrHardCap: 99,
          statLevels: {},
          potential: { unlocked: true, tier: "RARE", maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 9 },
          ovr: 58,
          completion: 0.31,
        },
      }),
  );
}

/** 내 덱의 선수별 지시 — 상세 모달 [선수 정보] 탭의 프롬프트 출처(매치 시점 덮어쓰기는 조회 API 가 없다). */
export async function mockDeckPrompt(page: Page, playerId: string, text: string) {
  await page.route((url) => url.pathname === "/api/deck", (route) =>
    route.fulfill({
      json: { formation: "4-3-3", slots: [{ playerId, role: "starter", slotIndex: 0, promptText: text }] },
    }),
  );
}

/** 선수 탭에서 그 행을 눌러 상세 모달을 연다(목업 ① *"행을 누르면 그 선수 상세로 → ③"*). */
export async function openDetail(page: Page, team: "home" | "away", playerId: string) {
  await page.getByTestId(`players-team-${team}`).click();
  await page.getByTestId(`players-row-${team}-${playerId}`).click();
  await expect(page.getByTestId("player-detail")).toBeVisible();
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
