import { runMatch, makeSelectData, makeTacticalInput, defaultEngineConfig } from "@hmb/engine";
import { TacticalInput, type MatchLog } from "@hmb/shared";
import type { CoachContext } from "./coach.js";

/**
 * 결정론 경계: AI 는 인풋(TacticalInput)만 만들고, 시뮬은 여기서 엔진 결정론 그대로.
 * 같은 seed + 같은 input(결과캐시 저장분) → 같은 MatchLog (리플레이/PvP 재현).
 */

// 코치 프롬프트용 로스터 컨텍스트(4-3-3 기본, 안정부 = 캐시 프리픽스). 추후 SelectData 에서 동적 파생.
export const ROSTER_CONTEXT = [
  "4-3-3, playerId H0..H10. 좌표계 x=0(자기 골문)→1(상대 골문), y=0..1(좌우 폭).",
  "H0 GK(0.05,0.5) H1 LB(0.22,0.2) H2 LCB(0.16,0.4) H3 RCB(0.16,0.6) H4 RB(0.22,0.8)",
  "H5 LCM(0.44,0.32) H6 CM(0.40,0.50) H7 RCM(0.44,0.68) H8 LW(0.70,0.20) H9 ST(0.78,0.50) H10 RW(0.70,0.80)",
].join("\n");

/** directive+seed(+선수별 프롬프트) → coach 잡 컨텍스트(= AiJob.context). */
export function coachContext(
  directive: string,
  seed: string,
  playerPrompts?: Record<string, string>,
): CoachContext {
  const ctx: CoachContext = { directive, rosterContext: ROSTER_CONTEXT, seed, prefix: "H" };
  if (playerPrompts && Object.keys(playerPrompts).length > 0) ctx.playerPrompts = playerPrompts;
  return ctx;
}

/** 검증 통과한 홈 입력으로 결정론 매치 실행. 상대(away)는 중립 베이스라인. */
export function runMatchWithHomeInput(homeRaw: unknown, seed: string): MatchLog {
  const home = TacticalInput.parse(homeRaw); // 캐시에서 온 값도 재검증(방어)
  const away = makeTacticalInput("A", seed);
  return runMatch(seed, home, away, makeSelectData(), defaultEngineConfig);
}
