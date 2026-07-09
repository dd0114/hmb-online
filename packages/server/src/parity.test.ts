import { describe, it, expect } from "vitest";
import { runMatch, makeSelectData, makeTacticalInput, defaultEngineConfig } from "@hmb/engine";
import type { MatchLog } from "@hmb/shared";
import { promptToTacticalInput, type CoachRequest } from "./coach.js";
import { anthropicCoachBackend } from "./backends/anthropic.js";

// S3b AC3 — 라이브 패리티: 실제 Claude 코치(anthropic 백엔드, 기본 sonnet)가 만든 두 전술이
// PoC(#19)와 같은 방향의 움직임 차이를 내는가. ANTHROPIC_API_KEY 있을 때만 실행(없으면 skip).
const KEY = process.env["ANTHROPIC_API_KEY"];
const backend = anthropicCoachBackend(); // 기본 sonnet, COACH_MODEL 로 스왑 가능

const ROSTER = [
  "4-3-3, playerId H0..H10. x=0(자기 골문)→1(상대 골문), y=0..1(좌우 폭).",
  "H0 GK(0.05,0.5) H1 LB(0.22,0.2) H2 LCB(0.16,0.4) H3 RCB(0.16,0.6) H4 RB(0.22,0.8)",
  "H5 LCM(0.44,0.32) H6 CM(0.40,0.50) H7 RCM(0.44,0.68) H8 LW(0.70,0.20) H9 ST(0.78,0.50) H10 RW(0.70,0.80)",
].join("\n");
const SEED = "4815162342";

function homeWidth(log: MatchLog): number {
  let sum = 0, n = 0;
  for (const s of log.tickSnapshots) {
    const ys = s.players.filter((p) => p.team === "home" && p.playerId !== "H0").map((p) => p.pos.y);
    if (ys.length) { sum += Math.max(...ys) - Math.min(...ys); n++; }
  }
  return n ? sum / n : 0;
}
function fullbackAdvance(log: MatchLog): number {
  let sum = 0, n = 0;
  for (const s of log.tickSnapshots) for (const p of s.players) {
    if (p.playerId === "H1" || p.playerId === "H4") { sum += p.pos.x; n++; }
  }
  return n ? sum / n : 0;
}

async function runDirective(directive: string): Promise<MatchLog> {
  const req: CoachRequest = { directive, rosterContext: ROSTER, seed: SEED, prefix: "H" };
  const home = await promptToTacticalInput(req, backend);
  const away = makeTacticalInput("A", SEED);
  return runMatch(SEED, home, away, makeSelectData(), defaultEngineConfig);
}

describe.skipIf(!KEY)("S3b 라이브 패리티 (ANTHROPIC_API_KEY 필요)", () => {
  it("공격적 vs 수비적 프롬프트 → 공격적이 더 넓고 풀백이 더 전진", async () => {
    const logA = await runDirective("양 풀백(H1,H4)을 공격적으로 오버랩시키고 윙어는 넓게 벌려라. 하이라인·강압박·빠른 템포. 매우 공격적으로.");
    const logB = await runDirective("풀백(H1,H4)은 back four 고정, 오버랩 금지. 콤팩트 로우블록·낮은 라인·압박 자제·안전한 패스·느린 템포. 매우 수비적으로.");
    const wA = homeWidth(logA), wB = homeWidth(logB);
    const fA = fullbackAdvance(logA), fB = fullbackAdvance(logB);
    // eslint-disable-next-line no-console
    console.log(`[parity] width A ${wA.toFixed(1)} vs B ${wB.toFixed(1)} | 풀백 전진 x A ${fA.toFixed(2)} vs B ${fB.toFixed(2)}`);
    expect(logA.tickSnapshots.at(-1)!.hash).not.toBe(logB.tickSnapshots.at(-1)!.hash);
    expect(wA).toBeGreaterThan(wB); // 공격적이 더 넓다
    expect(fA).toBeGreaterThan(fB); // 공격적 풀백이 더 전진
  }, 90_000);
});
