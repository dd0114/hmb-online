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

test("에셋 스테이징이 실제로 서빙된다(/chars 3파일)", async ({ page }) => {
  for (const path of ["/chars/manifest.json", "/chars/characters/manifest.json", "/chars/player-chars.json"]) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(200);
  }
  const mapping = await (await page.request.get("/chars/player-chars.json")).json();
  expect(Object.keys(mapping.players)).toHaveLength(172);
});

test("경기장: 뷰어 iframe 이 스킨을 받아 캐릭터 토큰으로 그린다", async ({ page }) => {
  // 앱 전체를 띄우지 않고 임베드 아티팩트를 직접 태운다 — 주입된 스킨 브리지 + draw 치환 검증.
  const matchLog = JSON.parse(
    readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
  );
  // 데모 로그의 playerId 는 엔진 픽스처(H1/A1…). 실경기 로그는 실제 선수 id 라(#145 확인)
  // 매핑이 붙는다 — 여기서도 같은 형태가 되도록 리매핑해 실경로를 재현한다.
  // ⚠️ 스냅샷 배열 키는 `tickSnapshots` 다(`snapshots` 아님 — 오타 시 리매핑이 조용히 no-op).
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

  await page.goto("/viewer-embed.html");
  await page.waitForFunction(() => !!(window as { __viewer?: unknown }).__viewer, null, { timeout: 20_000 });

  const mapping = await (await page.request.get("/chars/player-chars.json")).json();
  const characters = await (await page.request.get("/chars/characters/manifest.json")).json();
  // 등번호는 실제 프로덕션 함수를 그대로 태운다(스펙 전용 사본을 만들면 드리프트한다).
  const jerseys = jerseyNumbers(matchLog);
  const byPlayer: Record<string, { col: number; row: number; num?: string }> = {};
  for (const [playerId, charId] of Object.entries(mapping.players as Record<string, string>)) {
    const c = characters.characters[charId];
    if (c) byPlayer[playerId] = { col: c.col, row: c.row, num: jerseys[playerId] };
  }
  // 등번호가 1~11 로 나와야 한다 — 안 그러면 토큰에 선수 id(P022)가 그대로 찍힌다(실화면 확인).
  const nums = logIdsPreview(jerseys);
  expect(nums.every((n) => /^([1-9]|1[01])$/.test(n)), `등번호 1~11: ${nums.join(",")}`).toBe(true);
  const skins = { atlasUrl: "/chars/characters/avatars-64.png", tile: 64, byPlayer };
  // 로그에 등장하는 선수가 실제로 스킨 표에 있어야 한다 — 이게 어긋나면 렌더는 조용히
  // 원본 원으로 떨어진다(실제로 겪은 함정: 스냅샷 키 오타로 리매핑이 no-op 이었는데
  // "아틀라스 로드됨"만 보는 계약은 그대로 통과했다).
  const logIds = [...ids.values()];
  expect(logIds.filter((id) => byPlayer[id]).length, "로그 선수 ↔ 스킨 표 교집합").toBe(logIds.length);

  await page.evaluate(
    ([log, sk]) => window.postMessage({ type: "loadMatchLog", matchLog: log, skins: sk }, "*"),
    [matchLog, skins] as const,
  );

  // 아틀라스가 실제로 로드돼 렌더 경로가 열렸는가(못 받으면 조용히 원본 원으로 떨어지므로 명시 검증).
  await page.waitForFunction(
    () => {
      const s = (window as { __HMB_SKIN?: { ready?: boolean } }).__HMB_SKIN;
      return !!s && s.ready === true;
    },
    null,
    { timeout: 20_000 },
  );

  await page.waitForFunction(() => (window as { __viewer?: { ready(): boolean } }).__viewer!.ready(), null, {
    timeout: 20_000,
  });
  await page.evaluate(() => {
    const v = window as unknown as { __viewer: { autoPace(on: boolean): void; setViewMode(m: string): void; seek(t: number): void } };
    v.__viewer.autoPace(false);
    v.__viewer.setViewMode("fix");
    v.__viewer.seek(900);
  });
  await page.waitForTimeout(300);
  await page.locator("canvas").first().screenshot({ path: `${SHOTS}char-skin-arena.png` });

  // ── 진짜 계약: 픽셀이 실제로 달라져야 한다 ──────────────────────────────
  // "스킨 객체가 준비됐다"는 렌더를 증명하지 못한다. 같은 틱을 스킨 on/off 로 그려
  // 캔버스가 달라지는지 본다(달라지지 않으면 draw 치환이 안 먹은 것).
  const withSkin = await page.evaluate(() => {
    const v = window as unknown as { __viewer: { seek(t: number): void } };
    v.__viewer.seek(900);
    return (document.querySelector("canvas") as HTMLCanvasElement).toDataURL();
  });
  const withoutSkin = await page.evaluate(() => {
    (window as { __HMB_SKIN?: unknown }).__HMB_SKIN = null;
    const v = window as unknown as { __viewer: { seek(t: number): void } };
    v.__viewer.seek(900);
    return (document.querySelector("canvas") as HTMLCanvasElement).toDataURL();
  });
  expect(withSkin.length, "스킨 렌더가 비어있지 않다").toBeGreaterThan(1000);
  expect(withSkin, "스킨 on/off 렌더가 달라야 한다 — 같으면 캐릭터가 안 그려진 것").not.toBe(withoutSkin);

  await page.locator("canvas").first().screenshot({ path: `${SHOTS}char-skin-arena-nosk.png` });
});
