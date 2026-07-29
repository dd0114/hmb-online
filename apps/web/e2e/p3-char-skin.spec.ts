import { expect, test, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { jerseyNumbers } from "../src/match/viewer-skins";

/**
 * 캐릭터 스킨 적용 계약 (#145 B안) — 정적 화면 아바타 + 경기장 아이콘.
 *
 * 백엔드 없이 돈다: `/api/**` 를 목킹한다(라우트 매처는 **오리진 앵커**로 — 상대 글롭을 쓰면
 * 에셋 요청까지 가로채 흰 화면이 된다). `/chars/**` 는 목킹하지 않고 vite public 실물을 쓴다
 * (스테이징 산출물이 실제로 서빙되는지까지 증명하려면 실물이어야 한다).
 */

const SHOTS = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/**
 * 목 로스터는 **발행물에서 조인**한다 — 손으로 적으면 등급·포지션이 실제 시드와 어긋나
 * "전 등급 커버" 주장이 과장되고(검증자 지적), 스크린샷에 특정 포지션 풀이 아예 안 나온다.
 * 포지션 4종 × (LEGEND / 비-LEGEND) 를 실제 데이터에서 골라 캡처가 B안 전체를 대표하게 한다.
 */
const ROSTER: Array<{ id: string; name: string; position: string; grade: string }> = JSON.parse(
  readFileSync(new URL("../../../data/players/players.v2.1.json", import.meta.url).pathname, "utf8"),
);

function pick(position: string, legend: boolean) {
  return ROSTER.find((p) => p.position === position && (p.grade === "LEGEND") === legend)!;
}

const PLAYERS = [
  pick("GK", true), pick("DF", true), pick("MF", true), pick("FW", true),
  pick("GK", false), pick("DF", false), pick("MF", false), pick("FW", false),
].map((p, i) => ({
  id: p.id,
  name: p.name,
  position: p.position,
  grade: p.grade,
  owned: true,
  ownedCount: 1,
  attributes: {
    technical: 70 + i, mental: 70, physical: 70, passing: 70,
    shooting: 70, tackling: 70, pace: 70, stamina: 70, positioning: 70,
  },
}));

async function mockApi(page: Page) {
  const origin = new URL(page.url() || "http://localhost/").origin;
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({ nickname: "tester", points: 1000, records: { wins: 0, draws: 0, losses: 0 } })),
  );
  void origin;
}

async function login(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "test-token");
  });
}

function logIdsPreview(jerseys: Record<string, string>): string[] {
  return [...new Set(Object.values(jerseys))];
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("도감: 전 등급 선수에 캐릭터 얼굴이 붙는다(B안 — 폴백 0)", async ({ page }) => {
  await login(page);
  await mockApi(page);
  await page.goto("/codex");

  // 포지션 4종 × LEGEND/비-LEGEND 가 실제로 섞여 있어야 캡처가 B안을 대표한다.
  expect(new Set(PLAYERS.map((p) => p.position)).size, "포지션 4종").toBe(4);
  expect(PLAYERS.filter((p) => p.grade === "LEGEND")).toHaveLength(4);

  for (const p of PLAYERS) {
    const avatar = page.getByTestId(`char-avatar-${p.id}`);
    await expect(avatar, `${p.id} 아바타가 보인다`).toBeVisible({ timeout: 15_000 });
    // B안 핵심: LEGEND 도 비-LEGEND 도 확정 캐릭터로 해석된다.
    await expect(avatar, `${p.id} 는 캐릭터 축`).toHaveAttribute("data-avatar-kind", "character");
  }
  await page.screenshot({ path: `${SHOTS}char-skin-codex.png`, fullPage: true });
});

test("에셋 스테이징이 실제로 서빙된다(/chars 4파일)", async ({ page }) => {
  for (const path of [
    "/chars/manifest.json",
    "/chars/characters/manifest.json",
    "/chars/units/manifest.json",
    "/chars/player-chars.json",
  ]) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(200);
  }
  // #207 v2 매핑 — 카탈로그 180 중 178명(아트 미입고 LEGEND 2명 P174·P178 은 의도적 미매핑).
  // 3차 입고(2026-07-29)로 P180 경니시우스가 매핑되며 177 → 178.
  // #256 채번으로 P181 석다이크·P182 오시야스가 붙어 178 → 180.
  const mapping = await (await page.request.get("/chars/player-chars.json")).json();
  expect(Object.keys(mapping.players)).toHaveLength(180);
  expect(mapping.players.P173).toEqual({ axis: "units", id: "bonaldo" });
  expect(mapping.players.P180).toEqual({ axis: "units", id: "kyeongnicius" });
  expect(mapping.players.P181).toEqual({ axis: "units", id: "seokdijk" });
  expect(mapping.players.P182).toEqual({ axis: "units", id: "osiyas" });
});

