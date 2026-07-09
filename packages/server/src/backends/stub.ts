import { makeTacticalInput } from "@hmb/engine";
import type { CoachBackend } from "../coach-backend.js";
import type { CoachRequest } from "../coach.js";

/**
 * 결정론 스텁 백엔드 — 키/네트워크 불필요(테스트·오프라인·CI).
 * directive 키워드로 팀 성향만 거칠게 조정(공격/수비). 실제 AI 대체가 아니라 배선/파이프라인 검증용.
 */
export function stubCoachBackend(): CoachBackend {
  return {
    name: "stub",
    generate(req: CoachRequest): Promise<unknown> {
      const t = makeTacticalInput(req.prefix, req.seed);
      const d = req.directive;
      if (/공격|오버랩|하이라인|와이드|attack|wide|overlap/i.test(d)) {
        t.team.defensiveLineHeight = 0.85;
        t.team.width = 0.85;
        t.team.pressingScheme.intensity = 0.8;
        for (const p of t.players) if (p.role === "LB" || p.role === "RB") {
          p.behavior.widthTendency = 0.9;
          p.behavior.forwardRunFreq = 0.85;
        }
      }
      if (/수비|로우|콤팩트|back four|low|defensive|compact/i.test(d)) {
        t.team.defensiveLineHeight = 0.2;
        t.team.compactness = 0.85;
        t.team.width = 0.35;
        t.team.pressingScheme.intensity = 0.2;
        for (const p of t.players) if (p.role === "LB" || p.role === "RB") {
          p.behavior.widthTendency = 0.15;
          p.behavior.forwardRunFreq = 0.05;
        }
      }
      return Promise.resolve(t);
    },
  };
}
