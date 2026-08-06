import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #406 W4 — **선수 하이라이트**(요구 5-2, 목업 §2). hero 확정 ② = 펄스 링 `R+9`.
 *
 * hero 요구: *"경기중 내 선수를 선택하면 그 선수가 하이라이트돼 누가 선택됐는지 보이게.
 * 상대 선수도 동일 — 눌러서 정보 볼 때 누군지 표시."*
 *
 * <p>코어 계약(`packages/engine/dev-viewer/e2e/player-select.spec.ts`)이 **링 자체**를 재고,
 * 이 파일은 **실브라우저의 배선**을 잰다 — 탭이 좌표 변환을 지나 그 선수에게 닿는가, 내/상대가
 * 갈리는가, 카드가 390px 안에 실제로 그려지는가.
 *
 * ⚠️ `toBeVisible()` 은 뷰포트 밖도 통과한다(apps/web CLAUDE.md §3) → **좌표로 잰다**.
 * ⚠️ 캔버스는 backing 1050×680 을 `object-fit: contain` 으로 축소해 그린다. 클릭 지점을
 *    `clientX - rect.left` 로 잡으면 폰에서 2~3배 어긋난다 — 여기서도 축소·레터박스를 되짚는다.
 * ⚠️ 백엔드에 붙지 않는다 — 전면 route-mock(:8080 데모 무접촉).
 */

const MATCH_ID = "m-406sel";
const RAW = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);
const H2_OFFSET = 2700;
const LOG = {
  ...RAW,
  tickSnapshots: RAW.tickSnapshots.map((s: { tick: number }) => ({ ...s, tick: s.tick + H2_OFFSET })),
  events: RAW.events.map((e: { tick: number }) => ({ ...e, tick: e.tick + H2_OFFSET })),
};
const HALF_REAL_MS = 420_000;

/** 로그에 실제로 뛰는 선수 id — 카탈로그 목을 여기서 만든다(이름이 화면에 뜨는지 보려면 필요). */
const IDS: string[] = [
  ...new Set<string>(
    (RAW.tickSnapshots[0].players as Array<{ playerId: string }>).map((p) => p.playerId),
  ),
];
/** 사이드별 로그 출전 명단 — 지시 대상 칩(`userDeckSnapshot`)을 **실제로 뛰는 선수**로 만든다. */
const SIDE_IDS: Record<"home" | "away", string[]> = {
  home: [...new Set((RAW.tickSnapshots[0].players as Array<{ playerId: string; team: string }>).filter((p) => p.team === "home").map((p) => p.playerId))],
  away: [...new Set((RAW.tickSnapshots[0].players as Array<{ playerId: string; team: string }>).filter((p) => p.team === "away").map((p) => p.playerId))],
};

/**
 * 매치 스냅샷(지시 대상 칩의 출처, #284) — **기본은 없다**.
 *
 * ⚠️ 기존 13개 계약의 표본을 건드리지 않으려고 옵트인으로 둔다. 스냅샷이 붙으면 `후반 지시` 탭에
 * 선수 칩이 생기는데, 그건 요구 5-2 후반(칩 → 하이라이트)을 재는 계약만 필요한 전제다.
 */
function deckSnapshotOf(side: "home" | "away") {
  return {
    formation: "4-3-3",
    starters: SIDE_IDS[side].slice(0, 11).map((playerId, slotIndex) => ({ playerId, slotIndex })),
    bench: [],
  };
}

/**
 * 등급은 **전부 BRONZE** 로 둔다 — #285 아트 정책의 임계 아래다. 하이라이트가 그 정책을 우회해
 * 카드에 얼굴을 그리면 여기서 걸린다(계약 ⑤).
 */
const CATALOG = IDS.map((id, i) => ({
  id,
  name: `한글선수${i}`,
  position: "MF",
  grade: "BRONZE",
  attributes: {},
  owned: true,
  ownedCount: 1,
}));

/**
 * 목 라이브 시계.
 *
 * ⚠️ **하프 앵커(`kickoffAt`/`phaseStartAt`/`phaseEndsAt`)는 `open()` 시각에 한 번 고정한다 —
 * 매 폴마다 `Date.now()` 로 다시 만들면 이 파일 전체가 구조적으로 플레이키해진다**(W10 2R).
 *
 * <p>기제(실측): `useMatch` 는 라이브에서 **1초 폴링**이고, 이 목이 폴마다 새 `phaseStartAt` 을
 * 만들면 그 값이 `VisualPlayback` 라이브 게이트 effect 의 **의존성**(`[…, clock?.phase,
 * clock?.phaseStartAt]`)이라 **1초마다 effect 가 재실행**된다. 재실행의 첫 두 줄이
 * `v.jumpToTick(seek-to-now)` + `v.play()` 다 — 즉 **테스트가 `pause()` + `seek(과거)` 해 둔
 * 플레이헤드를 앱이 1초 안에 라이브 헤드로 끌어가고 재생까지 시작한다.**
 * 진단 실측(같은 목, 하이라이트 릴 **off** · `pause()` 후 `seek(2988)`):
 * <pre>
 *   앵커가 흐를 때 : 0ms:2988 250:2988 500:2988 **750:3416** 1000:3419 1250:3420 … (계속 3416~3420 진동)
 *   앵커를 고정하면: 0ms:2988 250:2988 500:2988   750:2988 1000:2988 1250:2988 … (12/12 동일)
 * </pre>
 * 이 파일은 **좌표를 재고 그 자리를 누르는** 계약뿐이라, 그 사이에 배치가 갈리면 클릭이 빈 자리에
 * 떨어진다(#318 하네스 경합과 같은 부류 — 화면이 움직이는 동안 좌표를 재지 마라).
 *
 * <p>⚠️ **계약을 느슨하게 한 것이 아니라 목을 서버 모양에 맞춘 것이다.** 실서버의 `phaseStartAt`·
 * `kickoffAt` 은 DB 에 박힌 **그 하프의 실제 시각**이라 폴 사이에 움직이지 않는다 — 움직이던 쪽이
 * 서버가 하지 않는 일을 흉내내고 있었다(apps/web CLAUDE.md "목은 계약의 일부다").
 * **`serverNow` 는 그대로 흐른다**(실서버가 그렇다) — 그래서 라이브 게이트의 미래 잠금은 살아
 * 있고, ⑯ 이 "과거 절반 안에서만 고른다"는 전제도 그대로다.
 *
 * <p>⚠️ 라이브 창은 `open()` 시각 기준 **+210초**까지다(하프 420초의 절반이 지난 지점에서 연다).
 * 이 파일의 어떤 테스트도 그보다 오래 걸리지 않는다(스펙 timeout 180초) — 넘기면 하프가 끝나
 * `highlightDefaultOn` 이 릴을 **자동으로 켠다**(`live` 가 풀리는 자리). 테스트가 그 근처까지
 * 길어지면 여기 0.5 를 줄여라.
 */
function clock(phase: MatchState = "SECOND_HALF", anchorMs = Date.now()) {
  // 종료된 경기엔 라이브 시계가 없다(`MatchViewer`: `clock === null` = 미래 잠금 해제).
  if (phase === "FINISHED") return null;
  const start = anchorMs - HALF_REAL_MS * 0.5;
  return {
    phase,
    kickoffAt: new Date(start).toISOString(),
    phaseStartAt: new Date(start).toISOString(),
    phaseEndsAt: new Date(start + HALF_REAL_MS).toISOString(),
    // 서버 시각만 실제로 흐른다 — 클라 오프셋 계산(`serverNow - clientNow`)이 그 축이다.
    serverNow: new Date().toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: 180_000,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
  };
}

type MatchState = "FIRST_HALF" | "SECOND_HALF" | "FINISHED";
/**
 * 목 상태 핸들 — 테스트가 **경기 중에** 상태를 갈아 끼울 수 있게 한다(계약 ⑥).
 * `useMatch` 는 라이브 상태에서 1초 폴링이므로 이 값을 바꾸면 다음 폴에 앱이 따라온다.
 */
type MockState = { state: MatchState };

/**
 * @param nickname 로그인 유저의 닉네임. **`myTeamSide` 를 정하는 유일한 축이다**
 *   (`stage-state.myTeamSide` = 팀 이름 대조). 기본값은 `homeName` 과 같아 홈 = 나이고,
 *   `"관전자"` 처럼 **양 팀 어느 쪽도 아닌** 이름을 주면 `myTeamSide === null` 이 된다 =
 *   *"둘 다 남의 팀인 화면"*(`stage-state.ts:398` 이 설계로 명시한 상태 — 관전 중 봇전 등).
 *
 *   ⚠️ **이 매개변수가 없던 동안 `mine` 3값의 절반이 미검정이었다**(W7 MAJOR-1): 목이 항상
 *   `homeName` 과 같은 닉네임을 줘서 `null` 이 **구조적으로 불가능**했고, 그래서
 *   `mineOf(...)` 를 `=== true` 로 접는 변이가 10/10 생존했다.
 */
