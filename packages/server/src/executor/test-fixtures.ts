import { makeSelectData, makeTacticalInput } from "@hmb/engine";
import {
  TeamInputJobContext,
  TeamInputPatchJobContext,
  type ManualTactics,
  type OpponentRosterEntry,
  type PlayerRelationContext,
  type TacticalInput,
  type TeamInputRosterEntry,
} from "@hmb/shared";

const sel = makeSelectData();
const toEntries = (players: typeof sel.home.players): TeamInputRosterEntry[] =>
  players.map((p, i) => ({
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    attributes: p.attributes,
    slotIndex: i,
  }));

/** 상대(away) 로스터 엔트리(A0..A10) — 마킹 테스트용 opponentRoster 소재(3필드, openapi 정합). */
export function makeOpponentRoster(): OpponentRosterEntry[] {
  return sel.away.players.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    position: p.position,
  }));
}

/** 홈 로스터 playerId 목록(H0..H10) — Phase2 컨텍스트 픽스처 키. */
export function homeRosterIds(): string[] {
  return sel.home.players.map((p) => p.playerId);
}

/** manualTactics 픽스처(P2-D4). */
export function makeManualTactics(overrides: Partial<ManualTactics> = {}): ManualTactics {
  return { line: 0.7, press: 0.6, tempo: 0.55, width: 0.5, ...overrides };
}

/** conditions 픽스처 {playerId: 0..1} — 로스터 전원에 결정론 값 부여. */
export function makeConditions(): Record<string, number> {
  const ids = homeRosterIds();
  const out: Record<string, number> = {};
  ids.forEach((id, i) => {
    out[id] = Number((0.3 + ((i * 7) % 10) / 14).toFixed(2)); // 0.3..~0.94, 결정론
  });
  return out;
}

/** relations 픽스처 {playerId: {trust, personality}} — 성격 4종을 로테이션 배치. */
export function makeRelations(
  overrides: Record<string, Partial<PlayerRelationContext>> = {},
): Record<string, PlayerRelationContext> {
  const personalities = ["FIERY", "CALM", "GLASS", "AMBITIOUS"] as const;
  const ids = homeRosterIds();
  const out: Record<string, PlayerRelationContext> = {};
  ids.forEach((id, i) => {
    out[id] = {
      trust: 50 + ((i * 13) % 45), // 50..94, 결정론
      personality: personalities[i % personalities.length]!,
      ...overrides[id],
    };
  });
  return out;
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

/**
 * A(베이스) TacticalInput 픽스처 — 엔진 makeTacticalInput("H", seed)가 곧 홈 로스터(H0..H10)와 정합하는 유효 A.
 * (roster = 홈팀 H0..H10, ROLES 순서 = slotIndex 순서 → playerId·role 이 그대로 일치.)
 */
export function makeBaseTacticalInput(seed = "4815162342"): TacticalInput {
  return makeTacticalInput("H", seed);
}

/**
 * B(패치) 잡 컨텍스트 픽스처 — team-input 필드 재사용 + base(A) 추가. kind='team-input-patch'.
 */
export function makeTeamInputPatchContext(
  overrides: Partial<TeamInputPatchJobContext> = {},
): TeamInputPatchJobContext {
  const t = makeTeamInputContext();
  return TeamInputPatchJobContext.parse({
    ...t,
    kind: "team-input-patch",
    base: makeBaseTacticalInput(t.seed),
    ...overrides,
  });
}