test("경기장: web 이 코어를 직접 마운트해 스킨 캐릭터 토큰으로 그린다(S3)", async ({ page }) => {
  // S3: iframe·임베드 아티팩트 제거 — 앱 매치 화면이 viewer-core 를 직접 마운트하고,
  // useCharAssets 로 스킨을 자동 적용한다. 실제 앱 경로로 "스킨이 캔버스에 그려지는지"를 픽셀로 본다.
  const matchLog = JSON.parse(
    readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
  );
  // 데모 로그 playerId(H1/A1…)를 실경기 형태(P001…)로 리매핑 → 앱 스킨 매핑(mapping.players)이 붙는다.
  // ⚠️ 스냅샷 배열 키는 `tickSnapshots`(오타 시 리매핑이 조용히 no-op).
  const snapshots = matchLog.tickSnapshots as Array<{ players: Array<{ playerId: string }>; ballOwner?: string }>;
  expect(snapshots?.length, "tickSnapshots 가 있어야 한다").toBeGreaterThan(0);
  const ids = new Map<string, string>();
  let n = 1;
  for (const snap of snapshots) {
    for (const pl of snap.players ?? []) {
      if (!ids.has(pl.playerId)) ids.set(pl.playerId, `P${String(n++).padStart(3, "0")}`);
    }
  }
  expect(ids.size, "리매핑된 선수가 있어야 한다").toBeGreaterThanOrEqual(22);
  for (const snap of snapshots) {
    for (const pl of snap.players ?? []) pl.playerId = ids.get(pl.playerId)!;
    if (snap.ballOwner && ids.has(snap.ballOwner)) snap.ballOwner = ids.get(snap.ballOwner)!;
  }

  // 리매핑 id 가 실제 스킨 매핑에 있어야 스킨이 붙는다(no-op 함정 방지 — 원래 계약 유지).
  const mapping = await (await page.request.get("/chars/player-chars.json")).json();
  const logIds = [...ids.values()];
  // #207: 경기장은 `characters` 축만 그린다(units 축 = 팀색 원). 그냥 "매핑에 있나"만 보면
  // units 축 선수도 truthy 라 통과해 버리고, 정작 캔버스엔 스킨이 안 붙는다 → 축까지 본다.
  expect(
    logIds.filter((id) => mapping.players[id]?.axis === "characters").length,
    "로그 선수 ↔ 경기장(characters 축) 스킨 매핑 교집합",
  ).toBe(logIds.length);
  // 등번호가 1~11 로 나와야 한다(안 그러면 토큰에 선수 id 가 찍힘 — 실화면 확인).
  const nums = logIdsPreview(jerseyNumbers(matchLog));
  expect(nums.every((x) => /^([1-9]|1[01])$/.test(x)), `등번호 1~11: ${nums.join(",")}`).toBe(true);

  const MATCH_ID = "m-skin";
  await login(page);
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({ user: { id: "u1", nickname: "tester", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } })),
  );
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) =>
    route.fulfill(json({ id: MATCH_ID, state: "FIRST_HALF", scoreH1Home: 1, scoreH1Away: 0, createdAt: "2026-07-24T00:00:00Z", opponent: { name: "봇 FC" } })),
  );
  await page.route((url) => /\/api\/matches\/.+\/halves\/1\/log$/.test(url.pathname), (route) =>
    route.fulfill(json(matchLog)),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/deck", (route) => route.fulfill(json({ formation: "4-4-2", slots: [] })));

  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => (window as { __viewer?: { ready(): boolean } }).__viewer?.ready?.() === true, null, { timeout: 20_000 });
  // 앱이 useCharAssets → setSkin 으로 아틀라스를 붙일 때까지(못 붙으면 조용히 원본 원).
  await page.waitForFunction(
    () => (window as { __viewer?: { skinReady?(): boolean } }).__viewer?.skinReady?.() === true,
    null,
    { timeout: 20_000 },
  );

  await page.evaluate(() => {
    const v = window as unknown as { __viewer: { autoPace(on: boolean): void; setViewMode(m: string): void; seek(t: number): void } };
    v.__viewer.autoPace(false);
    v.__viewer.setViewMode("fix");
    v.__viewer.seek(900);
  });
  await page.waitForTimeout(300);
  await page.getByTestId("viewer-canvas-half1").screenshot({ path: `${SHOTS}char-skin-arena.png` });

  // ── 진짜 계약: 픽셀이 실제로 달라져야 한다 ──────────────────────────────
  const withSkin = await page.evaluate(() => {
    const v = window as unknown as { __viewer: { seek(t: number): void } };
    v.__viewer.seek(900);
    return (document.querySelector("canvas") as HTMLCanvasElement).toDataURL();
  });
  const withoutSkin = await page.evaluate(() => {
    // S3: 네이티브 스킨 비활성 = setSkin(null).
    const v = window as unknown as { __viewer: { setSkin(p: unknown): void; seek(t: number): void } };
    v.__viewer.setSkin(null);
    v.__viewer.seek(900);
    return (document.querySelector("canvas") as HTMLCanvasElement).toDataURL();
  });
  expect(withSkin.length, "스킨 렌더가 비어있지 않다").toBeGreaterThan(1000);
  expect(withSkin, "스킨 on/off 렌더가 달라야 한다 — 같으면 캐릭터가 안 그려진 것").not.toBe(withoutSkin);
  await page.getByTestId("viewer-canvas-half1").screenshot({ path: `${SHOTS}char-skin-arena-nosk.png` });
});
test("덱 전술보드: 슬롯 토큰에 캐릭터 얼굴 + 번호가 함께 보인다", async ({ page }) => {
  await login(page);
  await mockApi(page);
  // 선발 슬롯을 채운 덱을 목으로 준다 — 빈 보드면 토큰이 아예 안 그려진다.
  const starters = PLAYERS.slice(0, 8).map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i }));
  // 로스터 desync 재현: 덱에는 있는데 카탈로그 응답에는 없는 선수(트레이드/방출 직후 캐시 불일치).
  // 이 슬롯 때문에 보드가 통째로 크래시하면 안 된다 — 아바타만 생략되고 나머지는 살아야 한다.
  starters.push({ playerId: "P_GHOST", role: "starter", slotIndex: 8 });
  await page.route(
    (url) => url.pathname === "/api/deck",
    (route) => route.fulfill(json({ formation: "4-4-2", slots: starters })),
  );
  await page.goto("/deck");

  const token = page.getByTestId(`token-${PLAYERS[0].id}`);
  await expect(token).toBeVisible({ timeout: 15_000 });
  // 얼굴이 붙었는가 + 슬롯 번호가 남아 있는가(정보를 빼지 않고 얼굴만 더한다).
  const face = token.getByTestId(`char-avatar-${PLAYERS[0].id}`);
  await expect(face).toHaveAttribute("data-avatar-kind", "character");
  await expect(token).toContainText("1");

  // ⚠️ DOM 에 번호가 있다는 것만으로는 부족하다 — 얼굴은 absolute 배경층이라 스크림 CSS 가
  // 빠지면 번호가 **화면에서 완전히 가려지는데 toContainText 는 그대로 통과**한다(검증자가
  // 이미지로 증명). 그래서 번호가 얼굴 "위"에 있음을 계산된 스타일로 못박는다.
  const num = token.locator('[class*="discNum"]');
  const paint = await num.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { position: cs.position, zIndex: cs.zIndex, background: cs.backgroundColor };
  });
  expect(paint.position, "번호가 positioned 여야 얼굴 위로 올라간다").not.toBe("static");
  expect(Number(paint.zIndex), "번호 z-index 가 배경층보다 위").toBeGreaterThan(0);
  expect(paint.background, "번호 뒤 스크림이 있어야 얼굴 위에서 읽힌다").not.toMatch(
    /rgba\(0, 0, 0, 0\)|transparent/,
  );

  // 얼굴이 실제로 번호를 덮는 위치에 깔려 있는지도 확인(레이어 순서 회귀 방지).
  const boxes = await token.evaluate((el) => {
    const f = el.querySelector('[data-avatar-kind]') as HTMLElement;
    const n = el.querySelector('[class*="discNum"]') as HTMLElement;
    const fr = f.getBoundingClientRect(), nr = n.getBoundingClientRect();
    return { overlaps: !(nr.right < fr.left || nr.left > fr.right || nr.bottom < fr.top || nr.top > fr.bottom) };
  });
  expect(boxes.overlaps, "번호와 얼굴이 같은 자리에 겹친다(그래서 스크림이 필수)").toBe(true);

  // desync 슬롯도 토큰은 렌더된다(크래시 0). 보드 전체가 살아있는지로 확인.
  await expect(page.getByTestId("token-P_GHOST")).toBeVisible();
  await expect(page.getByTestId(`token-${PLAYERS[1].id}`)).toBeVisible();

  await page.screenshot({ path: `${SHOTS}char-skin-deck.png`, fullPage: true });
});
