/**
 * #407 Phase 2-C — **조합 측정기**(시나리오 후보 검증). 분석 전용, 프로덕션 무수정.
 *
 * 사다리(B)에서 산 레버를 조합해 목표 골 시나리오별 후보를 실측한다.
 * 조합은 `HMB_COMBOS` 로 JSON 주입하거나(임시 격자), 인자 없으면 아래 기본 목록을 돈다.
 *
 * 실행:
 *   node tools/run-gate.mjs --label e407-combo -- npx tsx research/e407-probe/e407-volume-combo.ts
 *   HMB_COMBOS='[{"label":"r16gv13","ov":{"contest.shootRange":16,"chain.goalValue":13}}]' \
 *     node tools/run-gate.mjs --label e407-combo -- npx tsx research/e407-probe/e407-volume-combo.ts
 * 환경변수: HMB_SEEDS=60 (기본 60)
 */
import { defaultEngineConfig } from "../../packages/engine/src/config";
import { runPoint, type Acct } from "./e407-volume-account";
import { REALISM_SEEDS, GUARD_SEEDS } from "../../packages/engine/src/realism/harness";

const N = Number(process.env.HMB_SEEDS || 60);
const SEEDS = N > 20 ? GUARD_SEEDS.slice(0, N) : REALISM_SEEDS.slice(0, N);

interface Combo {
  label: string;
  ov: Record<string, unknown>;
}

const DEFAULT_COMBOS: Combo[] = [
  { label: "base 0.40.0", ov: {} },
  { label: "r17", ov: { "contest.shootRange": 17 } },
  { label: "r16", ov: { "contest.shootRange": 16 } },
  { label: "r15", ov: { "contest.shootRange": 15 } },
  { label: "r14", ov: { "contest.shootRange": 14 } },
  { label: "r17 gv16", ov: { "contest.shootRange": 17, "chain.goalValue": 16 } },
  { label: "r17 gv13", ov: { "contest.shootRange": 17, "chain.goalValue": 13 } },
  { label: "r17 gv10", ov: { "contest.shootRange": 17, "chain.goalValue": 10 } },
  { label: "r16 gv13", ov: { "contest.shootRange": 16, "chain.goalValue": 13 } },
  { label: "r16 gv10", ov: { "contest.shootRange": 16, "chain.goalValue": 10 } },
  { label: "r15 gv13", ov: { "contest.shootRange": 15, "chain.goalValue": 13 } },
  { label: "r15 gv10", ov: { "contest.shootRange": 15, "chain.goalValue": 10 } },
  { label: "r14 gv13", ov: { "contest.shootRange": 14, "chain.goalValue": 13 } },
];

const COLS: { k: keyof Acct; d: number; label: string; band?: [number, number] }[] = [
  { k: "shots", d: 2, label: "슛", band: [7.2, 8.4] },
  { k: "goals", d: 2, label: "팀골", band: [1.4, 1.85] },
  { k: "onTarget", d: 2, label: "유효", band: [2.9, 3.5] },
  { k: "onTargetPct", d: 1, label: "유효%", band: [45, 50] },
  { k: "xgPerShot", d: 3, label: "xG/슛", band: [0.18, 0.24] },
  { k: "shotConvPct", d: 1, label: "전환%", band: [17, 22] },
  { k: "passSuccessPct", d: 1, label: "패스%", band: [78, 85] },
  { k: "widthM", d: 1, label: "폭m", band: [40, 50] },
  { k: "corners", d: 2, label: "코너", band: [2.0, 3.0] },
  { k: "throwIns", d: 2, label: "스로인", band: [8.4, 9.4] },
  { k: "fouls", d: 2, label: "파울", band: [5.5, 6.0] },
  { k: "distanceKm", d: 2, label: "주행km", band: [5, 6] },
  { k: "shotDistM", d: 1, label: "슛거리m" },
  { k: "inBoxShotPct", d: 1, label: "박스슛%" },
  { k: "shotsPerF3", d: 3, label: "슛/F3" },
];

function fmt(m: Acct): string {
  return COLS.map((c) => {
    const v = m[c.k];
    const flag = c.band ? (v < c.band[0] ? "-" : v > c.band[1] ? "+" : " ") : " ";
    return (v.toFixed(c.d) + flag).padStart(9);
  }).join("");
}

function main(): void {
  const combos: Combo[] = process.env.HMB_COMBOS ? JSON.parse(process.env.HMB_COMBOS) : DEFAULT_COMBOS;
  console.log(`# e407 조합 측정 — 시드 ${SEEDS.length}(팀-경기 ${SEEDS.length * 2}), engine@${defaultEngineConfig.version}`);
  console.log("  밴드: 45분 재도출(shot-frequency SoT) + 카운트형은 길이보정(BENCH×0.5). '+/-' = 이탈");
  console.log("조합".padEnd(26) + "경기골".padStart(8) + COLS.map((c) => c.label.padStart(9)).join(""));
  for (const c of combos) {
    const m = runPoint(c.ov, SEEDS);
    console.log(c.label.padEnd(26) + (m.goals * 2).toFixed(2).padStart(8) + fmt(m));
  }
}

main();