async function open(
  page: Page,
  initial: MatchState = "SECOND_HALF",
  nickname = "테스터",
  /** 지시 대상 칩을 만들 매치 스냅샷의 사이드(#406 W9). null = 스냅샷 없음(기존 표본 그대로). */
  deckSide: "home" | "away" | null = null,
): Promise<MockState> {
  const st: MockState = { state: initial };
  // 하프 앵커를 **여기서 한 번** 고정한다(이유·실측 = `clock()` 머리말).
  const anchorMs = Date.now();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname, points: 0, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state: st.state,
          scoreH1Home: 1,
          scoreH1Away: 0,
          // 종료 상태는 확정 스코어를 갖는다(#226 헤더 규칙 — null 이면 결과 패널이 다른 가지로 샌다).
          scoreHome: st.state === "FINISHED" ? 2 : null,
          scoreAway: st.state === "FINISHED" ? 1 : null,
          result: st.state === "FINISHED" ? "WIN" : null,
          createdAt: "2026-08-02T09:00:00Z",
          mode: "practice",
          // 홈 = 나(`myTeamSide` 는 닉네임 대조로 판정한다 — #322 `stage-state.myTeamSide`).
          ownerName: "테스터",
          homeName: "테스터",
          awayName: "봇 FC",
          opponent: { name: "봇 FC", deck: [] },
          ...(deckSide ? { userDeckSnapshot: deckSnapshotOf(deckSide) } : {}),
          clock: clock(st.state, anchorMs),
        },
      });
    }
    // 하프마다 **다른 로그**를 준다 — ⑥ 이 재는 축이 "로그·하프가 갈리면 선택이 끝나나"라
    // 같은 객체를 두 번 주면 그 축이 구조적으로 사라진다(전반은 절대틱 0.., 후반은 2700..).
    const half = /\/halves\/1\/log$/.test(url.pathname) ? 1 : 2;
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) {
      return route.fulfill({ json: half === 1 ? RAW : LOG });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: CATALOG });
    if (url.pathname === "/api/deck") return route.fulfill({ json: { formation: "4-3-3", slots: [] } });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 20_000 },
  );
  // 토큰이 움직이면 클릭 좌표가 낡는다 — 정지시키고 잰다(#318 하네스 경합과 같은 부류).
  // ⚠️ 하이라이트 순서 재생(#421)이 켜져 있으면 `pause()` 뒤에도 시퀀서가 다시 `seek` 한다.
  await stopHighlightMode(page);
  await page.evaluate(() => (window as any).__viewer.pause());
  await page.waitForTimeout(120);
  return st;
}

type Token = { id: string; team: "home" | "away"; px: number; py: number; r: number };

/** 지금 그려진 토큰들(코어가 알려주는 backing 좌표) — 좌표를 밖에서 재구성하지 않는다(#218). */
function tokens(page: Page): Promise<Token[]> {
  return page.evaluate(() => (window as any).__viewer.curPlayers() as Token[]);
}

/**
 * backing 좌표 → 클라이언트 좌표. **CSS `object-fit: contain` 규칙에서 유도한다** —
 * 앱이 이 변환을 빠뜨리면(= `clientX - rect.left` 로 계산하면) 여기서 겨눈 점이 앱 안에서
 * 엉뚱한 곳으로 읽혀 다른 선수가 켜지거나 아무도 안 켜진다.
 */
async function clientPointOf(page: Page, px: number, py: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([bx, by]) => {
      const cv = document.querySelector('[data-testid^="viewer-canvas-half"]') as HTMLCanvasElement;
      const rect = cv.getBoundingClientRect();
      const scale = Math.min(rect.width / cv.width, rect.height / cv.height);
      const originX = rect.left + (rect.width - cv.width * scale) / 2;
      const originY = rect.top + (rect.height - cv.height * scale) / 2;
      return { x: originX + (bx as number) * scale, y: originY + (by as number) * scale };
    },
    [px, py],
  );
}

async function tapToken(page: Page, t: Token) {
  const p = await clientPointOf(page, t.px, t.py);
  await page.mouse.click(p.x, p.y);
}

/** 코어가 **실제로 그린** 선택 링. `mine` 은 **3값**(null = 모른다, #406 W6 m6). */
function drawnRings(page: Page) {
  return page.evaluate(
    () =>
      (window as any).__viewer.selection() as Array<{
        id: string;
        team: string;
        mine: boolean | null;
        r: number;
        px: number;
        py: number;
      }>,
  );
}

/**
 * 코어가 **그 프레임에 그린** 링을 클라이언트 좌표의 원으로. 없으면 `null`.
 *
 * <p>반경은 backing → CSS 로 옮긴다(`object-fit: contain` 축소). 좌표를 앱과 다른 방식으로
 * 재계산하지 않도록 위 `clientPointOf` 하나만 쓴다.
 */
async function ringCircleCss(
  page: Page,
  t: { id: string; team: "home" | "away" },
): Promise<{ x: number; y: number; r: number } | null> {
  const ring = (await drawnRings(page)).find((r) => r.id === t.id && r.team === t.team);
  if (!ring) return null;
  const center = await clientPointOf(page, ring.px, ring.py);
  const edge = await clientPointOf(page, ring.px + ring.r, ring.py);
  return { x: center.x, y: center.y, r: edge.x - center.x };
}

/** 그 선수 링의 CSS 반경(그려져 있어야 한다). 예산 계산이 노브를 손으로 적지 않게 하는 자리. */
async function ringRadiusCss(page: Page, t: { id: string; team: "home" | "away" }): Promise<number> {
  const c = await ringCircleCss(page, t);
  expect(c, `${t.team}:${t.id} 의 링이 그려지지 않았다`).toBeTruthy();
  expect(c!.r, "링 반경이 CSS 좌표로 옮겨졌다").toBeGreaterThan(1);
  return c!.r;
}

/** 원 둘레 32점 중 사각 안에 든 점 수 + 중심 포함 여부. 0/false 여야 "링이 보인다". */
function ringVsBox(
  ring: { x: number; y: number; r: number },
  box: { x: number; y: number; width: number; height: number },
): { covered: number; centerInside: boolean } {
  const inside = (x: number, y: number) =>
    x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
  let covered = 0;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    if (inside(ring.x + ring.r * Math.cos(a), ring.y + ring.r * Math.sin(a))) covered++;
  }
  return { covered, centerInside: inside(ring.x, ring.y) };
}

/**
 * 하이라이트 순서 재생(#421 W4)을 **끈다** — 그게 켜져 있으면 시퀀서가 장면마다 `seek` 해서
 * 플레이헤드가 계속 움직이고, 이 파일이 재는 것(탭한 좌표 → 그 선수)이 구조적으로 불안정해진다.
 * 종료 화면에서는 그 모드가 **기본 ON** 이라(`#1/19 · 3' · Save` 처럼 장면을 돌린다) 반드시 필요하다.
 *
 * ⚠️ **계약을 줄인 것이 아니다** — 시퀀서 자체의 계약은 #421 소관(`p421-highlight-reel.spec.ts`)이고,
 * 여기서 재는 축은 "탭이 좌표 변환을 지나 그 선수에게 닿는가"다. 두 기능을 한 표본에서 섞으면
 * 무엇이 깨졌는지 못 가른다(#318 하네스 경합과 같은 부류 — 화면이 움직이는 동안 좌표를 재지 마라).
 */
async function stopHighlightMode(page: Page) {
  const toggle = page.getByTestId("highlight-toggle");
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute("data-highlight")) === "on") {
    await toggle.click().catch(() => {});
    await expect(toggle).toHaveAttribute("data-highlight", "off");
  }
}

/**
 * 하프 전이 후 정착 대기 — 새 캔버스가 뜨고 코어가 그 로그를 물었고 재생이 멎었을 때 돌아온다.
 * (`open()` 이 초기 로드에서 하는 것과 같은 이유: 토큰이 움직이면 클릭 좌표가 낡는다.)
 *
 * **흐름 브릿지(#424)를 닫는 일도 여기서 한다** — `match-flow.BRIDGE_TABLE` 이
 * `FIRST_HALF → SECOND_HALF`(`h1_end`)와 `* → FINISHED`(`match_end`)에서 오버레이를 띄우고,
 * `StageShell` 은 그동안 무대를 **마운트하지 않는다**(`!managing && !overlayOpen` — 팝업 뒤에서
 * 캔버스가 도는 것을 구조적으로 0 으로 만든 결정). 그래서 전이 뒤에 곧바로 캔버스를 기다리면 죽는다.
 * 스킵을 안 했으므로 리포트 없는 스택이라 testid 접두가 `flow-bridge` 다
 * (`MatchFlowOverlay` 의 `testIdBase` 규칙 — 리포트로 오인하면 #421 의 "스킵 안 하면 리포트가
 * 안 뜬다" 계약이 조용히 무의미해진다).
 *
 * ⚠️ **한 번만 확인하고 넘어가면 안 된다** — 목 상태를 바꾼 직후엔 브릿지가 **아직 없다**.
 * `useMatch` 폴링(1초)이 새 상태를 보고 나서야 오버레이가 열리므로, 즉시 count 를 재면 0 이고
 * 그 다음 `toBeVisible` 이 20초를 헛되게 기다린다(실제로 그렇게 한 번 틀렸다).
 * 그래서 **무대가 뜰 때까지** 돌면서 브릿지가 보이면 그때그때 닫는다(스택이라 여러 장일 수 있다).
 *
 * ⚠️ **계약을 느슨하게 한 것이 아니다** — 아래 단언들은 그대로다(종료 화면에서도 무대가 남고
 * 선수를 고를 수 있다 · 문구가 상태와 무관하게 참이다). 유저가 실제로 지나는 한 걸음을
 * 테스트도 지나게 한 것뿐이다.
 */
async function settleHalf(page: Page, half: 1 | 2) {
  const canvas = page.getByTestId(`viewer-canvas-half${half}`);
  const cta = page.getByTestId("flow-bridge-next");
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await canvas.isVisible().catch(() => false)) break;
    if ((await cta.count()) > 0) await cta.first().click().catch(() => {});
    await page.waitForTimeout(200);
  }
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await stopHighlightMode(page);
  await page.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 20_000 },
  );
  await page.evaluate(() => (window as any).__viewer.pause());
  await page.waitForTimeout(120);
}

/**
 * 코어가 **캔버스 안에 실제로 그린** 토큰인가 (backing 1050×680).
 *
 * ⚠️ 이 필터가 없으면 표본이 화면 밖 선수가 될 수 있다. `curPlayers()` 는 카메라 밖으로 나간
 * 토큰도 **음수 좌표로** 돌려주고(팔로우 줌이 공을 따라가므로 반대편 선수는 캔버스를 벗어난다),
 * 그러면 탭이 캔버스가 아니라 허공에 떨어져 "선택이 안 된다"로 보인다 —
 * 실측: 종료 화면(플레이헤드 46틱)에서 가장 왼쪽 홈 선수(GK) 가 backing **(−199,−160)**,
 * 클라이언트 (−74,−1), `elementFromPoint` = **null**.
 * 재는 축("탭이 그 선수에게 닿는가")은 그대로다 — **보이지 않는 선수를 탭하는 것은 애초에
 * 이 계약의 표본이 아니다**.
 */
