import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMatch } from "../src/match";
import { defaultEngineConfig } from "../src/config";
import { demoSeed, makeTacticalInput, makeSelectData } from "../src/fixtures";
import { clampTacticalInput, TacticalInput, type MatchLog } from "@hmb/shared";
import { computeMatchStats } from "../dev-viewer/match-stats";

/**
 * S3a PoC — "프롬프트가 움직임을 바꾸는가" 증명.
 * AI 코치(Sonnet 서브에이전트)가 서로 다른 자연어 프롬프트에서 생성한 두 홈 TacticalInput 을
 * 같은 시드·같은 베이스라인 상대(away)로 각각 실행 → 홈 팀 움직임 지표가 측정 가능하게 다른가 확인.
 * 입력 JSON 은 poc/inputs/homeA.json, homeB.json (코치 산출물).
 */
const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): TacticalInput => {
  const raw = JSON.parse(readFileSync(join(here, "inputs", name), "utf8"));
  return clampTacticalInput(TacticalInput.parse(raw)); // 스키마 검증 + 범위 클램프(가드레일)
};

const select = makeSelectData();
const baselineAway = makeTacticalInput("A", demoSeed); // 상대는 고정(중립) — 변수는 홈 프롬프트뿐.
const gkIds = new Set(["H0"]);
const defenderIds = new Set(["H1", "H2", "H3", "H4"]); // back four
const opts = { defenderIds, pitchWidthM: defaultEngineConfig.pitch.width, finalThirdLine: defaultEngineConfig.setPiece.finalThirdLine };

function homeStats(log: MatchLog) {
  const s = computeMatchStats(log, gkIds, opts);
  return s.home;
}

describe("S3a PoC — 프롬프트→움직임", () => {
  it("서로 다른 프롬프트는 같은 시드에서 측정 가능하게 다른 홈 움직임을 만든다", () => {
    const homeA = load("homeA.json"); // 공격적: 풀백 오버랩·와이드·하이라인·빠른 템포
    const homeB = load("homeB.json"); // 수비적: back four 고정·콤팩트·로우블록·안전

    const logA = runMatch(demoSeed, homeA, baselineAway, select, defaultEngineConfig);
    const logB = runMatch(demoSeed, homeB, baselineAway, select, defaultEngineConfig);
    const a = homeStats(logA), b = homeStats(logB);

    const rows: [string, number, number][] = [
      ["팀 폭 avgWidthM", a.avgWidthM, b.avgWidthM],
      ["위치분산 posSpreadM", a.posSpreadM, b.posSpreadM],
      ["수비 오버랩 횟수", a.defenderOverlaps, b.defenderOverlaps],
      ["수비 오버랩 player-틱", a.defenderOverlapTicks, b.defenderOverlapTicks],
      ["주행거리 km", a.avgDistanceKm, b.avgDistanceKm],
      ["평균 라인 길이 avgLengthM", a.avgLengthM, b.avgLengthM],
      ["패스 성공%", a.passSuccessPct, b.passSuccessPct],
      ["슛", a.shots, b.shots],
      ["골", a.goals, b.goals],
    ];
    // eslint-disable-next-line no-console
    console.log("\n=== S3a PoC: 홈 팀 움직임 (A=공격적 vs B=수비적, same seed·same away) ===");
    for (const [label, av, bv] of rows) {
      const d = av - bv;
      // eslint-disable-next-line no-console
      console.log(`  ${label.padEnd(26)} A ${String(av).padStart(8)}  | B ${String(bv).padStart(8)}  | Δ ${d >= 0 ? "+" : ""}${d.toFixed(2)}`);
    }

    // (1) 결과 자체가 달라야 한다(프롬프트가 시뮬을 바꿈).
    expect(logA.tickSnapshots.at(-1)!.hash).not.toBe(logB.tickSnapshots.at(-1)!.hash);

    // (2) 움직임이 측정 가능하게 달라야 한다 — 폭·오버랩·분산 중 최소 하나가 노이즈를 넘게 차이.
    const measurablyDifferent =
      Math.abs(a.avgWidthM - b.avgWidthM) >= 1.5 ||
      Math.abs(a.defenderOverlaps - b.defenderOverlaps) >= 20 ||
      Math.abs(a.posSpreadM - b.posSpreadM) >= 1.0;
    expect(measurablyDifferent, "폭/오버랩/분산이 프롬프트에 따라 달라지지 않음").toBe(true);

    // (3) 방향 정합(참고용, 하드 실패 아님): 공격적 A 가 더 넓고 오버랩 많아야 자연스러움.
    const directional = {
      "A 가 더 넓다(avgWidthM)": a.avgWidthM > b.avgWidthM,
      "A 가 오버랩 많다": a.defenderOverlaps > b.defenderOverlaps,
      "A 가 더 뛴다(km)": a.avgDistanceKm > b.avgDistanceKm,
    };
    // eslint-disable-next-line no-console
    console.log("  방향 정합(직관 대비):", JSON.stringify(directional));
  });
});
