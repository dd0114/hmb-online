import { test, expect } from "@playwright/test";
import { loadViewer, VIEWER_URL } from "./fixture";

/**
 * #324 — **렌더러가** 팀을 구분하는가(순수 함수가 아니라 배선).
 *
 * <p>독립검증 blocker-1(2R): `duplicate-id.test.ts` 는 `skinLookup`·`ownerSideOf` 같은 **헬퍼**만
 * 태웠고, `viewer.impl.mjs` 가 **그 헬퍼를 실제로 쓰는지**는 아무 데서도 검사하지 않았다. 그래서
 * 렌더러의 조회를 단독 키로 되돌려도 전 게이트가 green 이었다 — 특히 등번호 조회 한 줄은
 * hero 가 제보한 증상(어웨이 선수가 홈 등번호를 단다) 그 자체인데 무방비였다.
 *
 * <p>왜 기존 e2e 가 못 잡나: 데모·real 픽스처의 선수 id 가 `H0/A0` 라 **양 팀에 걸쳐 유일**하다.
 * 중복 id 경로를 구조적으로 밟지 못한다. 그래서 여기서 라이브 라인업 모양의 로그를 직접 주입한다
 * (#65 `loadMatchLog` 계약 — web 임베드가 쓰는 바로 그 경로).
 *
 * <p>단언은 "무엇이 그려졌나"를 그린 쪽에서 읽는다(`renderPlayersAt` 의 `num`,
 * `cardMarks`, `cam`) — 캔버스 변환을 밖에서 재구현하면 렌더와 조용히 어긋난다(#218 규율).
 */

/** 라이브 01KYSQP…S0RFTD 구성 축약: **P078 이 양 팀에** 있다(라이브 하프의 38%가 이 조건). */
const DUP_LOG = {
  configVersion: "dup-test@1",
  seed: "dup-1",
  finalScore: { home: 0, away: 0 },
  events: [
    { tick: 3, minute: 0, type: "foul", team: "away", playerId: "P078" },
    // ⚠️ **홈** 카드여야 결함이 드러난다 — 실경기 id 는 "P078" 이라 `playerId[0]==="H"` 추측이
    //    **항상 away** 를 내므로, away 카드로 재면 틀린 코드도 우연히 맞는다.
    { tick: 3, minute: 0, type: "card", team: "home", playerId: "P078", detail: "yellow" },
    // ⚠️ **어웨이** 카드도 필요하다 — 홈 카드만으로는 "첫 번째로 찾은 P078"(=스냅샷 순서상 홈)이
    //    우연히 정답이라, 팀 필터를 지워도 마크가 제자리에 그려진다.
    { tick: 6, minute: 0, type: "card", team: "away", playerId: "P078", detail: "yellow" },
    { tick: 8, minute: 0, type: "free_kick", team: "home" },
    // ⚠️ 앵커도 **양 팀**을 태운다 — 어웨이 파울만 있으면 "팀 필터 제거"(첫 매치=홈) 변이는 잡지만
    //    "항상 어웨이를 고르는" 반대 방향 변이가 통과한다(카드에서 배운 것과 같은 대칭 구멍).
    { tick: 12, minute: 0, type: "foul", team: "home", playerId: "P078" },
    { tick: 16, minute: 0, type: "free_kick", team: "away" },
  ],
  tickSnapshots: Array.from({ length: 20 }, (_, t) => ({
    tick: t,
    minute: 0,
    ball: { x: 20, y: 34 },
    ballOwner: "P078",
    players: [
      { playerId: "P074", team: "home", pos: { x: 5, y: 34 } },
      { playerId: "P078", team: "home", pos: { x: 21, y: 34 } }, // 공 옆
      { playerId: "P078", team: "away", pos: { x: 87, y: 20 } }, // 반대편·다른 y
      { playerId: "P116", team: "away", pos: { x: 99, y: 34 } },
    ],
  })),
};

