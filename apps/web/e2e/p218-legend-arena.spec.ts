import { expect, test, type Page } from "@playwright/test";
import { jerseyNumbers } from "../src/match/viewer-skins";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";

/**
 * #218 — 경기장 LEGEND 아이콘 계약. 두 가지를 박제한다.
 *
 *  C-FALLBACK(AC2) : 아이콘이 있든 없든 **모든 선수 토큰은 반드시 보인다**. 매핑이 없는 선수,
 *                    스킨 미주입, 아틀라스 로드 실패 — 어느 경우에도 팀색 토큰이 그려져야 한다.
 *                    (고칠 당시 이미 성립했지만 계약이 없어 회귀를 못 잡았다 → 여기서 못 박는다.)
 *  C-LEGEND(AC1)   : 활성 LEGEND(units 축 실아트 입고분)는 경기장에서 **얼굴이 그려진다**.
 *                    수정 전에는 스킨 페이로드가 단일 아틀라스라 units 축이 통째 빠져 5명 전원이
 *                    맨 토큰이었다(이 스펙이 그 상태를 먼저 재현하고 실패했다 — E2E-TDD).
 *
 * 판정은 **실제로 그려진 픽셀**로 한다: 토큰 중심 좌표는 코어가 알려준 렌더 좌표(px,py)를 쓰고
 * (카메라 변환 재구현 금지 — 렌더와 조용히 어긋난다), 그 자리 픽셀을 읽어 팀색 유무 / 스킨 on·off
 * 차이를 본다. DOM 유무나 페이로드 내용만 보는 검사는 "캔버스엔 안 그려짐"을 통과시킨다.
 */

const SHOTS = new URL("../.smoke/", import.meta.url).pathname;
const repoRoot = new URL("../../../", import.meta.url).pathname;

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const mapping: { players: Record<string, { axis: string; id: string }> } = JSON.parse(
  readFileSync(`${repoRoot}data/players/player-chars.v2.json`, "utf8"),
);
/**
 * 선수 시드는 **파일명을 박지 않고 최신 발행본을 고른다** — v2.4 가 나오면 조용히 낡은 시드를 읽고
 * 계속 통과하는 계약이 된다(활성 LEGEND 가 바뀌어도 못 잡는다).
 */
