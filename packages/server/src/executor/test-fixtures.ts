import { makeSelectData } from "@hmb/engine";
import { TeamInputJobContext, type TeamInputRosterEntry } from "@hmb/shared";

const sel = makeSelectData();
const toEntries = (players: typeof sel.home.players): TeamInputRosterEntry[] =>
  players.map((p, i) => ({
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    attributes: p.attributes,
    slotIndex: i,
  }));

/** 상대(away) 로스터 엔트리(A0..A10) — 마킹 테스트용 opponentRoster 소재. */
export function makeOpponentRoster(): TeamInputRosterEntry[] {
  return toEntries(sel.away.players);
}

/**
 * 테스트 픽스처 — 유효한 TeamInputJobContext 생성(결정론, 네트워크 0).
 * 로스터 = 엔진 데모 홈팀(H0..H10, 4-3-3, 시드 변주 능력치) → slotIndex 0..10.
 * (*.test.ts 아님 — vitest 수집 안 됨, 헬퍼 전용.)
 */
export function makeTeamInputContext(overrides: Partial<TeamInputJobContext> = {}): TeamInputJobContext {
  const roster = toEntries(sel.home.players);
  return TeamInputJobContext.parse({
    kind: "team-input",
    matchId: "m-test-1",
    side: "home",
    half: 1,
    seed: "4815162342",
    formation: "4-3-3",
    roster,
    teamPrompt: "풀백 오버랩·와이드",
    playerPrompts: {},
    ...overrides,
  });
}
