import { readdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * #285 공용 픽스처 — **실 선수 id 로** 목킹한다.
 *
 * ⚠️ 왜 가짜 id("GK1")를 쓰면 안 되나: 아트 해석은 `player-chars.json` 의 **playerId 키**로
 * 걸린다. 가짜 id 는 어느 축에도 매핑이 없어 전원이 CSS 플레이스홀더로 떨어지고 — 그러면
 * "골드 이하 얼굴이 뜬다"는 **증상 자체가 화면에 재현되지 않는다**(계약이 공허해진다).
 * 그래서 발행 시드에서 등급별 실 id 를 뽑아 쓴다.
 *
 * 시드 파일도 이름을 박지 않는다 — v2.5 가 나오면 조용히 낡은 시드를 읽는 계약이 된다(#218 선례).
 */
const repoRoot = new URL("../../../", import.meta.url).pathname;

export interface SeedPlayer {
  id: string;
  name: string;
  position: string;
  grade: "BRONZE" | "SILVER" | "GOLD" | "DIA" | "LEGEND";
  active?: boolean;
}

function latestSeedFile(): string {
  return readdirSync(`${repoRoot}data/players`)
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
}

export const SEED: SeedPlayer[] = JSON.parse(
  readFileSync(`${repoRoot}data/players/${latestSeedFile()}`, "utf8"),
);

/** 발행된 매핑 실물 — "이 선수에게 아트가 붙어 있나"의 권위. */
export const MAPPING: { players: Record<string, { axis: string; id: string } | string> } = JSON.parse(
  readFileSync(`${repoRoot}apps/web/public/chars/player-chars.json`, "utf8"),
);

/** 이 선수에게 **어떤 아트든** 매핑돼 있나(축 무관). 계약이 "볼 게 있는 표본"인지 확인용. */
export function hasArtMapping(playerId: string): boolean {
  return MAPPING.players[playerId] != null;
}

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

export function catalogPlayer(p: SeedPlayer, ov = 70) {
  return {
    id: p.id, name: p.name, position: p.position, grade: p.grade,
    owned: true, ownedCount: 1, attributes: attrs(ov), personality: "CALM",
  };
}

/** 등급별로 **아트 매핑이 있는** 선수를 골라온다(없는 선수를 고르면 계약이 공허해진다). */
export function pickByGrade(grade: SeedPlayer["grade"], position: string, skip = 0): SeedPlayer {
  const hit = SEED.filter((p) => p.grade === grade && p.position === position && hasArtMapping(p.id));
  const p = hit[skip];
  if (!p) throw new Error(`시드에 ${grade}/${position} 아트 매핑 선수가 부족하다(skip=${skip})`);
  return p;
}

/**
 * 선발 11 — **등급이 골고루 섞이도록** 짠다. 다이아 이상(얼굴 유지)과 골드 이하(얼굴 숨김)가
 * 같은 보드 위에 있어야 before/after 가 한 장에서 대비된다.
 */
export const XI: SeedPlayer[] = [
  pickByGrade("LEGEND", "GK"),
  pickByGrade("DIA", "DF"), pickByGrade("DIA", "DF", 1),
  pickByGrade("GOLD", "DF"), pickByGrade("SILVER", "DF"),
  pickByGrade("DIA", "MF"), pickByGrade("GOLD", "MF"),
  pickByGrade("SILVER", "MF"), pickByGrade("BRONZE", "MF"),
  pickByGrade("LEGEND", "FW"), pickByGrade("GOLD", "FW"),
];
export const BENCH: SeedPlayer[] = [
  pickByGrade("BRONZE", "DF"), pickByGrade("SILVER", "FW"),
  pickByGrade("DIA", "FW"), pickByGrade("GOLD", "GK"),
];

export const HIGH_IDS = XI.concat(BENCH).filter((p) => p.grade === "DIA" || p.grade === "LEGEND").map((p) => p.id);
export const LOW_IDS = XI.concat(BENCH).filter((p) => p.grade !== "DIA" && p.grade !== "LEGEND").map((p) => p.id);

const isHigh = (g: SeedPlayer["grade"]) => g === "DIA" || g === "LEGEND";

/**
 * 경기장(22명) 전용 풀 — **id 가 22개 모두 달라야 한다**.
 *
 * ⚠️ 여기서 한 번 당했다: 덱 표본 14명을 22칸에 돌려 쓰니 같은 `playerId` 가 양 팀에 앉았고,
 * id 로 키를 잡은 측정이 두 인스턴스를 섞어 **판정이 뒤죽박죽**이 됐다(엔진의 #231 과 같은 모양).
 * 계약이 재는 대상은 토큰 하나하나이므로 중복 id 를 만들지 않는다.
 */
export const ARENA_LOW: string[] = SEED.filter((p) => !isHigh(p.grade) && hasArtMapping(p.id))
  .slice(0, 14)
  .map((p) => p.id);
export const ARENA_HIGH: string[] = SEED.filter((p) => isHigh(p.grade) && hasArtMapping(p.id))
  .slice(0, 8)
  .map((p) => p.id);

const PLAYERS = SEED.map((p) => catalogPlayer(p, 60 + (p.grade === "LEGEND" ? 30 : p.grade === "DIA" ? 22 : p.grade === "GOLD" ? 14 : p.grade === "SILVER" ? 7 : 0)));

export const deckSlots = [
  ...XI.map((p, i) => ({ playerId: p.id, role: "starter", slotIndex: i, promptText: i === 5 ? "공간 만들어라" : null })),
  ...BENCH.map((p, i) => ({ playerId: p.id, role: "bench", slotIndex: i, promptText: null })),
];

export const MATCH_ID = "m285";

export const MATCH = {
  id: MATCH_ID,
  createdAt: "2026-07-29T00:00:00Z",
  state: "BRIEFING",
  conditions: Object.fromEntries(XI.map((p, i) => [p.id, 0.3 + (i % 5) * 0.15])),
  opponent: {
    name: "ㅅㄷㄴ",
    analysisText: "ㅅㄷㄴ 감독의 실제 팀입니다. 선수별 지시가 그대로 적용됩니다.",
    deck: [
      { name: "봇 에이스", position: "FW", grade: "LEGEND", hasPrompt: true },
      { name: "봇 미드", position: "MF", grade: "GOLD", hasPrompt: true },
      { name: "봇 수비", position: "DF", grade: "SILVER", hasPrompt: false },
    ],
  },
};

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** ⚠️ 라우트 매칭은 **오리진 앵커**(url.pathname) — 상대 글롭은 vite 소스 요청까지 삼켜 흰 화면이 된다. */
export async function mockApi(page: Page) {
  const state = { deck: { formation: "4-4-2", slots: deckSlots as unknown[], teamPrompt: null as string | null } };
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })));
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    route.fulfill(json(Object.fromEntries(XI.map((p, i) => [p.id, 0.3 + (i % 5) * 0.15])))));
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json({
    user: { id: "u1", nickname: "테스터", provider: "guest", tutorialDone: true },
    wallet: { points: 1000 }, records: { played: 0, wins: 0, draws: 0, losses: 0 },
  })));
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json({ match: null, locked: false, abandonable: false })));
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) => route.fulfill(json(MATCH)));
  await page.route((url) => url.pathname === "/api/deck", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      state.deck = { formation: body.formation, slots: body.slots, teamPrompt: body.teamPrompt ?? null };
    }
    return route.fulfill(json(state.deck));
  });
}

export async function auth(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
}