const SEED_FILE = readdirSync(`${repoRoot}data/players`)
  .filter((f) => /^players\.v[\d.]+\.json$/.test(f))
  .sort((a, b) => {
    const num = (f: string) => f.slice(9, -5).split(".").map(Number);
    const [x, y] = [num(a), num(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
  })
  .pop()!;
const seed: Array<{ id: string; name: string; grade: string; active?: boolean }> = JSON.parse(
  readFileSync(`${repoRoot}data/players/${SEED_FILE}`, "utf8"),
);
/** 발행물 실물 — 계약이 쓰는 셀 좌표는 손으로 적지 않는다(발행이 바뀌면 같이 바뀌어야 한다). */
const unitsManifest: { units: Record<string, { col: number; row: number } | undefined> } = JSON.parse(
  readFileSync(`${repoRoot}design/characters/dist/units/manifest.json`, "utf8"),
);
const charsManifest: { characters: Record<string, { col: number; row: number } | undefined> } = JSON.parse(
  readFileSync(`${repoRoot}design/characters/dist/characters/manifest.json`, "utf8"),
);

/** 활성 LEGEND = 실아트가 입고된 신규 유닛(#207 U-D5). 이들이 경기장에 얼굴로 떠야 한다. */
const ACTIVE_LEGENDS = seed
  .filter((p) => p.grade === "LEGEND" && p.active === true)
  .map((p) => p.id);
/** 경기장에 이미 얼굴이 뜨던 축 — 대조군(하네스가 유효한지 증명). */
const CHARACTER_AXIS = Object.entries(mapping.players)
  .filter(([, r]) => r.axis === "characters")
  .map(([id]) => id);
/** 매핑이 아예 없는 id — 폴백 계약의 주인공(어떤 아트도 못 찾는다). */
const UNMAPPED = "P_NOART";

const MATCH_ID = "m-218";

interface Snap {
  players: Array<{ playerId: string; team?: string }>;
  ballOwner?: string;
}

/**
 * 데모 로그의 엔진 id(H1/A1…)를 **실경기 id 로 리매핑**한다. 홈 선발에 활성 LEGEND 전원 +
 * 미매핑 1명을 심어, 한 경기 안에 "실아트·기존 얼굴·아트 없음" 세 경우가 모두 존재하게 한다.
 */
function remapLog(): { log: unknown; ids: string[] } {
  const log = JSON.parse(readFileSync(`${repoRoot}packages/engine/dev-viewer/match-log.json`, "utf8"));
  const snaps = log.tickSnapshots as Snap[];
  if (!snaps?.length) throw new Error("tickSnapshots 가 없다 — 픽스처 확인");

  const order: string[] = [];
  for (const s of snaps) for (const p of s.players ?? []) if (!order.includes(p.playerId)) order.push(p.playerId);

  const wanted = [...ACTIVE_LEGENDS, UNMAPPED];
  const pool = CHARACTER_AXIS.filter((id) => !wanted.includes(id));
  const remap = new Map<string, string>();
  order.forEach((old, i) => remap.set(old, i < wanted.length ? wanted[i] : pool[i - wanted.length]));

  for (const s of snaps) {
    for (const p of s.players ?? []) p.playerId = remap.get(p.playerId)!;
    if (s.ballOwner && remap.has(s.ballOwner)) s.ballOwner = remap.get(s.ballOwner)!;
  }
  for (const e of (log.events ?? []) as Array<{ playerId?: string }>) {
    if (e.playerId && remap.has(e.playerId)) e.playerId = remap.get(e.playerId)!;
  }
  return { log, ids: [...remap.values()] };
}

async function openArena(page: Page, log: unknown) {
  await page.addInitScript(() => localStorage.setItem("hmb.auth.token", "test-token"));
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({ user: { id: "u1", nickname: "tester", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } }),
    ),
  );
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) =>
    route.fulfill(
      json({
        id: MATCH_ID,
        state: "H1_BREAK",
        scoreH1Home: 1,
        scoreH1Away: 0,
        createdAt: "2026-07-27T00:00:00Z",
        opponent: { name: "봇 FC" },
      }),
    ),
  );
  await page.route((url) => /\/api\/matches\/.+\/halves\/1\/log$/.test(url.pathname), (route) => route.fulfill(json(log)));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/deck", (route) => route.fulfill(json({ formation: "4-4-2", slots: [] })));

  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => (window as never as ViewerWin).__viewer?.ready?.() === true, null, { timeout: 20_000 });
  await page.evaluate(() => {
    const v = (window as never as ViewerWin).__viewer!;
    v.autoPace(false);
    v.setViewMode("fix");
    v.seek(900);
  });
}

interface ViewerWin {
  __viewer?: {
    ready(): boolean;
    skinReady(): boolean;
    setSkin(p: unknown): void;
    autoPace(on: boolean): void;
    setViewMode(m: string): void;
    seek(t: number): void;
    curPlayers(): Array<{ id: string; px: number; py: number }>;
  };
}

/**
 * 토큰 중심 주변 패치를 읽어 (a) 팀색 픽셀 수 (b) 패치 지문을 돌려준다.
 * 팀색(파랑/빨강)은 원·링·번호뱃지 어느 표현에도 반드시 들어간다 — 피치 초록/흰 선은 통과 못 한다.
 */
