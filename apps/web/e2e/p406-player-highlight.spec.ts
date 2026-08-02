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

function clock(phase: MatchState = "SECOND_HALF") {
  const now = Date.now();
  const start = now - HALF_REAL_MS * 0.5;
  return {
    phase,
    kickoffAt: new Date(start).toISOString(),
    phaseStartAt: new Date(start).toISOString(),
    phaseEndsAt: new Date(start + HALF_REAL_MS).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: 180_000,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
  };
}

type MatchState = "FIRST_HALF" | "SECOND_HALF";
/**
 * 목 상태 핸들 — 테스트가 **경기 중에** 상태를 갈아 끼울 수 있게 한다(계약 ⑥).
 * `useMatch` 는 라이브 상태에서 1초 폴링이므로 이 값을 바꾸면 다음 폴에 앱이 따라온다.
 */
type MockState = { state: MatchState };

async function open(page: Page, initial: MatchState = "SECOND_HALF"): Promise<MockState> {
  const st: MockState = { state: initial };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 0, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state: st.state,
          scoreH1Home: 1,
          scoreH1Away: 0,
          scoreHome: null,
          scoreAway: null,
          result: null,
          createdAt: "2026-08-02T09:00:00Z",
          mode: "practice",
          // 홈 = 나(`myTeamSide` 는 닉네임 대조로 판정한다 — #322 `stage-state.myTeamSide`).
          ownerName: "테스터",
          homeName: "테스터",
          awayName: "봇 FC",
          opponent: { name: "봇 FC", deck: [] },
          clock: clock(st.state),
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

/** 코어가 **실제로 그린** 선택 링. */
function drawnRings(page: Page) {
  return page.evaluate(
    () => (window as any).__viewer.selection() as Array<{ id: string; team: string; mine: boolean; r: number }>,
  );
}

/**
 * 흐름 브릿지(#424)를 닫는다 — **상태 전이마다 무대 앞에 한 겹 생겼다.**
 *
 * `match-flow.BRIDGE_TABLE` 이 `FIRST_HALF → SECOND_HALF`(`h1_end`)와 `* → FINISHED`
 * (`match_end`)에서 오버레이를 띄우고, `StageShell` 은 그동안 무대를 **마운트하지 않는다**
 * (`!managing && !overlayOpen` — 팝업 뒤에서 캔버스가 도는 것을 구조적으로 0 으로 만든 결정).
 * 그래서 전이 뒤에 곧바로 캔버스를 기다리면 20초를 기다리다 죽는다.
 *
 * ⚠️ **계약을 느슨하게 한 것이 아니다** — 아래 단언들은 그대로다(종료 화면에서도 무대가 남고
 * 선수를 고를 수 있다 · 문구가 상태와 무관하게 참이다). 유저가 실제로 지나는 한 걸음
 * (브릿지 CTA)을 테스트도 지나게 한 것뿐이다. 스킵을 안 했으므로 리포트가 없는 스택이라
 * testid 접두가 `flow-bridge` 다(`MatchFlowOverlay` 의 `testIdBase` 규칙 — 리포트로 오인하면
 * #421 의 "스킵 안 하면 리포트가 안 뜬다" 계약이 무의미해진다).
 * ⚠️ 스택이라 카드가 여러 장일 수 있다 → CTA 가 사라질 때까지 누른다(상한을 둔다).
 */
/**
 * ⚠️ **한 번만 확인하고 넘어가면 안 된다** — 목 상태를 바꾼 직후엔 브릿지가 **아직 없다**.
 * `useMatch` 폴링(1초)이 새 상태를 보고 나서야 오버레이가 열리므로, 즉시 count 를 재면 0 이고
 * 그 다음 `toBeVisible` 이 20초를 헛되게 기다린다(실제로 그렇게 한 번 틀렸다).
 * 그래서 **무대가 뜰 때까지** 돌면서 브릿지가 보이면 그때그때 닫는다(스택이라 여러 장일 수 있다).
 */
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
  await tapToken(page, pickFar(all, "home", "left"));

  const card = page.getByTestId("arena-player-card");
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
 * 카드는 무대 왼쪽 위를 280×~120px 덮는다. 390 폰에서 그 자리엔 토큰이 여럿 들어가는데,
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
 * 전체 내비게이션이라 React 트리가 통째로 사라져 `VisualPlayback` 의
 * `useEffect(…, [log, half])` 리셋을 **지워도 red 가 안 났다**.
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
 * ⑦ 내 선수 카드의 안내 문구가 **이 상태에서 참**이다(독립검증 MAJOR-3).
 *
 * 초판은 *"지시는 **아래** [후반 지시] 탭에서 …"* 를 내 선수에게 항상 띄웠는데, 그 탭은
 * `briefTabVisible()` 상 `FIRST_HALF` 에서만 존재한다. 이 무대는 후반·종료에서도 쓰이므로
 * **없는 탭을 가리키는 문장**이 유저에게 그대로 나갔다(실브라우저 `state: SECOND_HALF` 캡처).
 *
 * 계약은 두 겹이다 — ⓐ 후반에서 "아래 탭에 있다"는 형태의 단정이 없다 ⓑ 전·후반 **양쪽에서**
 * 같은(=상태 무관하게 참인) 문구다. 문구를 후반에서만 손보고 전반은 옛 문장으로 두는 수리는
 * 여기서 죽는다.
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
  expect(inSecond, `후반 문구: "${inSecond}"`).not.toMatch(/아래\s*\[?후반 지시/);

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
});
