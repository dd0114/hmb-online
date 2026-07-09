import { describe, it, expect } from "vitest";
import { stubCoachBackend } from "./stub.js";
import { validateCoachOutput, type CoachRequest } from "../coach.js";

// stub 백엔드 결정론 검증(키 불필요) — 배선/방향만 확인(실제 AI 아님).
describe("stub 백엔드", () => {
  const roster = "H0..H10 4-3-3";
  const gen = async (directive: string) => {
    const req: CoachRequest = { directive, rosterContext: roster, seed: "42", prefix: "H" };
    return validateCoachOutput(await stubCoachBackend().generate(req), "H");
  };

  it("공격 지시가 수비 지시보다 넓고 라인 높고 풀백 전진(방향)", async () => {
    const A = await gen("풀백 오버랩·와이드·하이라인 공격적");
    const B = await gen("콤팩트 로우블록·back four 고정 수비적");
    expect(A.team.width).toBeGreaterThan(B.team.width);
    expect(A.team.defensiveLineHeight).toBeGreaterThan(B.team.defensiveLineHeight);
    const fbW = (t: typeof A) => t.players.filter((p) => p.role === "LB" || p.role === "RB").map((p) => p.behavior.widthTendency);
    expect(Math.min(...fbW(A))).toBeGreaterThan(Math.max(...fbW(B)));
  });
});
