import { describe, it, expect } from "vitest";
import { claudeCodeExecutor } from "./executors/claude-code.js";
import { validateCoachOutput, type CoachContext } from "../coach.js";
import { ROSTER_CONTEXT } from "../pipeline.js";
import type { AiJob } from "./protocol.js";

// AC6 라이브 스모크 — 실제 `claude` 구독 로그인 필요. AI_LIVE=1 없으면 skip(npm test 는 로그인 0 그린).
//   AI_LIVE=1 npx vitest run packages/server/src/ai/live.test.ts
// 모델은 AI_MODEL(기본 sonnet)로 스왑 가능. ANTHROPIC_API_KEY 는 설정하지 말 것(메터드로 샘).
const LIVE = process.env["AI_LIVE"] === "1";

function coachJob(directive: string): AiJob {
  const ctx: CoachContext = { directive, rosterContext: ROSTER_CONTEXT, seed: "4815162342", prefix: "H" };
  return { id: `live-${directive.slice(0, 4)}`, kind: "coach", context: ctx, enqueuedAt: "t" };
}

describe.skipIf(!LIVE)("W2 라이브 (AI_LIVE=1, 구독 로그인)", () => {
  const ex = claudeCodeExecutor(); // 실제 claude subprocess, 기본 sonnet(AI_MODEL 로 스왑)

  it("공격 directive → 게이트 통과하는 TacticalInput 생성", async () => {
    const raw = await ex.execute(coachJob("양 풀백 오버랩·와이드·하이라인·강한 압박. 매우 공격적."));
    const t = validateCoachOutput(raw, "H");
    expect(t.players).toHaveLength(11);
  }, 180_000);

  it("공격 vs 수비 → 폭 방향 차이(PoC #19 정합)", async () => {
    const atk = validateCoachOutput(await ex.execute(coachJob("양 풀백 오버랩·와이드·하이라인. 매우 공격적.")), "H");
    const def = validateCoachOutput(await ex.execute(coachJob("콤팩트 로우블록·back four 고정·낮은 라인. 매우 수비적.")), "H");
    // eslint-disable-next-line no-console
    console.log(`[live parity] width atk=${atk.team.width} def=${def.team.width} / line atk=${atk.team.defensiveLineHeight} def=${def.team.defensiveLineHeight}`);
    // 강한 방향 단언(같으면 실패 = 모델이 지시를 무시했다는 뜻). 관측치 atk0.85/def0.35, line0.85/0.15.
    expect(atk.team.width).toBeGreaterThan(def.team.width);
    expect(atk.team.defensiveLineHeight).toBeGreaterThan(def.team.defensiveLineHeight);
  }, 300_000);
});