/** 팀별로 **다른** 번호를 준다 — 팀 없이 조회하면 둘 중 하나가 남의 번호를 단다. */
const SKIN = {
  atlases: [],
  // 어웨이 P078 만 **셀**로 준다(번호 7). 렌더러가 byPlayer 를 팀 키로 조회하지 않으면 이 값을
  // 못 찾거나 홈 P078 에도 붙는다 — 아틀라스 없이도 `entry.num` 경로가 그대로 태워진다.
  byPlayer: { "away:P078": { col: 0, row: 0, num: "7" } },
  nums: { "home:P074": "1", "home:P078": "3", "away:P078": "5", "away:P116": "1" },
  atlasUrl: "",
  tile: 0,
};

async function inject(page: import("@playwright/test").Page) {
  await loadViewer(page, VIEWER_URL);
  await page.evaluate((log) => window.postMessage({ type: "loadMatchLog", matchLog: log }, "*"), DUP_LOG);
  await page.waitForFunction(
    (n) => (window as any).__viewer?.ready() && (window as any).__viewer.events().length === n,
    DUP_LOG.events.length,
    { timeout: 15000 },
  );
  await page.evaluate((skin) => (window as any).__viewer.setSkin(skin), SKIN);
}

test("중복 playerId: 토큰 등번호가 **자기 팀** 것으로 그려진다 (hero 제보 증상)", async ({ page }) => {
  await inject(page);
  const drawn = await page.evaluate(() => (window as any).__viewer.renderPlayersAt(1));
  const home = drawn.find((p: any) => p.id === "P078" && p.team === "home");
  const away = drawn.find((p: any) => p.id === "P078" && p.team === "away");
  expect(home, "홈 P078 토큰").toBeTruthy();
  expect(away, "어웨이 P078 토큰").toBeTruthy();
  // 팀 없이 조회하면 둘 다 먼저 걸린 쪽(=home "3")을 단다 — 그게 라이브에서 난 일이다.
  expect(home.num, "홈 P078 = nums 의 자기 팀 번호").toBe("3");
  // 어웨이는 **byPlayer 팀 키 셀**의 번호가 이긴다(entry.num 우선). 단독 키로 조회하면
  // 이 셀을 못 찾아 nums 로 떨어진다 → "5". 두 값이 다르므로 조회 경로가 갈린다.
  expect(away.num, "어웨이 P078 = 자기 팀 셀의 번호").toBe("7");
});

test("중복 playerId: 카드 side 가 이벤트 팀을 따른다 (id 첫 글자 추측 금지)", async ({ page }) => {
  await inject(page);
  const marks = await page.evaluate(() => {
    (window as any).__viewer.seek(4);
    (window as any).__viewer.render();
    return (window as any).__viewer.cardMarks();
  });
  expect(marks.length, "카드 마크가 그려져야").toBeGreaterThan(0);
  const m = marks.find((c: any) => c.playerId === "P078");
  expect(m, "P078 카드 마크").toBeTruthy();
  expect(m.side, "이벤트 team=home 을 따라야(추측은 항상 away 를 낸다)").toBe("home");
  const drawn = await page.evaluate(() => (window as any).__viewer.curPlayers());
  const homeP078 = drawn.find((p: any) => p.id === "P078" && p.team === "home");
  expect(Math.abs(m.px - homeP078.px), "카드가 홈 P078 위에(어웨이 쪽이 아니라)").toBeLessThan(1);
});

test("중복 playerId: 어웨이 카드 마크는 **어웨이** 선수 위에 그려진다", async ({ page }) => {
  await inject(page);
  const { marks, players } = await page.evaluate(() => {
    (window as any).__viewer.seek(7);
    (window as any).__viewer.render();
    return {
      marks: (window as any).__viewer.cardMarks(),
      players: (window as any).__viewer.curPlayers(),
    };
  });
  const away = marks.find((c: any) => c.playerId === "P078" && c.side === "away");
  expect(away, "어웨이 P078 카드 마크").toBeTruthy();
  const awayP = players.find((p: any) => p.id === "P078" && p.team === "away");
  const homeP = players.find((p: any) => p.id === "P078" && p.team === "home");
  // 팀 필터가 없으면 렌더 순서상 **홈** P078 이 먼저 걸려 마크가 반대편에 그려진다.
  expect(Math.abs(away.px - awayP.px), "어웨이 선수 위에").toBeLessThan(1);
  expect(Math.abs(away.px - homeP.px), "홈 선수 위가 아니어야").toBeGreaterThan(10);
});

