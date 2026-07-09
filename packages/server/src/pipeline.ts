import { runMatch, makeSelectData, makeTacticalInput, defaultEngineConfig } from "@hmb/engine";
import type { MatchLog } from "@hmb/shared";
import { promptToTacticalInput, type CoachRequest } from "./coach.js";
import type { CoachBackend } from "./coach-backend.js";
import { defaultCoachBackend } from "./coach-factory.js";

// 코치 프롬프트용 로스터 컨텍스트(4-3-3 기본). S3b 에서 SelectData/포메이션에서 동적으로 파생.
const ROSTER_CONTEXT = [
  "4-3-3, playerId H0..H10. 좌표계 x=0(자기 골문)→1(상대 골문), y=0..1(좌우 폭).",
  "H0 GK(0.05,0.5) H1 LB(0.22,0.2) H2 LCB(0.16,0.4) H3 RCB(0.16,0.6) H4 RB(0.22,0.8)",
  "H5 LCM(0.44,0.32) H6 CM(0.40,0.50) H7 RCM(0.44,0.68) H8 LW(0.70,0.20) H9 ST(0.78,0.50) H10 RW(0.70,0.80)",
].join("\n");

/**
 * 서버 권위 파이프라인: 감독 지시 → (코치=AI) 홈 TacticalInput → 결정론 runMatch → MatchLog.
 * 상대(away)는 현재 중립 베이스라인. S3b 에서 양팀 프롬프트·개입(하프타임) 확장.
 */
export async function runFromDirective(directive: string, seed: string, backend?: CoachBackend): Promise<MatchLog> {
  const req: CoachRequest = { directive, rosterContext: ROSTER_CONTEXT, seed, prefix: "H" };
  const home = await promptToTacticalInput(req, backend ?? defaultCoachBackend());
  const away = makeTacticalInput("A", seed); // 중립 베이스라인 상대
  const select = makeSelectData();
  return runMatch(seed, home, away, select, defaultEngineConfig);
}