async function probeTokens(page: Page) {
  return page.evaluate(() => {
    const v = (window as never as ViewerWin).__viewer!;
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const HALF = 16;
    return v.curPlayers().map((p) => {
      const x0 = Math.max(0, Math.round(p.px) - HALF), y0 = Math.max(0, Math.round(p.py) - HALF);
      const w = Math.min(HALF * 2, canvas.width - x0), h = Math.min(HALF * 2, canvas.height - y0);
      const d = ctx.getImageData(x0, y0, w, h).data;
      let team = 0, sum = 0, label = 0;
      const fp: number[] = [];
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if ((b > r + 35 && b > g + 15) || (r > b + 35 && r > g + 35)) team++;
        // 글자는 흰 채움 + 굵은 검은 외곽선으로 그려진다 → **흰 픽셀 수 = 라벨 크기**.
        if (r > 200 && g > 200 && b > 200) label++;
        sum += r * 3 + g * 5 + b * 7;
        if ((i / 4) % 37 === 0) fp.push(r, g, b);
      }
      return { id: p.id, team, label, fingerprint: `${sum}:${fp.join(",")}` };
    });
  });
}

/**
 * 토큰 확대 크롭 저장 — 판정이 아니라 **눈으로 볼 증빙**이다(좌표 추론 금지 규율).
 * 32px 토큰은 전체 캡처에서 판독이 안 돼 "얼굴이 붙었나"를 사람이 확인할 수 없다.
 */
