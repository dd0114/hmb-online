import { makeSelectData } from "@hmb/engine";
import { TeamInputJobContext } from "@hmb/shared";

/**
 * 테스트 픽스처 — 유효한 TeamInputJobContext 생성(결정론, 네트워크 0).
 * 로스터 = 엔진 데모 홈팀(H0..H10, 4-3-3, 시드 변주 능력치) → slotIndex 0..10.
 * (*.test.ts 아님 — vitest 수집 안 됨, 헬퍼 전용.)
 */
export function makeTeamInputContext(overrides: Partial<TeamInputJobContext> = {}): TeamInputJobContext {
  const roster = makeSelectData().home.players.map((p, i) => ({
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    attributes: p.attributes,
    slotIndex: i,
  }));
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