function onCanvas(t: Token): boolean {
  return t.px - t.r >= 0 && t.px + t.r <= 1050 && t.py - t.r >= 0 && t.py + t.r <= 680;
}

function pickFar(list: Token[], team: "home" | "away", side: "left" | "right"): Token {
  const mine = list.filter((t) => t.team === team && onCanvas(t));
  expect(mine.length, `${team} 팀에 캔버스 안에 그려진 토큰이 없다 — 표본 전제`).toBeGreaterThan(0);
  mine.sort((a, b) => (side === "left" ? a.px - b.px : b.px - a.px));
  return mine[0]!;
}

test.use({ viewport: { width: 390, height: 844 } });

test("① 내 선수를 누르면 그 선수에게만 링이 붙고 정보 카드가 뜬다", async ({ page }) => {
  await open(page);
  const all = await tokens(page);
  const target = pickFar(all, "home", "left"); // 홈 = 나(목 닉네임 대조)
  await tapToken(page, target);

  const rings = await drawnRings(page);
  expect(rings, "링은 정확히 1개").toHaveLength(1);
  expect(rings[0]!.id).toBe(target.id);
  expect(rings[0]!.team).toBe("home");
  expect(rings[0]!.mine, "내 팀 스타일").toBe(true);

  const card = page.getByTestId("arena-player-card");
  await expect(card).toHaveAttribute("data-player", target.id);
  await expect(card).toHaveAttribute("data-mine", "true");
  await expect(page.getByTestId("arena-player-who")).toHaveText("내 선수");
  // 이름은 **카탈로그 초크포인트**를 거친 값이다 — id 가 새 나오면 안 된다(#406 요구 6).
  const name = await page.getByTestId("arena-player-name").textContent();
  expect(name).toMatch(/^한글선수\d+$/);
  expect(name).not.toContain(target.id);
});

test("② 상대 선수도 같은 조작으로 — 다만 **열람 전용**으로 갈린다", async ({ page }) => {
  await open(page);
  const all = await tokens(page);
  const opp = pickFar(all, "away", "right");
  await tapToken(page, opp);

  const rings = await drawnRings(page);
  expect(rings).toHaveLength(1);
  expect(rings[0]!.id).toBe(opp.id);
  expect(rings[0]!.team).toBe("away");
  expect(rings[0]!.mine, "상대 스타일(내 선수 아님)").toBe(false);
  await expect(page.getByTestId("arena-player-card")).toHaveAttribute("data-mine", "false");
  await expect(page.getByTestId("arena-player-who")).toHaveText("상대 선수");
  await expect(page.getByTestId("arena-player-note")).toContainText("열람");
});

test("③ 좌표 변환: 피치 좌우 끝을 눌러도 **그 자리의 선수**가 켜진다(축소·레터박스)", async ({ page }) => {
  await open(page);
  const all = await tokens(page);
  const left = pickFar(all, "home", "left");
  const right = pickFar(all, "away", "right");

  await tapToken(page, left);
  let rings = await drawnRings(page);
  expect(rings.map((r) => r.id), "왼쪽 끝 탭 → 왼쪽 끝 선수").toEqual([left.id]);
  // 화면 왼쪽 절반에서 눌렀는데 오른쪽 절반 선수가 켜지면 변환이 깨진 것이다.
  expect(left.px).toBeLessThan(525);

  await tapToken(page, right);
  rings = await drawnRings(page);
  const away = rings.find((r) => r.team === "away");
  expect(away?.id, "오른쪽 끝 탭 → 오른쪽 끝 선수").toBe(right.id);
  expect(right.px).toBeGreaterThan(525);
});

test("④ 팀당 1명 · 재탭 해제 · 카드 ✕ 로 전체 해제", async ({ page }) => {
  await open(page);
  const all = await tokens(page);
  const h = pickFar(all, "home", "left");
  const a = pickFar(all, "away", "right");

  await tapToken(page, h);
  await tapToken(page, a);
  expect((await drawnRings(page)).length, "홈·어웨이 동시 선택").toBe(2);

  await tapToken(page, a); // 같은 선수 재탭 = 해제
  let rings = await drawnRings(page);
  expect(rings.map((r) => r.team)).toEqual(["home"]);

  await page.getByTestId("arena-player-close").click();
  rings = await drawnRings(page);
  expect(rings, "카드 ✕ = 전체 해제").toHaveLength(0);
  await expect(page.getByTestId("arena-player-card")).toHaveCount(0);
});

test("⑤ 390px 지오메트리 — 카드가 화면 안에 있고 시크바를 덮지 않는다 · 얼굴 아트 0", async ({ page }) => {
  await open(page);
  const all = await tokens(page);
  // **가장 앞선 내 선수** — 무대 오른쪽이라 카드(왼쪽 위)와 겹칠 일이 없다. 표본을 고정해야
  // 아래 시크바 단언이 "기본 자리의 기하"를 재는 것으로 남는다(#406 W6 MAJOR-A 이후 카드는
  // 링을 피해 자리를 옮긴다 — 옮긴 자리를 재면 이 계약이 무엇을 재는지가 매 로그마다 달라진다).
  await tapToken(page, pickFar(all, "home", "right"));

  const card = page.getByTestId("arena-player-card");
  await expect(card, "전제: 카드가 기본 가장자리에 있다").toHaveAttribute("data-side", "left");
  await expect(card, "전제: 카드가 기본 윗줄에 있다").toHaveAttribute("data-top", "34");
  const cb = (await card.boundingBox())!;
  expect(cb, "카드가 실제로 그려졌다").toBeTruthy();
  expect(cb.width).toBeGreaterThan(80);
  expect(cb.x, "왼쪽 밖으로 안 나간다").toBeGreaterThanOrEqual(0);
  expect(cb.y).toBeGreaterThanOrEqual(0);
  expect(cb.x + cb.width, "오른쪽 밖으로 안 나간다").toBeLessThanOrEqual(390 + 1);
  expect(cb.y + cb.height).toBeLessThanOrEqual(844 + 1);

  // 과거 전용 시크바(#406 W3)는 무대 아래 가장자리에 있다 — 세로로 겹치면 둘 다 못 쓴다.
  const seek = page.getByTestId("viewer-seek-bar-half2");
  const sb = await seek.boundingBox();
  if (sb) expect(cb.y + cb.height, "시크바 위에서 끝난다").toBeLessThanOrEqual(sb.y + 1);

  // #285 — 임계 아래(BRONZE) 선수라 카드에도 얼굴이 없다. 하이라이트가 정책의 우회로가 되면 안 된다.
  expect(await card.locator("img").count(), "카드에 아트 이미지 0").toBe(0);
});

/**
 * ⑧ **카드가 그 아래 선수의 탭을 삼키지 않는다**(독립검증 m-6).
 *
 * 카드는 무대 한 귀퉁이를 **200×76px**(내 선수 · 390 폰 실측, W7 m-8 재측정. 상대 208×76 ·
 * 미상 152×76) 덮는다. 390 폰에서 그 자리엔 토큰이 여럿 들어가는데,
 * `pointer-events: auto` 이던 동안 그 선수들은 **선택 자체가 불가능**했다 — 요구 5-2("아무 선수나
 * 눌러 누군지 본다")의 실사용 손실이다. 카드 본문은 읽기 전용이므로 포인터를 통과시키고 조작
 * 요소(✕·선수 정보)만 받는다.
 */
test("⑧ 카드 아래에 깔린 선수도 눌러서 선택된다 (카드가 탭을 삼키지 않는다)", async ({ page }) => {
  await open(page);
  const all = await tokens(page);
  // 먼저 오른쪽 끝 선수를 골라 **카드를 띄운다**(카드는 왼쪽 위에 뜬다).
  const shown = pickFar(all, "away", "right");
  await tapToken(page, shown);
  const card = page.getByTestId("arena-player-card");
  await expect(card).toHaveCount(1);
  const box = (await card.boundingBox())!;
  expect(box, "카드가 떠 있어야 이 계약이 성립한다").toBeTruthy();

  // 카드 사각형 **안쪽**에 떨어지는 토큰을 찾는다(= 종전이면 탭이 카드에 먹히던 선수).
  // 이미 켜 둔 선수는 뺀다 — 그걸 다시 누르면 **해제**라 축이 뒤집힌다.
  const under: Token[] = [];
  for (const t of all) {
    if (t.id === shown.id && t.team === shown.team) continue;
    const p = await clientPointOf(page, t.px, t.py);
    if (p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height) under.push(t);
  }
  console.log(`[m-6] 카드(${box.width.toFixed(0)}×${box.height.toFixed(0)}) 아래 토큰 ${under.length}개`);
  expect(under.length, "카드 아래에 토큰이 있어야 표본이 성립한다").toBeGreaterThan(0);

  const target = under[0]!;
  await tapToken(page, target);
  const rings = await drawnRings(page);
  expect(rings.map((r) => `${r.team}:${r.id}`), "카드 밑 선수가 실제로 켜졌다").toContain(
    `${target.team}:${target.id}`,
  );
});