async function saveTokenCrops(page: Page, ids: string[], tag: string) {
  const shots = await page.evaluate((wanted) => {
    const v = (window as never as ViewerWin).__viewer!;
    const src = document.querySelector("canvas") as HTMLCanvasElement;
    const players = v.curPlayers();
    const out: Array<{ id: string; data: string }> = [];
    for (const id of wanted) {
      const p = players.find((q) => q.id === id);
      if (!p) continue;
      const S = 40, Z = 6;
      const c = document.createElement("canvas");
      c.width = S * Z;
      c.height = S * Z;
      const cx = c.getContext("2d")!;
      cx.imageSmoothingEnabled = false;
      cx.drawImage(src, Math.round(p.px) - S / 2, Math.round(p.py) - S / 2, S, S, 0, 0, S * Z, S * Z);
      out.push({ id, data: c.toDataURL().split(",")[1] });
    }
    return out;
  }, ids);
  for (const s of shots) writeFileSync(`${SHOTS}p218-token-${s.id}-${tag}.png`, Buffer.from(s.data, "base64"));
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("C-FALLBACK(AC2): 아트가 없어도 모든 선수 토큰이 보인다 — 스킨 on/off 양쪽", async ({ page }) => {
  const { log, ids } = remapLog();
  expect(ids, "미매핑 선수가 경기에 들어가 있어야 계약이 공허하지 않다").toContain(UNMAPPED);
  expect(mapping.players[UNMAPPED], "미매핑 선수는 정말 매핑이 없어야 한다").toBeUndefined();

  await openArena(page, log);
  await page.waitForFunction(() => (window as never as ViewerWin).__viewer?.skinReady() === true, null, { timeout: 20_000 });

  const withSkin = await probeTokens(page);
  expect(withSkin.length, "22명이 그려진다").toBeGreaterThanOrEqual(22);
  const invisibleOn = withSkin.filter((t) => t.team < 20).map((t) => `${t.id}(${t.team})`);
  expect(invisibleOn, "스킨 on: 토큰이 안 보이는 선수 0 — 아트 없으면 팀색 토큰으로라도 보여야 한다").toEqual([]);

  // ── "보인다"는 팀색 픽셀이 있다는 뜻만이 아니다 ────────────────────────────
  // 제보된 증상은 **토큰이 글자에 덮이는 것**이었다(등번호 자리에 실경기 id "P173"). 팀색 임계만
  // 보면 그 화면도 통과한다 — 계약이 증상을 축복하지 않도록 **라벨 크기**를 같이 본다.
  //
  // 임계는 눈대중이 아니라 **같은 실행에서 재는 기준선**이다: 부모가 등번호를 제대로 넘긴 상태를
  // 먼저 렌더해 "정상 등번호 한 토큰이 만드는 흰 픽셀"을 측정하고, 그 배수로 판정한다.
  // (실측 참고 — 정상 등번호 4~17px · 라벨 없음 0px · id 원문 스탬프 19~50px. 자기 임계 설정을
  //  피하려고 기준선을 매 실행 재계산한다.)
  const nums = jerseyNumbers(log);
  await page.evaluate((payload) => {
    const v = (window as never as ViewerWin).__viewer!;
    v.setSkin(payload);
    v.seek(900);
  }, { atlases: [], byPlayer: {}, nums });
  const numbered = await probeTokens(page);
  const numberedLabels = numbered.map((t) => t.label).sort((a, b) => a - b);
  const baseline = numberedLabels[Math.floor(numberedLabels.length / 2)]!;
  const bound = baseline * 2 + 5;
  expect(numbered.filter((t) => t.team < 20), "등번호만 있는 상태: 안 보이는 토큰 0").toEqual([]);
  // ⚠️ **기준선 자체를 먼저 검증한다.** 코어가 `nums` 를 안 보게 되면 이 상태의 라벨이 전부 0 이 되고
  // (= 셀 없는 선수 전원이 번호 없는 맨 원 — 실경기의 GOLD 이하 133명), 기준선 0 → 임계 5 로 무너져
  // 아래 검사가 **항진명제**가 된다. 계약이 지켜야 할 실패 모드에서 계약이 사라지는 구멍이라
  // 독립검증이 blocker 로 잡았다. 그래서 "번호가 실제로 그려졌다"를 토큰마다 못 박는다.
  const unlabeled = numbered.filter((t) => t.label === 0).map((t) => t.id);
  expect(unlabeled, "등번호 페이로드를 줬는데 번호가 안 그려진 토큰 0 — 기준선이 유효해야 임계가 의미를 갖는다")
    .toEqual([]);
  expect(baseline, "기준선(정상 등번호 한 토큰의 흰 픽셀)").toBeGreaterThan(0);

  // 스킨이 통째로 죽은 경우(에셋 미배포·아틀라스 404·부모가 아무것도 안 넘김)에도 같은 계약이
  // 성립해야 한다 — 코어 단독 방어선(등번호로 안 읽히는 라벨은 아예 안 찍는다).
  await page.evaluate(() => {
    const v = (window as never as ViewerWin).__viewer!;
    v.setSkin(null);
    v.seek(900);
  });
  const noSkin = await probeTokens(page);
  const invisibleOff = noSkin.filter((t) => t.team < 20).map((t) => `${t.id}(${t.team})`);
  expect(invisibleOff, "스킨 off(에셋 실패 시뮬): 토큰이 안 보이는 선수 0").toEqual([]);
  const covered = noSkin.filter((t) => t.label > bound).map((t) => `${t.id}(라벨 ${t.label} > ${bound})`);
  expect(covered, "스킨 off: 토큰이 id 원문 글자에 덮인 선수 0 — 등번호로 안 읽히면 안 찍는다").toEqual([]);
  await page.getByTestId("viewer-canvas-half1").screenshot({ path: `${SHOTS}p218-arena-noskin.png` });
  await saveTokenCrops(page, [UNMAPPED, ACTIVE_LEGENDS[0]], "noskin");
});

test("C-LEGEND(AC1): 활성 LEGEND 실아트가 경기장 토큰에 그려진다", async ({ page }) => {
  const { log } = remapLog();
  expect(ACTIVE_LEGENDS.length, "활성 LEGEND 가 있어야 한다").toBeGreaterThan(0);
  for (const id of ACTIVE_LEGENDS) {
    expect(mapping.players[id]?.axis, `${id} 는 units 축 실아트를 갖는다`).toBe("units");
  }

  await openArena(page, log);
  await page.waitForFunction(() => (window as never as ViewerWin).__viewer?.skinReady() === true, null, { timeout: 20_000 });
  const on = await probeTokens(page);
  await page.getByTestId("viewer-canvas-half1").screenshot({ path: `${SHOTS}p218-arena-skin.png` });
  await saveTokenCrops(page, [...ACTIVE_LEGENDS.slice(0, 3), UNMAPPED], "skin");

  // ── 대조군은 `setSkin(null)` 이 **아니다** ────────────────────────────────
  // 그렇게 잡으면 등번호까지 같이 사라져(코어가 id 파생으로 떨어진다) 얼굴을 하나도 안 그려도
  // 픽셀이 달라진다 → 원래 버그를 되돌려도 통과하는 **공허한 계약**이 된다(독립검증이 변이체로
  // 증명). 그래서 `nums` 는 그대로 두고 **`byPlayer` 만 비운** 페이로드로 대조군을 만든다:
  // 두 상태의 유일한 차이가 **얼굴**이므로 픽셀 차이 = 얼굴이 그려졌다는 뜻이 된다.
  const nums = jerseyNumbers(log);
  await page.evaluate((payload) => {
    const v = (window as never as ViewerWin).__viewer!;
    v.setSkin(payload);
    v.seek(900);
  }, { atlases: [], byPlayer: {}, nums });
  const off = await probeTokens(page);
  // 대조군이 정말 "얼굴만 뺀 상태"임을 못 박는다: **아트가 없는 선수는 두 상태가 픽셀까지 동일**해야
  // 한다. 등번호·팀색·카메라가 조금이라도 달라졌다면 여기서 깨진다(그러면 아래 픽셀 차이를
  // "얼굴 때문"이라고 부를 수 없다).
  const fpOn = new Map(on.map((t) => [t.id, t.fingerprint]));
  const unmapped = off.find((t) => t.id === UNMAPPED)!;
  expect(unmapped.fingerprint, "아트 없는 선수는 대조군과 스킨 on 이 동일 픽셀이어야 한다").toBe(
    fpOn.get(UNMAPPED),
  );

  const fpOff = new Map(off.map((t) => [t.id, t.fingerprint]));
  const painted = (id: string) => on.find((t) => t.id === id)!.fingerprint !== fpOff.get(id);

  // 대조군: 기존 characters 축은 얼굴이 그려진다(하네스가 유효하다는 증거).
  const control = on.map((t) => t.id).find((id) => mapping.players[id]?.axis === "characters")!;
  expect(painted(control), `대조군 ${control}(characters 축)은 얼굴이 그려져야 한다`).toBe(true);
  // 본 계약: 활성 LEGEND(units 축)도 마찬가지여야 한다.
  const bare = ACTIVE_LEGENDS.filter((id) => !painted(id));
  expect(bare, "활성 LEGEND 인데 얼굴 없이 맨 토큰으로 그려진 선수").toEqual([]);
});

/**
 * C-DEGRADE — 코어가 **선언된 표현 규칙과 부분 열화**를 실제로 지키는지. 둘 다 주석으로만 선언돼
 * 있고 계약이 없어서, 되돌려도 아무도 못 잡는 자리였다(독립검증 지적 m-1·m-6).
 *
 * 페이로드를 테스트가 직접 만들어 **한 가지 변수만** 바꾼다 — 그래야 픽셀 차이의 원인이 하나다.
 */
test("C-DEGRADE: bg 원형 클립을 존중하고, 아틀라스 하나가 죽어도 나머지는 그린다", async ({ page }) => {
  const { log } = remapLog();
  const nums = jerseyNumbers(log);
  const legend = ACTIVE_LEGENDS[0]!;
  const unit = unitsManifest.units[mapping.players[legend]!.id]!;
  const charId = Object.entries(mapping.players).find(([, r]) => r.axis === "characters")![0];
  const charRef = charsManifest.characters[mapping.players[charId]!.id]!;
  const UNITS_ATLAS = { url: "/chars/units/avatars-64.png", tile: 64 };
  const CHARS_ATLAS = { url: "/chars/characters/avatars-64.png", tile: 64 };

  await openArena(page, log);
  await page.waitForFunction(() => (window as never as ViewerWin).__viewer?.skinReady() === true, null, { timeout: 20_000 });

  const render = async (payload: unknown) => {
    await page.evaluate((p) => {
      const v = (window as never as ViewerWin).__viewer!;
      v.setSkin(p);
      v.seek(900);
    }, payload);
    await page.waitForFunction(() => (window as never as ViewerWin).__viewer?.skinReady() === true, null, { timeout: 20_000 });
    await page.evaluate(() => (window as never as ViewerWin).__viewer!.seek(900));
    return probeTokens(page);
  };

  // ① `bg` 존중 — 같은 셀을 `bg` 만 바꿔 두 번 그린다. 코어가 플래그를 무시하면 두 렌더가 같아진다.
  const cell = { col: unit.col, row: unit.row, num: nums[legend] };
  const withBg = await render({ atlases: [UNITS_ATLAS], byPlayer: { [legend]: { ...cell, bg: "opaque-dark" } }, nums });
  const noBg = await render({ atlases: [UNITS_ATLAS], byPlayer: { [legend]: cell }, nums });
  const fp = (r: Awaited<ReturnType<typeof probeTokens>>, id: string) => r.find((t) => t.id === id)!.fingerprint;
  expect(fp(withBg, legend), "불투명 얼굴은 원형으로 잘라 그린다 — bg 를 무시하면 두 렌더가 같아진다")
    .not.toBe(fp(noBg, legend));

  // ②-a 코어가 **받은 셀 좌표를 실제로 읽는지**. 같은 선수·같은 시트에 셀만 바꿔 두 번 그린다.
  // 좌표를 무시하고 늘 0번 타일을 그리면 두 렌더가 같아진다(독립검증 X2 변이체). 대비가 가장 큰
  // 두 타일(실측 평균색 거리 263)을 골라 축소 렌더에서도 차이가 남게 한다.
  const far = ["wookringham", "chunbappe"].map((id) => unitsManifest.units[id]);
  expect(far.filter(Boolean), "대비 큰 두 타일이 발행물에 있어야 한다").toHaveLength(2);
  const cellA = await render({ atlases: [UNITS_ATLAS], byPlayer: { [legend]: { col: far[0]!.col, row: far[0]!.row, num: nums[legend] } }, nums });
  const cellB = await render({ atlases: [UNITS_ATLAS], byPlayer: { [legend]: { col: far[1]!.col, row: far[1]!.row, num: nums[legend] } }, nums });
  expect(fp(cellA, legend), "셀 좌표가 렌더에 반영돼야 한다 — 무시하면 두 렌더가 같아진다")
    .not.toBe(fp(cellB, legend));

  // ② 부분 열화 — units 시트만 404. 그 축 선수만 팀색 토큰이 되고 characters 축은 그대로 떠야 한다.
  const both = {
    atlases: [CHARS_ATLAS, UNITS_ATLAS],
    byPlayer: {
      [charId]: { col: charRef.col, row: charRef.row, num: nums[charId] },
      [legend]: { col: unit.col, row: unit.row, atlas: 1, bg: "opaque-dark", num: nums[legend] },
    },
    nums,
  };
  const healthy = await render(both);
  const broken = await render({ ...both, atlases: [CHARS_ATLAS, { url: "/chars/units/NOPE-404.png", tile: 64 }] });
  expect(fp(broken, charId), "살아있는 시트의 선수는 그대로 그려진다(전체 무효화 금지)").toBe(fp(healthy, charId));
  expect(fp(broken, legend), "죽은 시트의 선수는 얼굴이 빠진다").not.toBe(fp(healthy, legend));
  const invisible = broken.filter((t) => t.team < 20).map((t) => t.id);
  expect(invisible, "시트가 죽어도 안 보이는 토큰 0").toEqual([]);
});
