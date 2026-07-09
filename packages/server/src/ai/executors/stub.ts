import { makeTacticalInput } from "@hmb/engine";
import type { AiExecutor } from "../executor.js";
import type { AiJob } from "../protocol.js";
import { CoachContext } from "../../coach.js";

/**
 * 결정론 스텁 executor — 키/네트워크/로그인 0 (테스트·오프라인·CI·폴백).
 * 실제 AI 대체가 아니라 큐→검증→결과 배선 검증용. directive 키워드로 성향만 거칠게 조정.
 */
export function stubExecutor(): AiExecutor {
  return {
    name: "stub",
    execute(job: AiJob): Promise<unknown> {
      if (job.kind !== "coach") throw new Error(`stub: 미지원 kind ${job.kind}`);
      const ctx = CoachContext.parse(job.context);
      const t = makeTacticalInput(ctx.prefix, ctx.seed);
      const d = ctx.directive;
      if (/공격|오버랩|하이라인|와이드|attack|wide|overlap/i.test(d)) {
        t.team.defensiveLineHeight = 0.85;
        t.team.width = 0.85;
        t.team.pressingScheme.intensity = 0.8;
        for (const p of t.players) {
          if (p.role === "LB" || p.role === "RB") {
            p.behavior.widthTendency = 0.9;
            p.behavior.forwardRunFreq = 0.85;
          }
        }
      }
      if (/수비|로우|콤팩트|back four|low|defensive|compact/i.test(d)) {
        t.team.defensiveLineHeight = 0.2;
        t.team.compactness = 0.85;
        t.team.width = 0.35;
        t.team.pressingScheme.intensity = 0.2;
        for (const p of t.players) {
          if (p.role === "LB" || p.role === "RB") {
            p.behavior.widthTendency = 0.15;
            p.behavior.forwardRunFreq = 0.05;
          }
        }
      }
      return Promise.resolve(t);
    },
  };
}