/**
 * ⑥ 하프가 바뀌면 선택이 남지 않는다(유령 카드 금지).
 *
 * ⚠️ **초판은 `page.reload()` 로 쟀고 그건 어떤 구현이든 통과시킨다**(독립검증 MAJOR-4) —
 * 전체 내비게이션이라 React 트리가 통째로 사라져 **리셋을 지워도 red 가 안 났다**.
 *
 * <h3>이 계약이 지키는 리셋은 `StageShell` 것이다 (W10 2R 정정)</h3>
 * 여기 원래 *"`VisualPlayback` 의 `useEffect(…, [log, half])` 리셋"* 이라 적혀 있었는데 **stale
 * 이다** — W9 가 선택 상태를 셸로 들어올린 뒤(controlled) 그 effect 의 리셋 줄은
 * `if (!selectionProp) setInnerSelection([])` 라 **출하 배선에서는 한 번도 실행되지 않는다**
 * (독립검증 실측: 그 effect 를 통째로 지워도 이 파일 **16/16 green**). 지금 계약 ⑥ 을 살리는 것은
 * `match/stage/StageShell.tsx` 의 `useEffect(… , [half])`(`setSelection([])` +
 * `setBriefTarget(null)`)이고, **그걸 지우면 red** 다. `StageShell` 쪽 주석은 처음부터 그렇게
 * 적혀 있었으니 두 문서가 서로 반대 사실을 말하고 있었다.
 *
 * ⚠️ `VisualPlayback` 의 그 effect 는 **죽은 코드가 아니다** — 살아 있는 유일한 소비자가
 * `qa/QaConsolePage.tsx` 의 **uncontrolled** 사용(`selection` prop 을 안 넘긴다)이다. 그래서
 * 지우지 말고, 다만 **이 계약이 재는 축은 아니다**.
 *
 * <h3>실제 축을 찾는 데 한 번 더 틀렸다 — 그 실패가 이 주석의 알맹이다</h3>
 * 처음엔 "전반 → 후반 상태 전이"로 바꿨는데 그것도 **부품을 언마운트한다**: `MatchViewer` 는
 * 새 하프 로그를 받는 동안 `isLoading` 가지(`경기 기록 불러오는 중…`)를 그리므로 무대가
 * 통째로 사라졌다가 새로 난다. 즉 그 경로에서 선택이 지워지는 이유는 **리셋 이펙트가 아니라
 * 언마운트**고, 계약은 다시 `reload()` 와 같은 것이 된다(실측: 표지 attribute 소멸).
 *
 * 리셋 이펙트가 **실제로 일하는** 경로는 로그가 **이미 캐시된** 하프로 갈아탈 때다
 * (`useHalfLog` 는 `staleTime: ∞` — 캐시 히트면 `isLoading` 이 서지 않아 로딩 가지가 안 뜬다).
 * 그래서 전반 → 후반 → **전반**(웜 캐시)으로 돈다: 마지막 전이에서 `VisualPlayback` 은
 * 마운트를 유지한 채 `log`·`half` prop 만 갈리고, 캔버스는 `key` 로 새로 나 **코어 링은
 * 사라지는데 React 상태(카드)는 남는** 그 조합이 정확히 재현된다.
 *
 * 표지(`data-p406-probe`)는 그 전제를 **테스트가 스스로 검사**하게 한다 — 앱이 나중에 로딩
 * 가지를 바꿔 전제가 무너지면 조용히 공허해지지 않고 여기서 빨강이 난다.
 */
test("⑥ 하프가 바뀌면 선택이 남지 않는다(유령 카드 금지) — 재로드 없이, 부품이 살아 있는 전이로", async ({ page }) => {
  const mock = await open(page, "FIRST_HALF");

  // ① 후반으로 한 번 다녀와 **후반 로그를 캐시에 올린다**(이 전이는 언마운트 경로 — 여기선 안 잰다).
  mock.state = "SECOND_HALF";
  await settleHalf(page, 2);

  // ② 후반에서 고른다.
  await tapToken(page, pickFar(await tokens(page), "home", "left"));
  await expect(page.getByTestId("arena-player-card")).toHaveCount(1);
  expect((await drawnRings(page)).length, "후반에서 링이 실제로 켜졌다").toBe(1);
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid^="viewer-visual-half"]') as HTMLElement | null;
    if (el) el.dataset.p406Probe = "1";
  });

  // ③ **캐시된** 전반으로 되돌아간다 → 로딩 가지가 안 뜨고 부품은 마운트를 유지한다.
  mock.state = "FIRST_HALF";
  await settleHalf(page, 1);

  // 전제 — 정말 **마운트된 채로** 하프가 갈렸다. 아니면 이 계약은 `reload()` 와 같은 것이 된다.
  const survived = await page.evaluate(
    () => (document.querySelector('[data-testid^="viewer-visual-half"]') as HTMLElement | null)?.dataset.p406Probe ?? null,
  );
  expect(survived, "무대 부품이 언마운트되지 않고 half·log prop 만 갈렸다(웜 캐시 경로)").toBe("1");

  await expect(page.getByTestId("arena-player-card"), "유령 카드 0").toHaveCount(0);
  expect((await drawnRings(page)).length, "코어 링 0").toBe(0);
});

/**
 * 이 무대에서 **뜰 수 있는 모든 탭 이름**과 그 testid. 문구가 이 중 하나를 부르면 그 탭이
 * **지금 화면에 있어야** 한다 — 아래 ⑦ 의 성질이 그것이다.
 * (`stage-state.tabsFor` 의 4상태 표 = `apps/web/CLAUDE.md` §"경기 화면 정보 시트".)
 */
const TAB_PLACES: ReadonlyArray<{ label: string; testid: string }> = [
  { label: "후반 지시", testid: "stage-tab-brief" },
  { label: "감독", testid: "stage-tab-halftime" },
  { label: "경기장면", testid: "stage-tab-stage" },
  { label: "결과", testid: "stage-tab-result" },
  { label: "통계", testid: "stage-tab-stats" },
  { label: "로그", testid: "stage-tab-log" },
];

/**
 * **성질** — 문구가 이름으로 부르는 자리는 지금 화면에 실제로 있어야 한다.
 *
 * ⚠️ 토큰 존재(`/경기 중/`)로 걸지 않는다. W6 이 그렇게 걸었고, 그래서 후반에서 **거짓인**
 *    문구가 통과했다(W7 m-4). 여기서는 문구가 어떤 낱말을 쓰든 **그 자리의 실재**를 묻는다.
 */