test("중복 playerId: 파울 접촉 줌이 **파울러 팀** 선수로 간다", async ({ page }) => {
  await inject(page);
  const cam = await page.evaluate(() => {
    (window as any).__viewer.autoPace(true);
    (window as any).__viewer.seek(3);
    (window as any).__viewer.render();
    return (window as any).__viewer.cam();
  });
  // 어웨이 P078 은 (87,20), 홈 P078 은 (21,34). 팀을 무시하면 홈 쪽으로 줌한다.
  expect(Math.abs(cam.cy - 20), `카메라 y=${cam.cy} — 어웨이 파울러(20) 쪽이어야`).toBeLessThan(
    Math.abs(cam.cy - 34),
  );
});

test("중복 playerId: 파울 토스트가 **파울러 팀** 선수에 붙는다", async ({ page }) => {
  await inject(page);
  const toasts = await page.evaluate(() => {
    (window as any).__viewer.seek(3);
    (window as any).__viewer.render();
    return (window as any).__viewer.toasts();
  });
  const foul = toasts.find((t: any) => t.anchor === "P078" && t.text.includes("FOUL"));
  expect(foul, "파울 토스트").toBeTruthy();
  expect(foul.anchorTeam).toBe("away");
  const drawn = await page.evaluate(() => (window as any).__viewer.curPlayers());
  const away = drawn.find((p: any) => p.id === "P078" && p.team === "away");
  const home = drawn.find((p: any) => p.id === "P078" && p.team === "home");
  // 두 P078 은 x 가 66m 떨어져 있다 — 앵커가 팀을 무시하면 홈 쪽에 붙는다.
  expect(Math.abs(foul.px - away.px), "토스트가 어웨이 파울러 위에").toBeLessThan(
    Math.abs(foul.px - home.px),
  );
});

test("중복 playerId: **홈** 파울이면 줌·토스트가 홈 선수로 간다 (앵커 대칭)", async ({ page }) => {
  await inject(page);
  const { cam, toasts, players } = await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.autoPace(true);
    v.seek(12);
    v.render();
    return { cam: v.cam(), toasts: v.toasts(), players: v.curPlayers() };
  });
  const home = players.find((p: any) => p.id === "P078" && p.team === "home");
  const away = players.find((p: any) => p.id === "P078" && p.team === "away");
  expect(Math.abs(cam.cx - home.x), `카메라 x=${cam.cx} — 홈 파울러(${home.x}) 쪽이어야`).toBeLessThan(
    Math.abs(cam.cx - away.x),
  );
  const foul = toasts.find((t: any) => t.anchor === "P078" && t.text.includes("FOUL"));
  expect(foul, "홈 파울 토스트").toBeTruthy();
  expect(foul.anchorTeam).toBe("home");
  expect(Math.abs(foul.px - home.px), "토스트가 홈 파울러 위에").toBeLessThan(Math.abs(foul.px - away.px));
});

/* ──────────────────────────────────────────────────────────────────────────────────────────
 * 행동 이펙트(#406 W5)의 **팀 축** — 여기가 그 계약의 자리다.
 *
 * ⚠️ `action-effects.spec.ts` 는 *"홈·어웨이 양쪽 표본을 태우니 방어된다"* 고 적어 뒀지만
 *    **사실이 아니었다**: `fixture-real` 의 선수 id 가 `H0..A10` 이라 `playerId[0]=== "H"` 추측이
 *    **우연히 맞는다**. 독립검증이 `fxSideOf` 를 그 추측으로 되돌리고 앵커의 팀 필터를 지운 변이를
 *    태웠는데 **41/41 통과하며 생존**했다(memory `fixture-ids-hide-live-defects` 재발).
 *    라이브 하프의 38%가 양 팀에 같은 id 를 태운다(#324) — 그 표본 위에서만 이 변이가 죽는다.
 *
 * 그래서 축을 **주입 로그(P078 양 팀)** 위로 옮긴다. 색은 `team` 이 SoT 인지, 앵커는 그 팀 선수
 * 위인지 두 가지를 잰다.
 * ────────────────────────────────────────────────────────────────────────────────────────── */

