/** #407 0.44.0 — 볼륨 트레이드오프를 **게임 언어**로 환산(릴리스 리뷰용). 분석 전용. */
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config";
import { applyConfigOverrides } from "../../packages/engine/src/realism/config-override";
import { GUARD_SEEDS } from "../../packages/engine/src/realism/harness";
import { runMatch } from "../../packages/engine/src/match";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures";
import { computeMatchStats } from "../../packages/engine/dev-viewer/match-stats";

const select = makeSelectData();
const GK = new Set(["H0", "A0"]);
const DEF = new Set(["H1","H2","H3","H4","A1","A2","A3","A4"]);

function run(ov: Record<string, unknown>): Record<string, number> {
  const cfg = Object.keys(ov).length
    ? applyConfigOverrides(defaultEngineConfig, ov as never) as EngineConfig
    : defaultEngineConfig;
  let goals = 0, onT = 0, corners = 0, shots = 0, fouls = 0, saves = 0;
  const perMatchGoals: number[] = [];
  for (const s of GUARD_SEEDS) {
    const log = runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, cfg);
    const st = computeMatchStats(log, GK, {
      defenderIds: DEF, pitchWidthM: cfg.pitch.width, finalThirdLine: cfg.setPiece.finalThirdLine,
    });
    const g = st.home.goals + st.away.goals;
    perMatchGoals.push(g);
    goals += g; onT += st.home.onTarget + st.away.onTarget;
    corners += st.home.corners + st.away.corners; shots += st.home.shots + st.away.shots;
    fouls += st.home.fouls + st.away.fouls; saves += st.home.saves + st.away.saves;
  }
  const n = GUARD_SEEDS.length;
  const sorted = [...perMatchGoals].sort((a, b) => a - b);
  return {
    goalsPerMatch: goals / n,
    onTargetPerMatch: onT / n,
    cornersPerMatch: corners / n,
    shotsPerMatch: shots / n,
    foulsPerMatch: fouls / n,
    savesPerMatch: saves / n,
    goalsMedian: sorted[Math.floor(n / 2)]!,
    goalsMin: sorted[0]!,
    goalsMax: sorted[n - 1]!,
    matchesOver6Goals: perMatchGoals.filter((g) => g >= 6).length / n * 100,
  };
}

const ARMS: { label: string; ov: Record<string, unknown> }[] = [
  { label: "0.43.0 BASE", ov: {} },
  { label: "0.44.0 ARM .2/.45/f.22", ov: {
    "variety.defenderOverlapProb": 0.2, "variety.overlapBaseLine": 0.45, "rules.foul.base": 0.22 } },
];
console.log(`# 게임 체감 환산 — n=${GUARD_SEEDS.length} 경기, engine@${defaultEngineConfig.version}`);
const KEYS = ["goalsPerMatch","goalsMedian","goalsMin","goalsMax","matchesOver6Goals",
              "onTargetPerMatch","savesPerMatch","cornersPerMatch","shotsPerMatch","foulsPerMatch"];
console.log("팔".padEnd(26) + KEYS.map((k) => k.padStart(19)).join(""));
for (const a of ARMS) {
  const m = run(a.ov);
  console.log(a.label.padEnd(26) + KEYS.map((k) => m[k]!.toFixed(2).padStart(19)).join(""));
}