async function expectNoteNamesOnlyPresentPlaces(page: Page, note: string, where: string) {
  for (const place of TAB_PLACES) {
    if (!note.includes(place.label)) continue;
    const n = await page.getByTestId(place.testid).count();
    expect(n, `${where}: 문구가 [${place.label}] 을 가리키는데 그 자리가 화면에 없다 — "${note}"`).toBeGreaterThan(0);
  }
  expect(note, `${where}: 방향으로 가리키는 자리가 있다 — "${note}"`).not.toMatch(/(아래|위)\s*\[?(후반 지시|감독|결과|경기장면)/);
}

/**
 * ⑦ 내 선수 카드의 안내 문구가 **이 상태에서 참**이다(MAJOR-3 → W6 m2 → W7 m-4).
 *
 * <h3>같은 문구가 세 번 왕복했다 — 그래서 계약을 성질로 다시 세웠다</h3>
 * ① W4 *"지시는 **아래** [후반 지시] 탭에서"* → 후반에 없는 탭 ② *"전반의 [후반 지시] 탭과
 * 감독시간의 [감독] 패널"* → `FINISHED` 에서 거짓 ③ W6 *"지시는 **경기 중** [후반 지시]·[감독]
 * 패널에서 씁니다"* → **`SECOND_HALF` 에서 거짓**(후반엔 두 자리 다 없다. 이 테스트가 스스로
 * 후반에서 `stage-tab-brief` count 0 을 단언한다). ③ 은 정밀도를 내주고 FINISHED 를 산 것이고,
 * 그게 통과한 이유는 계약이 **`/경기 중/` 토큰 존재**만 봤기 때문이다.
 *
 * 이제 세 상태 **각각**에서 위 성질을 건다 — 문구가 부르는 자리는 그 화면에 있어야 한다.
 * ①②③ 전부 여기서 죽는다. 그리고 ⓑ 세 상태의 문구가 **같아야** 한다(상태별로 갈아 끼우는
 * 수리 = prop 개통을 배제).
 */
test("⑦ 내 선수 카드 문구가 상태와 무관하게 참이다 (없는 탭을 가리키지 않는다)", async ({ page }) => {
  const mock = await open(page, "SECOND_HALF");
  const all = await tokens(page);
  await tapToken(page, pickFar(all, "home", "left"));
  const note = page.getByTestId("arena-player-note");
  await expect(note).toBeVisible();
  const inSecond = (await note.textContent())!.trim();

  // 후반에는 `후반 지시` 탭이 없다 — 이 전제가 깨지면 아래 단언이 공허하다.
  await expect(page.getByTestId("stage-tab-brief"), "후반엔 [후반 지시] 탭이 없다").toHaveCount(0);
  await expect(page.getByTestId("stage-tab-halftime"), "후반엔 [감독] 탭도 없다").toHaveCount(0);
  await expectNoteNamesOnlyPresentPlaces(page, inSecond, "SECOND_HALF");

  // 전반으로 돌아가도 **같은 문구** — 상태별로 갈아 끼우는 수리를 배제한다.
  mock.state = "FIRST_HALF";
  await settleHalf(page, 1);
  await expect(page.getByTestId("stage-tab-brief"), "전반엔 [후반 지시] 탭이 있다").toHaveCount(1);
  // 하프 전이 직후엔 라이브 시계 게이트가 플레이헤드를 한 번 더 옮길 수 있어 좌표가 낡는다 —
  // **좌표를 다시 읽고** 카드가 뜰 때까지 최대 3회 겨눈다(#318 하네스 경합과 같은 부류).
  const card1 = page.getByTestId("arena-player-card");
  for (let i = 0; i < 3 && (await card1.count()) === 0; i++) {
    await tapToken(page, pickFar(await tokens(page), "home", "left"));
    await page.waitForTimeout(150);
  }
  await expect(card1, "전반에서도 카드가 떠야 문구를 비교할 수 있다").toHaveCount(1);
  const inFirst = (await page.getByTestId("arena-player-note").textContent())!.trim();
  expect(inFirst, "전·후반이 같은 문구(상태 무관하게 참)").toBe(inSecond);
  await expectNoteNamesOnlyPresentPlaces(page, inFirst, "FIRST_HALF");

  /*
   * ⚠️ **종료 상태**(#406 W6 m2). 그 문구 *"지시는 전반의 [후반 지시] 탭과 감독시간의 [감독]
   * 패널에서 씁니다"* 는 `FINISHED` 에서 **둘 다 불가능**하다.
   *
   * 계약은 문안을 통째로 박지 않는다(그러면 hero 조정마다 red 다) — 위 **성질**로 건다.
   */
  mock.state = "FINISHED";
  await settleHalf(page, 2);
  const cardF = page.getByTestId("arena-player-card");
  for (let i = 0; i < 3 && (await cardF.count()) === 0; i++) {
    await tapToken(page, pickFar(await tokens(page), "home", "left"));
    await page.waitForTimeout(150);
  }
  await expect(cardF, "종료 화면에서도 무대는 남고 선수를 고를 수 있다").toHaveCount(1);
  // 전제 — 종료 상태에는 두 자리가 **하나도 없다**. 있으면 아래 성질이 공허하다.
  await expect(page.getByTestId("stage-tab-brief"), "종료엔 [후반 지시] 탭이 없다").toHaveCount(0);
  await expect(page.getByTestId("stage-tab-halftime"), "종료엔 [감독] 탭이 없다").toHaveCount(0);

  const inFinished = (await page.getByTestId("arena-player-note").textContent())!.trim();
  expect(inFinished, "종료에서도 같은 문구(상태 무관하게 참인 한 문장)").toBe(inSecond);
  await expectNoteNamesOnlyPresentPlaces(page, inFinished, "FINISHED");
  console.log(`[m-4] 세 상태 공통 내 선수 문구: "${inSecond}"`);
});

/**
 * ⑨ **카드가 방금 고른 그 선수의 링을 덮지 않는다** (#406 W6 MAJOR-A).
 *
 * <h3>왜 이 계약이 없었나</h3>
 * ⑤ 는 카드가 뷰포트 안인지·시크바를 안 덮는지만 쟀고, ⑧ 은 카드 밑 선수를 **누를 수 있는지**만
 * 쟀다 — m-6 수리는 *"가려도 누를 수는 있다"* 에서 끝났고 <b>"가려도 보이는가"는 아무도 안
 * 물었다</b>. ⑧ 은 심지어 카드 아래 토큰 4개를 로그로 찍으면서 묻지 않는다. 독립검증 실측으로
 * <b>22탭 중 7건</b>(전부 홈 = 내 선수)에서 선택 토큰 중심이 카드 사각 안이었다.
 *
 * <h3>어떻게 재나</h3>
 * ⓐ 카드가 **기본 자리(왼쪽 위)** 에 있을 때의 사각을 실측한다(상수를 앱에서 import 하지 않는다 —
 *   그러면 여백 변이가 계약과 함께 움직여 통과한다).
 * ⓑ 그 사각 **안에 떨어지는 토큰**을 표본으로 모은다. <b>표본이 0 이면 이 계약은 공허하다</b> —
 *   그래서 개수를 먼저 단언한다.
 * ⓒ 표본을 하나씩 실제로 탭하고, 코어가 **그 프레임에 그린** 링(`selection()` 의 px·py·r)을 클라이언트
 *   좌표로 옮겨 카드 사각과 겹치는지 본다. 링 둘레를 32점으로 샘플해 **한 점도 카드 안에 없어야** 한다.
 * ⓓ 그중 최소 1건은 카드가 **실제로 비켰다**(`data-side@data-top ≠ left@34`) — 표본이 우연히 다른 곳에 있어서
 *   통과한 것이 아님을 가른다.
 */
test("⑨ 고른 선수의 링을 카드가 덮지 않는다 (카드가 비킨다)", async ({ page }) => {
  await open(page);
  const all = await tokens(page);

  /*
   * ⓐ 기본 자리 실측 — **내 선수** 카드로 잰다. 카드 크기는 내용에 따라 다르고(내 선수 쪽이 안내
   *   문구가 길어 더 크다) 결함이 난 쪽도 홈이었다. 가장 앞선 홈 선수는 무대 오른쪽이라 카드가
   *   비킬 이유가 없어 **기본 자리**가 나온다.
   */
  const anchor = pickFar(all, "home", "right");
  await tapToken(page, anchor);
  const card = page.getByTestId("arena-player-card");
  await expect(card).toHaveCount(1);
  await page.waitForTimeout(300); // 배치 폴 1주기
  await expect(card, "기준 자리 = 종전과 같은 왼쪽 위").toHaveAttribute("data-side", "left");
  await expect(card, "기준 자리 = 종전과 같은 윗줄").toHaveAttribute("data-top", "34");
  const home = (await card.boundingBox())!;
  expect(home, "카드가 실제로 그려졌다").toBeTruthy();

  // ⓑ 그 사각 안에 떨어지는 토큰들.
  const under: Token[] = [];
  for (const t of all) {
    if (t.id === anchor.id && t.team === anchor.team) continue;
    const p = await clientPointOf(page, t.px, t.py);
    if (p.x >= home.x && p.x <= home.x + home.width && p.y >= home.y && p.y <= home.y + home.height) {
      under.push(t);
    }
  }
  const stageBox = (await page.getByTestId("viewer-canvas-half2").boundingBox())!;
  /*
   * **예산** — 카드가 링을 못 피하는 형상인지 아닌지는 산수다. 무대 세로에서 위·아래 여백을 뺀
   * 자유 구간이 `카드높이 × 2 + (링반경 + 여유) × 2` 보다 커야 위/아래 중 한 줄이 반드시 비어
   * 있다. 이 단언이 있어야 "지금은 되는데 카드가 한 줄 길어지면 조용히 깨지는" 상태를 못 만든다.
   *
   * 여백 상수 4/44/5 는 `CARD_INSET`·`CARD_RING_CLEAR_PX` 와 **같은 값을 손으로 적은 것**이다 —
   * import 하면 여백을 키우는 변이가 계약과 함께 움직여 통과한다(초록거짓말 #2).
   *
   * ⚠️ **링 반경은 손으로 적지 않는다**(W7 m-5). W6 은 `((8 + 9 + 3) × w) / 1050` 이라 적었는데,
   *    가운데 9 는 코어의 `SELECT.ringGap` = **hero 가 조정하는 노브**다(그 값을 계약이 다시
   *    적으면 노브를 옮기는 날 예산이 조용히 어긋난다 — m1 이 팔레트에서 뽑아낸 것을 도로
   *    들여온 셈이다). 여기서는 **코어가 실제로 그린 반경**(`selection().r`, 맥동 위상까지 포함)을
   *    CSS 로 옮겨 쓴다. 아래 루프에서 여러 위상의 최댓값으로 한 번 더 검정한다.
   */
  const ringRcss = await ringRadiusCss(page, anchor);
  const budget = stageBox.height - 4 - 44;
  const needBudget = 2 * home.height + 2 * (ringRcss + 5);
  console.log(
    `[MAJOR-A] 무대 ${stageBox.width.toFixed(0)}×${stageBox.height.toFixed(0)} · 기본 카드 ` +
      `${home.width.toFixed(0)}×${home.height.toFixed(0)} @(${home.x.toFixed(0)},${home.y.toFixed(0)}) · ` +
      `예산 ${budget.toFixed(1)} vs 필요 ${needBudget.toFixed(1)} · ` +
      `그 안에 떨어지는 토큰 ${under.length}개 [${under.map((t) => `${t.team}:${t.id}`).join(", ")}]`,
  );
  expect(
    budget,
    `카드가 커져 링을 피할 자리가 없다(예산 ${budget.toFixed(1)} < 필요 ${needBudget.toFixed(1)}) — ` +
      `카드 높이 ${home.height.toFixed(0)}px 를 줄이거나 무대 여백을 다시 잡아라`,
  ).toBeGreaterThanOrEqual(needBudget);
  expect(under.length, "가려질 토큰이 없으면 이 계약은 공허하다 — 표본 전제").toBeGreaterThan(0);

  /*
   * ⓔ **자리 예절**(W7 m-6) — ⑤ 는 `data-side=left`/`data-top=34` 를 전제로 고정해서 비킨 자리
   *   (`right@` · `top=4` · 아랫줄 · 마지막 수단)의 **뷰포트 안·시크바 비침범**을 아무도 안 쟀다.
   *   여기서 표본마다 같이 잰다(순수 기하 전수는 `player-selection.test.ts` 의 격자 계약).
   */
  const seekBox = await page.getByTestId("viewer-seek-bar-half2").boundingBox();
  const places = new Set<string>();
  const etiquette: string[] = [];
  let ringRmax = ringRcss;

  let moved = 0;
  for (const t of under) {
    await page.getByTestId("arena-player-close").click(); // 매번 초기화(재탭 = 해제라 축이 뒤집힌다)
    await expect(page.getByTestId("arena-player-card")).toHaveCount(0);
    /*
     * ⚠️ **좌표를 다시 읽는다.** 라이브 시계 게이트(#406 W3)가 250ms 마다 플레이헤드를 앞으로
     *    밀어서, 루프 시작 때 잡아 둔 좌표는 몇 초 뒤엔 낡는다(실측: 3번째 표본에서 탭이 빗나가
     *    카드가 안 떴다). #318 하네스 경합과 같은 부류다.
     */
    await page.evaluate(() => (window as any).__viewer.pause());
    const fresh = (await tokens(page)).find((x) => x.id === t.id && x.team === t.team);
    expect(fresh, `${t.team}:${t.id} 토큰이 사라졌다`).toBeTruthy();
    await tapToken(page, fresh!);
    await expect(card).toHaveAttribute("data-player", t.id);
    await page.waitForTimeout(300);

    const place = `${await card.getAttribute("data-side")}@${await card.getAttribute("data-top")}`;
    if (place !== "left@34") moved++;
    places.add(place);
    const box = (await card.boundingBox())!;

    // ⓒ 코어가 **그린** 링을 클라이언트 좌표로. 둘레 32점 중 카드 안에 든 점 수.
    const ring = await ringCircleCss(page, t);
    expect(ring, "탭한 선수의 링이 실제로 그려졌다").toBeTruthy();
    if (ring!.r > ringRmax) ringRmax = ring!.r;
    const { covered, centerInside } = ringVsBox(ring!, box);
    console.log(
      `[MAJOR-A] ${t.team}:${t.id} → 자리=${place} · 링 중심(${ring!.x.toFixed(0)},${ring!.y.toFixed(0)}) r=${ring!.r.toFixed(1)} · ` +
        `카드@(${box.x.toFixed(0)},${box.y.toFixed(0)}) ${box.width.toFixed(0)}×${box.height.toFixed(0)} · 덮인 둘레점 ${covered}/32`,
    );
    expect(centerInside, `${t.team}:${t.id} 의 링 중심이 카드 안이다`).toBe(false);
    expect(covered, `${t.team}:${t.id} 의 링 둘레가 카드에 덮였다`).toBe(0);

    // ⓔ 그 비킨 자리도 화면 안이고 시크바를 안 덮는다.
    if (box.x < -0.5 || box.y < -0.5) etiquette.push(`${place}: 좌상단 밖 (${box.x.toFixed(0)},${box.y.toFixed(0)})`);
    if (box.x + box.width > 390 + 1) etiquette.push(`${place}: 오른쪽 밖 ${(box.x + box.width).toFixed(0)}`);
    if (box.y + box.height > 844 + 1) etiquette.push(`${place}: 아래 밖 ${(box.y + box.height).toFixed(0)}`);
    if (seekBox && box.y + box.height > seekBox.y + 1) {
      etiquette.push(`${place}: 시크바 침범 (카드밑 ${(box.y + box.height).toFixed(0)} > 시크바위 ${seekBox.y.toFixed(0)})`);
    }
  }

  // ⓓ 기제가 실제로 발화했다(고정 배치로 되돌리는 변이는 위 ⓒ 와 여기서 함께 죽는다).
  expect(moved, "카드가 한 번도 비키지 않았다면 표본이 우연히 통과한 것이다").toBeGreaterThan(0);
  console.log(`[m-6] 이 표본이 쓴 자리: ${[...places].join(" · ")} · 링 최대 반경 ${ringRmax.toFixed(1)}px`);
  expect(etiquette, `비킨 자리의 자리 예절 위반: ${etiquette.join(" / ")}`).toEqual([]);
  // 예산을 **관측된 최대 반경**으로 한 번 더 — 맥동 위상이 다른 표본들을 지나며 커진 값이다.
  expect(
    budget,
    `링 최대 반경(${ringRmax.toFixed(1)})까지 넣으면 예산이 모자란다 — 카드 높이 ${home.height.toFixed(0)}px 를 줄여라`,
  ).toBeGreaterThanOrEqual(2 * home.height + 2 * (ringRmax + 5));
});

/**
 * ⑪ **두 명을 동시에 선택해도 두 링이 다 보인다** (W7 BLOCKER-1).
 *
 * <h3>W6 이 닫은 것은 상태공간의 절반이었다</h3>
 * 이 화면은 팀당 1명씩 **동시 2명**을 1급으로 지원한다(계약 ④ 가 그 상태를 직접 단언한다).
 * 그런데 카드가 피하는 링은 `hooks.selection()` 에서 **카드가 보여주는 선수**(= 마지막에 누른
 * 선수) 하나로 좁혀져 있었다 — 두 번째를 누르면 카드가 두 번째만 피해 **기본 자리로 돌아와
 * 첫 번째 링을 100% 덮었다**(독립검증 실측 `DUAL-RING home:H1 중심카드안=true 덮인둘레 32/32`).
 *
 * <h3>왜 ⑨ 가 못 잡았나</h3>
 * ⑨ 는 매 표본 루프 첫 줄에서 `arena-player-close` 를 눌러 **항상 정확히 1명만** 선택한 상태로
 * 잰다 — **2선택 상태가 표본에 구조적으로 없다**(초록거짓말 #4 의 부류).
 *
 * <h3>표본</h3>
 * ⓐ 먼저 **기본 자리 사각 안에 있는 선수**를 고른다(그 한 명만으로도 카드는 비켜야 한다)
 * ⓑ 그 다음 **반대 팀의 먼 선수**를 고른다 — 그 링 하나만 보면 기본 자리로 충분하므로,
 *    "마지막 링만 피하는" 구현은 여기서 기본 자리로 되돌아가 ⓐ 를 덮는다.
 */
test("⑪ 홈+어웨이 동시 선택 — 먼저 고른 링도 카드에 덮이지 않는다", async ({ page }) => {
  await open(page);
  const all = await tokens(page);

  // 기본 자리 사각 실측(⑨ 와 같은 방법 — 무대 오른쪽 홈 선수는 카드가 비킬 이유가 없다).
  const anchor = pickFar(all, "home", "right");
  await tapToken(page, anchor);
  const card = page.getByTestId("arena-player-card");
  await expect(card).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(card, "기준 자리 = 왼쪽 위").toHaveAttribute("data-side", "left");
  await expect(card, "기준 자리 = 윗줄").toHaveAttribute("data-top", "34");
  const home = (await card.boundingBox())!;

  await page.getByTestId("arena-player-close").click();
  await expect(card).toHaveCount(0);

  /*
   * 표본은 **사각 가장 깊숙이** 있는 홈 토큰으로 고른다 — 라이브 게이트가 250ms 마다 플레이헤드를
   * 밀어서 선수가 조금씩 움직이므로(#318 부류), 경계에 걸친 토큰을 고르면 탭할 때쯤 사각 밖으로
   * 나가 "카드가 비킬 이유가 없는" 표본이 된다.
   */
  await page.evaluate(() => (window as any).__viewer.pause());
  const under: Array<{ t: Token; depth: number }> = [];
  for (const t of await tokens(page)) {
    if (t.team !== "home" || t.id === anchor.id) continue;
    const p = await clientPointOf(page, t.px, t.py);
    const depth = Math.min(p.x - home.x, home.x + home.width - p.x, p.y - home.y, home.y + home.height - p.y);
    if (depth > 0) under.push({ t, depth });
  }
  under.sort((a, b) => b.depth - a.depth);
  expect(under.length, "기본 자리에 깔리는 홈 토큰이 있어야 이 계약이 성립한다").toBeGreaterThan(0);

  const first = under[0]!.t;
  const second = pickFar(all, "away", "right");
  for (const t of [first, second]) {
    await page.evaluate(() => (window as any).__viewer.pause());
    const fresh = (await tokens(page)).find((x) => x.id === t.id && x.team === t.team);
    expect(fresh, `${t.team}:${t.id} 토큰이 사라졌다`).toBeTruthy();
    await tapToken(page, fresh!);
  }
  await page.waitForTimeout(300); // 배치 폴 1주기

  // 전제 — 정말 둘이 켜졌고, 카드는 **나중에** 고른 선수를 보여준다.
  const rings = await drawnRings(page);
  expect(rings.length, "홈+어웨이 두 링").toBe(2);
  await expect(card, "카드는 마지막에 누른 선수").toHaveAttribute("data-player", second.id);

  const box = (await card.boundingBox())!;
  const place = `${await card.getAttribute("data-side")}@${await card.getAttribute("data-top")}`;
  for (const t of [first, second]) {
    const ring = await ringCircleCss(page, t);
    expect(ring, `${t.team}:${t.id} 의 링이 그려졌다`).toBeTruthy();
    const { covered, centerInside } = ringVsBox(ring!, box);
    console.log(
      `[DUAL-RING] ${t.team}:${t.id} 중심카드안=${centerInside} 덮인둘레=${covered}/32 · 자리=${place} · ` +
        `카드@(${box.x.toFixed(0)},${box.y.toFixed(0)}) ${box.width.toFixed(0)}×${box.height.toFixed(0)}`,
    );
    expect(centerInside, `${t.team}:${t.id} 의 링 중심이 카드 안이다`).toBe(false);
    expect(covered, `${t.team}:${t.id} 의 링 둘레가 카드에 덮였다`).toBe(0);
  }
  // 기제가 발화했다 — 첫 번째 링이 기본 자리 안이므로 카드는 반드시 비켰어야 한다.
  expect(place, "두 링을 같이 보면 기본 자리는 답이 아니다").not.toBe("left@34");
});

/**
 * ⑫ **내 팀을 모르는 화면**(관전 중 봇전 등) — `mine` 3값이 코어까지 관통한다 (W7 MAJOR-1).
 *
 * <h3>이 상태는 합성이 아니다</h3>
 * `stage-state.ts:398` 이 *"둘 다 남의 팀인 화면"* 을 설계로 명시하고, 판정은 **닉네임 대조**다.
 * 그런데 이 파일의 목이 `/api/me` 닉네임을 `homeName` 과 같은 `"테스터"` 로 고정해 **`myTeamSide`
 * 가 null 이 될 수 없었다** — 그래서 `mine: mineOf(...)` 를 W6 이전(`=== true`)으로 되접는 변이가
 * 10/10 생존했고, `.unknown` 테두리 · `data-mine="unknown"` · 뱃지 생략이 전부 미검정이었다.
 * **목 닉네임 한 줄**이 표본을 만든다.
 */
test("⑫ 내 팀 미상 — 링은 3값 null, 카드는 점선 · 뱃지 없음 (거짓 표식 0)", async ({ page }) => {
  await open(page, "SECOND_HALF", "관전자");
  // 전제 — 정말 "둘 다 남의 팀"이다(스코어바 내 팀 칩이 없다).
  await expect(page.getByTestId("scorebar-my-team"), "내 팀을 모르는 화면").toHaveCount(0);

  const all = await tokens(page);
  const card = page.getByTestId("arena-player-card");
  for (const target of [pickFar(all, "home", "left"), pickFar(all, "away", "right")]) {
    await page.evaluate(() => (window as any).__viewer.pause());
    const fresh = (await tokens(page)).find((x) => x.id === target.id && x.team === target.team)!;
    await tapToken(page, fresh);
    await expect(card).toHaveAttribute("data-player", target.id);

    const rings = await drawnRings(page);
    const mine = rings.find((r) => r.id === target.id && r.team === target.team)?.mine;
    // ⚠️ 여기가 3값 관통의 유일한 관측점이다 — `=== true` 로 접으면 이 값이 `false` 가 된다.
    expect(mine, `${target.team}:${target.id} 코어 링의 mine 은 **모른다**여야 한다`).toBeNull();

    await expect(card, "카드도 같은 말을 한다").toHaveAttribute("data-mine", "unknown");
    await expect(page.getByTestId("arena-player-who"), "모르면 뱃지를 달지 않는다(#322)").toHaveCount(0);
    // 클래스 이름이 아니라 **그 클래스가 만드는 그림**으로 잰다(CSS 모듈 해시에 안 묶인다).
    const borderStyle = await card.evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(borderStyle, "`.unknown` = 점선 테두리(확정되지 않음)").toBe("dashed");
    const note = (await page.getByTestId("arena-player-note").textContent())!.trim();
    console.log(`[m6] ${target.team}:${target.id} mine=${mine} 테두리=${borderStyle} 문구="${note}"`);
    expect(note, "내/상대를 단정하지 않는다").not.toMatch(/내 선수|상대 선수|열람 전용/);

    await page.getByTestId("arena-player-close").click();
    await expect(card).toHaveCount(0);
  }
});

/**
 * ⑩ 카드 부제의 포지션이 **한글**이다(#406 W6 m7 · 요구 6).
 *
 * 목 카탈로그는 전원 `position: "MF"` 다 — 한글 이름 옆에 영문 enum 원문이 서 있었다.
 */
test("⑩ 카드 부제 포지션이 한글이다 (enum 원문 노출 0)", async ({ page }) => {
  await open(page);
  await tapToken(page, pickFar(await tokens(page), "home", "left"));
  const card = page.getByTestId("arena-player-card");
  await expect(card).toHaveCount(1);
  const text = (await card.textContent())!;
  expect(text, `카드 문구: "${text.replace(/\s+/g, " ").trim()}"`).toContain("미드필더");
  expect(text, "포지션 enum 원문이 그대로 노출됐다").not.toMatch(/\bMF\b/);
});

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * 요구 5-2 **후반** — 프롬프트(지시)를 쓸 때 그 선수가 피치에서 하이라이트된다 (#406 W9)
 *
 * hero 원문: *"경기중 내 선수를 선택하면(**프롬프트 입력**이나 선수 정보 열람 시) 그 선수가
 * 하이라이트돼 누가 선택됐는지 보이게."* W4~W7 이 닫은 것은 **열람** 쪽 절반이고, 여기가 나머지다.
 *
 * <h3>이 계약이 겨누는 결함</h3>
 * 지시 칩의 상태가 패널 **로컬**이면(W4 당시의 모양) 링을 켤 방법이 구조적으로 없다. 그래서 재는
 * 것은 문구가 아니라 **코어가 실제로 그린 링**(`hooks.selection()`)이다 — 배선(`StageShell` →
 * `MatchViewer` → `VisualPlayback.selection`)을 지우면 아래 셋이 전부 죽는다.
 *
 * <h3>동시 선택 규칙(`player-selection.ts` 머리말의 판정)도 여기서 잰다</h3>
 * 공존이다: 칩은 **내 팀 슬롯만** 쓰고 상대 열람 링은 살아 있다. `팀 전체` 는 사람이 아니라 끈다.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 */

/** `후반 지시` 탭을 연다(전반에만 있다 — `stage-state.briefTabVisible`). */
async function openBriefTab(page: Page) {
  const tab = page.getByTestId("stage-tab-brief");
  await expect(tab, "`후반 지시` 탭은 전반에만 있다").toHaveCount(1);
  await tab.click();
  await expect(page.getByTestId("stage-panel-brief")).toBeVisible();
  // 전제 — 칩이 실재해야 이 계약이 무언가를 재는 것이 된다(#284 매치 스냅샷 경로).
  await expect(page.getByTestId("brief-target-team")).toBeVisible();
}

test("⑬ 지시 대상 칩을 누르면 그 선수 링이 뜬다 · 칩을 바꾸면 따라간다 · `팀 전체`는 끈다", async ({ page }) => {
  await open(page, "FIRST_HALF", "테스터", "home");
  await openBriefTab(page);

  const [first, second] = [SIDE_IDS.home[3]!, SIDE_IDS.home[7]!];
  await page.getByTestId(`brief-target-${first}`).click();
  await expect.poll(async () => (await drawnRings(page)).map((r) => `${r.team}:${r.id}`)).toEqual([
    `home:${first}`,
  ]);
  // 내 팀 스타일까지 관통한다(3값 — `mineOf` 를 안 지나면 여기서 갈린다).
  expect((await drawnRings(page))[0]!.mine, "내 팀 스타일").toBe(true);
  // 프롬프트 칸도 같은 선수를 말한다(칩만 켜지고 대상이 안 바뀌는 상태를 배제).
  await expect(page.getByTestId(`brief-target-${first}`)).toHaveAttribute("aria-selected", "true");

  // 칩을 바꾸면 **하이라이트도 따라간다**(팀당 1명 불변식 — 두 개가 되면 안 된다).
  await page.getByTestId(`brief-target-${second}`).click();
  await expect.poll(async () => (await drawnRings(page)).map((r) => `${r.team}:${r.id}`)).toEqual([
    `home:${second}`,
  ]);

  // `팀 전체` = 사람이 아니다 → 아무도 지목하지 않는다(거짓 지목 0).
  await page.getByTestId("brief-target-team").click();
  await expect.poll(async () => (await drawnRings(page)).length).toBe(0);
});

test("⑭ 상대 열람 링과 **공존**한다 — 칩은 내 팀 슬롯만 쓴다", async ({ page }) => {
  await open(page, "FIRST_HALF", "테스터", "home");

  // ⓐ 먼저 피치에서 상대를 눌러 열람 링을 만든다(무대는 전반에 상시 표시다).
  const opp = pickFar(await tokens(page), "away", "right");
  await tapToken(page, opp);
  await expect.poll(async () => (await drawnRings(page)).map((r) => r.team)).toEqual(["away"]);

  // ⓑ 그 상태에서 지시 칩을 고른다 → 링이 **둘**이다(상대 열람 + 내 지시 대상).
  await openBriefTab(page);
  const mine = SIDE_IDS.home[5]!;
  await page.getByTestId(`brief-target-${mine}`).click();
  await expect
    .poll(async () => (await drawnRings(page)).map((r) => `${r.team}:${r.id}`).sort())
    .toEqual([`away:${opp.id}`, `home:${mine}`].sort());

  // ⓒ 칩을 바꿔도 상대 링은 그대로다(내 슬롯만 갈아치운다).
  await page.getByTestId(`brief-target-${SIDE_IDS.home[9]!}`).click();
  await expect
    .poll(async () => (await drawnRings(page)).map((r) => `${r.team}:${r.id}`).sort())
    .toEqual([`away:${opp.id}`, `home:${SIDE_IDS.home[9]!}`].sort());
});

/**
 * ⑮ **어웨이 라운드에서도 내 팀 쪽에 붙는다**(#322).
 *
 * 링 키는 `skinKeyOf(team, playerId)` 라 팀을 틀리면 **반대 팀 선수가 켜진다**(#324/#231 — 같은
 * playerId 가 양 팀에 동시에 뛴다). 칩은 팀을 모르므로 사이드는 `myTeamSide` 에서 와야 하고,
 * 그 판정은 **닉네임 대조**다(`stage-state.myTeamSide`). 목 닉네임을 `봇 FC` 로 주면 내 팀 = away 다.
 */
test("⑮ 어웨이 라운드: 칩 하이라이트가 **away 슬롯**에 붙는다", async ({ page }) => {
  await open(page, "FIRST_HALF", "봇 FC", "away");
  await expect(page.getByTestId("scorebar-my-team"), "내 팀 표식이 있는 화면").toHaveCount(1);
  await openBriefTab(page);

  const target = SIDE_IDS.away[4]!;
  await page.getByTestId(`brief-target-${target}`).click();
  const rings = await (async () => {
    await expect.poll(async () => (await drawnRings(page)).length).toBe(1);
    return drawnRings(page);
  })();
  expect(rings[0]!.team, "홈으로 붙으면 반대 팀 선수를 켜는 것이다").toBe("away");
  expect(rings[0]!.id).toBe(target);
  expect(rings[0]!.mine, "어웨이가 내 팀이다").toBe(true);
});

/**
 * ⑯ **떠 있는 컨트롤이 덮은 자리의 선수도 눌린다** (#406 W10 M-1).
 *
 * <h3>이 에픽의 다섯 번째 사각 — 아무도 이 자리를 안 쟀다</h3>
 * ⑧ 은 **정보 카드** 밑을 다루는데 카드는 `pointer-events:none` 이라 애초에 탭을 통과시킨다.
 * **떠 있는 버튼·시크바가 덮은 자리**는 어느 계약도 태우지 않았고, 그래서 독립검증이 폰에서
 * 이걸 실측했다(390×844 · 플레이헤드 15지점 · 화면 안 토큰 298):
 *
 * <pre>
 *   캔버스가 아닌 것 20 (6.7%) — highlight-toggle 17 · viewer-seek-half2 2 · match-skip 1
 *   1280×900 은 0 (0.0%)      — 폰에서만 컨트롤 층이 피치 세로의 절반 가까이를 덮는다
 * </pre>
 *
 * 그리고 그 탭은 **조용히 실패하지 않았다** — 하이라이트 토글이 눌려 릴이 켜지며 플레이헤드가
 * `3418 → 2746` 으로 튀었다. 유저에게는 *"선수를 눌렀는데 경기가 뒤로 갔다"* 다.
 *
 * <h3>계약을 `elementFromPoint === canvas` 로 걸지 않는 이유</h3>
 * 수리 방향은 **토큰 히트 우선순위**다(자리를 옮기면 폰 무대 세로를 114px 먹는다 —
 * `VisualPlayback.overlayTokenAt` 머리말이 대안과 대가를 다 적었다). 그 방향에서는 최상위 요소가
 * **여전히 컨트롤**이므로 그 프록시로 걸면 통과할 수 없다. 그래서 프록시가 아니라 **요구 자체**를
 * 잰다 — ①화면 안 토큰이 눌러서 켜지는가 ②누르면 **다른 일**이 일어나지 않는가. 그리고
 * ③컨트롤이 **여전히 눌리는가**(우선순위를 "언제나 가로채기"로 만들면 여기서 죽는다).
 *
 * ⚠️ **표본 전제를 테스트가 스스로 단언한다** — 덮인 자리가 0 이면 ①②는 공허하다.
 */

/** 클라이언트 좌표 → 캔버스 backing 좌표. 위 `clientPointOf` 의 역변환(같은 `contain` 규칙). */
async function backingPointOf(page: Page, cx: number, cy: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([x, y]) => {
      const cv = document.querySelector('[data-testid^="viewer-canvas-half"]') as HTMLCanvasElement;
      const rect = cv.getBoundingClientRect();
      const scale = Math.min(rect.width / cv.width, rect.height / cv.height);
      const originX = rect.left + (rect.width - cv.width * scale) / 2;
      const originY = rect.top + (rect.height - cv.height * scale) / 2;
      return { x: ((x as number) - originX) / scale, y: ((y as number) - originY) / scale };
    },
    [cx, cy],
  );
}

type Probed = Token & {
  cx: number;
  cy: number;
  onCanvas: boolean;
  blocker: string;
  /** 덮은 요소가 **토큰 우선 라우팅을 하는 컨트롤 층** 안인가(`data-p406-controls`). */
  inControls: boolean;
  /** 무대(캔버스 사각형) 가장자리까지 거리(CSS px) — 경계 이음새와 진짜 침범을 가른다. */
  edgeDist: number;
};

/**
 * 지금 그려진 토큰 중 **무대 안**인 것들과, 그 자리의 **최상위 요소**.
 *
 * 좌표는 `clientPointOf`(이 파일의 유일한 변환 SoT)로 만들고 페이지에서는 `elementFromPoint` 만
 * 돈다 — `contain` 산술을 여기서 또 적으면 앱과 조용히 갈린다(#218).
 */
async function probeTokens(page: Page): Promise<Probed[]> {
  const ts = await tokens(page);
  const pts: Array<{ t: Token; x: number; y: number }> = [];
  for (const t of ts) {
    const p = await clientPointOf(page, t.px, t.py);
    pts.push({ t, x: p.x, y: p.y });
  }
  const tops = await page.evaluate((list: Array<{ x: number; y: number }>) => {
    const cv = document.querySelector('[data-testid^="viewer-canvas-half"]') as HTMLCanvasElement;
    const rect = cv.getBoundingClientRect();
    return list.map(({ x, y }) => {
      const inStage = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      const el = inStage ? (document.elementFromPoint(x, y) as HTMLElement | null) : null;
      const owner = el?.closest("[data-testid]") as HTMLElement | null;
      return {
        inStage,
        onCanvas: el === cv,
        inControls: !!el?.closest("[data-p406-controls]"),
        blocker: el ? (owner?.getAttribute("data-testid") ?? el.tagName.toLowerCase()) : "none",
        edgeDist: Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y),
      };
    });
  }, pts.map(({ x, y }) => ({ x, y })));
  return pts
    .map(({ t, x, y }, i) => ({ ...t, cx: x, cy: y, ...tops[i]! }))
    .filter((r) => r.inStage);
}