const HOME_RGB = "59,130,246";
const AWAY_RGB = "239,68,68";

/**
 * 행동 이벤트 4종을 **P078 양 팀**에 태운 로그. 두 P078 은 x 로 66m · y 로 14m 떨어져 있어
 * 앵커가 팀을 무시하면 좌표가 그만큼 어긋난다. 공은 둘 중 어느 쪽도 아닌 중앙에 둔다 —
 * 앵커가 공으로 떨어지는 회귀도 같이 잡힌다.
 */
const ACTION_LOG = {
  configVersion: "dup-fx@1",
  seed: "dup-fx-1",
  finalScore: { home: 0, away: 0 },
  events: [
    { tick: 10, minute: 0, type: "clearance", team: "home", playerId: "P078" },
    { tick: 25, minute: 0, type: "clearance", team: "away", playerId: "P078" },
    { tick: 40, minute: 0, type: "interception", team: "home", playerId: "P078" },
    { tick: 55, minute: 0, type: "interception", team: "away", playerId: "P078" },
    { tick: 70, minute: 0, type: "tackle", team: "home", playerId: "P078" },
    { tick: 85, minute: 0, type: "tackle", team: "away", playerId: "P078" },
  ],
  tickSnapshots: Array.from({ length: 100 }, (_, t) => ({
    tick: t,
    minute: 0,
    // 공은 중앙에서 천천히 흐른다 — 걷어내기 방향(다음 스냅샷 변위)이 0 이 아니어야 한다.
    ball: { x: 48 + (t % 10) * 0.4, y: 34 },
    ballOwner: null,
    players: [
      { playerId: "P074", team: "home", pos: { x: 5, y: 34 } },
      { playerId: "P078", team: "home", pos: { x: 21, y: 34 } },
      { playerId: "P078", team: "away", pos: { x: 87, y: 20 } },
      { playerId: "P116", team: "away", pos: { x: 99, y: 34 } },
    ],
  })),
};

const ANCHOR = {
  home: { x: 21, y: 34 },
  away: { x: 87, y: 20 },
} as const;

async function injectActions(page: import("@playwright/test").Page) {
  await loadViewer(page, VIEWER_URL);
  await page.evaluate((log) => window.postMessage({ type: "loadMatchLog", matchLog: log }, "*"), ACTION_LOG);
  await page.waitForFunction(
    (n) => (window as any).__viewer?.ready() && (window as any).__viewer.events().length === n,
    ACTION_LOG.events.length,
    { timeout: 15000 },
  );
}

/** startTick-1 부터 재생하며 fx() 에 type 이 나타나는 순간의 그 이펙트. */
async function playUntilFx(page: import("@playwright/test").Page, startTick: number, type: string) {
  await page.evaluate((t: number) => {
    const v = (window as any).__viewer;
    v.autoPace(false); v.pause(); v.seek(t - 1); v.play();
  }, startTick);
  const handle = await page.waitForFunction(
    (ty: string) => (window as any).__viewer.fx().find((f: any) => f.type === ty) ?? null,
    type,
    { timeout: 12000 },
  );
  const val = await handle.jsonValue();
  await page.evaluate(() => (window as any).__viewer.pause());
  return val as { type: string; rgb: string; x: number; y: number };
}

const FX_CASES = [
  { tick: 10, team: "home", fxType: "clear" },
  { tick: 25, team: "away", fxType: "clear" },
  { tick: 40, team: "home", fxType: "steal" },
  { tick: 55, team: "away", fxType: "steal" },
  { tick: 70, team: "home", fxType: "tackle" },
  { tick: 85, team: "away", fxType: "tackle" },
] as const;

