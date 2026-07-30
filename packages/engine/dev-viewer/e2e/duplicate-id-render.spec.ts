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
  const maxHomeX = await page.evaluate(async () => {
    const v = (window as any).__viewer;
    v.autoPace(true);
    v.seek(18);
    v.play();
    let mx = -1;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const h = v.curPlayers().find((p: any) => p.id === "P078" && p.team === "home");
      if (h) mx = Math.max(mx, h.x);
      await new Promise((r) => setTimeout(r, 8));
    }
    v.pause();
    return mx;
  });
  /*
   * ⚠️ 하한이 **계약의 절반**이다. 상한만 걸면, 병렬 부하로 샘플링이 트윈을 한 번도 못 본 경우
   * mx 가 골 이전 값(10)에 머물러 **아무것도 관측하지 않고 통과**한다(실측: 변이체가 그렇게 살아남았다).
   * 킥오프 자리(12)에 도달한 것을 함께 단언해 "봤다"를 증명한다.
   */
  expect(maxHomeX, `홈 P078 최대 x=${maxHomeX} — 킥오프 트윈을 실제로 관측해야`).toBeGreaterThanOrEqual(11.9);
  expect(maxHomeX, `홈 P078 최대 x=${maxHomeX} — 어웨이 킥오프 자리(88)로 끌려가면 안 된다`).toBeLessThan(40);
});