/** 플레이헤드 틱 — "다른 일이 일어났나"의 축(릴이 켜지면 장면으로 점프한다). */
function curTick(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__viewer.cur().tick as number);
}

/**
 * ⑯ — **이 계약은 #456 B0 에서 방향이 뒤집혔다.**
 *
 * <p>구 계약은 *"떠 있는 컨트롤이 덮은 자리의 선수도 눌린다"* 였고, 그 근거는 W10 M-1 의
 * 판단이었다 — *"컨트롤을 캔버스 밖으로 내리면 폰 무대 세로를 114px 먹고, 무대 박스가 피치
 * 비율로 잡혀 있으니 `object-fit: contain` 이 좌우까지 줄여 피치 면적이 반이 된다"*.
 * 그래서 자리를 옮기는 대신 **히트 우선순위**로 풀었고, 이 스펙은 *"덮인 자리가 반드시 있어야
 * 표본이 성립한다"*(`byControls > 0`)를 전제로 걸고 있었다.
 *
 * <p>hero 판정(#456 B0)이 그 전제의 두 번째 문장을 무효로 만들었다 —
 * *"바는 경기장 밖으로 빼. 경기 안 가리게 **화면 늘려**달라 했잖아."*
 * 무대 행이 캔버스+컨트롤을 담고 **시트가 그만큼 양보**하므로 피치는 줄지 않는다
 * (`match-stage.spec.ts` h·i 가 그 둘을 한 쌍으로 잰다). 덮인 자리가 사라졌으니
 * 이 파일이 재는 것도 *"덮여도 닿는다"* 가 아니라 **"덮지 않는다"** 로 바뀐다.
 *
 * <p>⚠️ 히트 우선순위 라우팅(`overlayTokenAt`)은 **지우지 않았다** — admin 풀컨트롤
 * (`controlsOverlay`)은 여전히 무대 모서리에 겹치는 층이라 그 경로가 살아 있다. 다만 **플레이
 * 모드에서는 발화하지 않는 백스톱**이고, 그 사실이 곧 아래 ⓐ 다.
 */