test("중복 playerId: 행동 이펙트 색이 **이벤트 team** 을 따른다 (id 첫 글자 추측 금지)", async ({ page }) => {
  await injectActions(page);
  for (const c of FX_CASES) {
    const f = await playUntilFx(page, c.tick, c.fxType);
    // `playerId[0]==="H"` 추측은 "P078" 에서 **항상 away** 를 낸다 → 홈 3건이 전부 빨강이 된다.
    expect(f.rgb, `tick ${c.tick} ${c.fxType}/${c.team} 색`).toBe(c.team === "home" ? HOME_RGB : AWAY_RGB);
  }
});

test("중복 playerId: 행동 이펙트가 **그 팀** 선수 위에 뜬다 (반대편·공이 아니라)", async ({ page }) => {
  await injectActions(page);
  for (const c of FX_CASES) {
    const f = await playUntilFx(page, c.tick, c.fxType);
    const mine = ANCHOR[c.team];
    const other = ANCHOR[c.team === "home" ? "away" : "home"];
    // 팀 필터를 지우면 `find` 가 항상 먼저 걸리는 **홈** P078 을 집는다 → 어웨이 3건이 66m 어긋난다.
    expect(Math.hypot(f.x - mine.x, f.y - mine.y), `tick ${c.tick} ${c.fxType}/${c.team} 앵커`).toBeLessThan(1);
    expect(Math.hypot(f.x - other.x, f.y - other.y), "반대 팀 P078 위가 아니어야").toBeGreaterThan(10);
    expect(Math.abs(f.x - 50), "공(중앙) 위가 아니어야").toBeGreaterThan(10);
  }
});

test("중복 playerId: 행동 토스트 색·앵커가 **그 팀** 을 따른다", async ({ page }) => {
  await injectActions(page);
  const CASES = [
    { tick: 10, team: "home", text: "CLEARED!" },
    { tick: 25, team: "away", text: "CLEARED!" },
    { tick: 40, team: "home", text: "INTERCEPT" },
    { tick: 55, team: "away", text: "INTERCEPT" },
    { tick: 70, team: "home", text: "TACKLE" },
    { tick: 85, team: "away", text: "TACKLE" },
  ] as const;
  for (const c of CASES) {
    const got = await page.evaluate(
      ([tick, txt]: [number, string]) => {
        const v = (window as any).__viewer;
        v.seek(tick);
        v.redraw();
        const hits = v.toasts().filter((x: any) => x.text === txt);
        const players = v.curPlayers();
        return {
          n: hits.length,
          t: hits[0] ?? null,
          home: players.find((p: any) => p.id === "P078" && p.team === "home"),
          away: players.find((p: any) => p.id === "P078" && p.team === "away"),
        };
      },
      [c.tick, c.text] as [number, string],
    );
    expect(got.n, `tick ${c.tick} "${c.text}" 토스트 1개`).toBe(1);
    expect(got.t.col, `tick ${c.tick} ${c.text}/${c.team} 색`).toBe(
      `rgb(${c.team === "home" ? HOME_RGB : AWAY_RGB})`,
    );
    expect(got.t.anchorTeam).toBe(c.team);
    const mine = c.team === "home" ? got.home : got.away;
    const other = c.team === "home" ? got.away : got.home;
    expect(Math.abs(got.t.px - mine.px), "토스트가 그 팀 P078 위에").toBeLessThan(
      Math.abs(got.t.px - other.px),
    );
  }
});

/**
 * `koById`(킥오프 잔상 클립) — 골 후 킥오프 트윈이 **자기 팀** 위치로 가는가.
 *
 * ⚠️ 나는 이 자리를 "hold.tween 이 프레임 진행에 달려 결정론적 재현이 어렵다"며 공백으로 남겼다.
 * **틀린 판단이었다** — 독립검증이 기존 훅만으로 재현해 보였다. 핵심은 트윈 값을 결정론으로
 * 만들 필요가 없다는 것이다: 계약이 요구하는 성질은 *"보간 목표가 같은 팀인가"* 하나뿐이고,
 * 그건 **불변식**으로 잰다 — hold 동안 홈 선수의 렌더 x 최댓값. 정상은 12m 를 안 넘고, 팀키를
 * 지우면 어웨이 킥오프 위치 88m 로 끌려간다(마진 48m). 타이밍 흔들림이 개입할 여지가 없다.
 */