test("⑯ #456 B0 — 컨트롤 층이 피치를 한 점도 덮지 않는다 · 컨트롤은 그대로 눌린다 (폰 스윕)", async ({ page }) => {
  await open(page);

  /*
   * ── ⓐ 스윕: 화면 안 토큰의 최상위 요소를 전수 분류.
   *
   * ⚠️ **플레이헤드를 흘려서 스윕하면 표본이 한 점에 붙는다** — 초판은 `play()` 220ms 를 15번
   *    돌렸는데 그 사이 공이 몇 m 움직일 뿐이라 15표본이 사실상 같은 배치였고(덮인 토큰이
   *    `away:A2` 하나 · blocker 도 `highlight-toggle` 하나), **시크바·스킵이 덮는 경우를 한 번도
   *    태우지 않았다**. 로그 과거 구간을 **넓게 seek** 해서 배치를 실제로 갈아 준다.
   *    (라이브 게이트가 미래를 잠그므로 과거 절반 안에서만 고른다 — #406 W3.)
   */
  const lastTick = LOG.tickSnapshots[LOG.tickSnapshots.length - 1]!.tick as number;
  const firstTick = LOG.tickSnapshots[0]!.tick as number;
  const blockers = new Map<string, number>();
  let sampled = 0;
  let covered = 0;
  let byControls = 0;
  const outsideLayer: string[] = [];
  const SWEEP = 15;
  for (let i = 0; i < SWEEP; i++) {
    const at = Math.round(firstTick + ((lastTick - firstTick) * 0.45 * i) / (SWEEP - 1));
    await page.evaluate((t: number) => {
      const v = (window as any).__viewer;
      v.pause();
      v.seek(t);
    }, at);
    for (const r of await probeTokens(page)) {
      sampled++;
      if (r.onCanvas) continue;
      covered++;
      blockers.set(r.blocker, (blockers.get(r.blocker) ?? 0) + 1);
      if (r.inControls) byControls++;
      else outsideLayer.push(`${r.team}:${r.id} ${r.blocker} 가장자리 ${r.edgeDist.toFixed(2)}px`);
    }
  }
  const pct = ((covered / Math.max(1, sampled)) * 100).toFixed(1);
  console.log(
    `[M-1] 표본 ${sampled} · 캔버스가 아닌 것 ${covered} (${pct}%) · 그중 컨트롤 층 ${byControls} · ` +
      `막은 요소 ${[...blockers].map(([k, n]) => `${k} ${n}`).join(" · ")}` +
      (outsideLayer.length ? `\n[M-1] 층 밖: ${outsideLayer.join(" | ")}` : ""),
  );
  expect(sampled, "표본이 0 이면 이 계약은 공허하다").toBeGreaterThan(100);
  expect(
    byControls,
    "컨트롤 층이 피치 위로 되돌아왔다 — #456 B0 은 '덮여도 닿는다'가 아니라 '덮지 않는다'다",
  ).toBe(0);
  /*
   * **컨트롤 층 밖**의 크롬(스코어바·패널)은 이 웨이브가 라우팅으로 구제할 수 없다 —
   * `VisualPlayback` 트리 밖이다. 셸은 그리드(`auto / 1fr / auto`)라 원래 겹치지 않고, 실제로
   * 걸리는 것은 **무대 사각형 경계에 정확히 선 토큰**뿐이다(실측 `stage-scorebar` · 가장자리
   * 0.00px = 캔버스 최상단 행. 유저가 토큰을 누르면 원판이 안쪽으로 뻗어 닿는다).
   * → 그래서 "경계 이음새(≤2px)뿐"을 단언한다. 크롬이 피치 **위로** 올라오면 여기서 red 다.
   */
  const intruders = outsideLayer.filter((s) => {
    const m = /가장자리 ([\d.]+)px$/.exec(s);
    return !m || Number(m[1]) > 2;
  });
  expect(intruders, "컨트롤 층 밖의 크롬이 피치 안쪽까지 덮었다 — 라우팅으로 못 고친다(레이아웃)").toEqual([]);

  /*
   * ── ⓑ 컨트롤은 **자기 자리에서 그대로 눌린다**.
   *
   * ⓐ 만 두면 컨트롤 층을 통째로 `pointer-events: none` 으로 만들거나 화면 밖으로 밀어내는
   * 구현이 통과한다("아무것도 안 덮으니 0"). 그래서 반대 방향을 같이 건다 — 컨트롤이 자기
   * 중심점에서 최상위 요소여야 한다.
   *
   * ⚠️ 클릭이 아니라 **히트테스트**로 잰다. 시크바는 `<input type="range">` 라 클릭이 곧
   * 플레이헤드 이동이고, 그 부작용을 이 계약이 떠안으면 라이브 게이트(#406 W3)와 다투게 된다.
   */
  const seek = page.getByTestId("viewer-seek-bar-half2");
  await expect(seek, "컨트롤 층에 시크바가 있어야 이 단언의 전제가 성립한다").toHaveCount(1);
  const sb = (await seek.boundingBox())!;
  const onTop = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number) as HTMLElement | null;
      return {
        tag: el?.tagName ?? "(없음)",
        testid: el?.dataset?.testid ?? null,
        inControls: !!el?.closest("[data-p406-controls]"),
      };
    },
    [sb.x + sb.width / 2, sb.y + sb.height / 2] as const,
  );
  expect(
    onTop.inControls,
    `시크바 중심을 눌러도 컨트롤이 최상위가 아니다 — 실제로 잡힌 것: ${onTop.tag}/${onTop.testid}`,
  ).toBe(true);
});