const KO_LOG = {
  configVersion: "dup-ko@1",
  seed: "ko-1",
  finalScore: { home: 1, away: 0 },
  events: [
    { tick: 20, minute: 0, type: "goal", team: "home", playerId: "P078" },
    { tick: 26, minute: 0, type: "kickoff", team: "away" },
  ],
  // 골 시점 홈 P078=10 · 어웨이 P078=90. 킥오프 스냅샷에선 12 / 88 — 두 자리가 76m 떨어져 있다.
  tickSnapshots: Array.from({ length: 40 }, (_, t) => ({
    tick: t,
    minute: 0,
    ball: { x: 50, y: 34 },
    ballOwner: null,
    players: [
      { playerId: "P078", team: "home", pos: { x: t >= 26 ? 12 : 10, y: 34 } },
      { playerId: "P078", team: "away", pos: { x: t >= 26 ? 88 : 90, y: 34 } },
      { playerId: "P116", team: "away", pos: { x: 95, y: 34 } },
    ],
  })),
};

test("중복 playerId: 킥오프 잔상 트윈이 **자기 팀** 킥오프 위치로 간다", async ({ page }) => {
  await loadViewer(page, VIEWER_URL);
  await page.evaluate((log) => window.postMessage({ type: "loadMatchLog", matchLog: log }, "*"), KO_LOG);
  await page.waitForFunction(() => (window as any).__viewer?.ready(), null, { timeout: 15000 });
  const seen = await page.evaluate(async () => {
    const v = (window as any).__viewer;
    v.autoPace(true);
    v.seek(18);
    v.play();
    const home: number[] = [];
    const away: number[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const ps = v.curPlayers();
      const h = ps.find((p: any) => p.id === "P078" && p.team === "home");
      const a = ps.find((p: any) => p.id === "P078" && p.team === "away");
      if (h) home.push(h.x);
      if (a) away.push(a.x);
      await new Promise((r) => setTimeout(r, 8));
    }
    v.pause();
    return { home, away };
  });

  /*
   * ⚠️ **"봤다"를 어떻게 증명하나**가 이 계약의 핵심이다.
   *
   * 처음엔 최댓값 하한(≥11.9)으로 걸었는데 **그건 아무것도 증명하지 않는다** — hold 가 끝나면
   * tickPos 가 킥오프 인덱스로 점프해 홈 P078 이 **스냅샷 값 12** 가 되므로, 트윈을 한 번도 못 봐도
   * 최댓값이 12 다(독립검증 실측: 트윈이 사라진 변이체에서도 max=12, 통과). 즉 하한이 막으려던
   * 시나리오가 바로 하한을 통과하는 시나리오였다.
   *
   * 진짜 판별기는 **끝점 사이의 값을 봤는가**다: 10 과 12 는 스냅샷 값이고, 그 **사이**는 보간
   * 중에만 존재한다. 정상 186개 / 트윈 소멸 0개로 갈린다. 이 한 줄이 "팀을 혼동하는 회귀"와
   * "잔상 연출이 조용히 죽는 회귀"를 **동시에** 잡는다.
   */
  const interior = seen.home.filter((x) => x > 10.001 && x < 11.999).length;
  expect(interior, `홈 P078 보간 중 관측 ${interior}개 — 킥오프 트윈을 실제로 봐야 한다`).toBeGreaterThan(0);
  expect(
    Math.max(...seen.home),
    `홈 P078 최대 x=${Math.max(...seen.home)} — 어웨이 킥오프 자리(88)로 끌려가면 안 된다`,
  ).toBeLessThan(40);
  // 대칭(독립검증 minor-3): 어웨이도 같이 잰다 — 홈만 재면 "어웨이가 홈 자리로 끌려가는" 변이를 놓친다.
  expect(
    Math.min(...seen.away),
    `어웨이 P078 최소 x=${Math.min(...seen.away)} — 홈 킥오프 자리(12)로 끌려가면 안 된다`,
  ).toBeGreaterThan(60);
});
