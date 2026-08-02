/**
 * #407 부수 발견 — origin/main(engine@0.40.0) 볼륨 밴드 red 의 원인 귀속(분석 전용, 일회성).
 * 프로덕션 config 는 건드리지 않고 realism/config-override 로 데이터 주입만 한다.
 *
 * 실행: node tools/run-gate.mjs --label e407-ablate -- npx tsx research/e407-probe/e407-volume-ablate.ts
 */
import { defaultEngineConfig } from "../../packages/engine/src/config";
import { applyConfigOverrides } from "../../packages/engine/src/realism/config-override";
import { aggregateRealism, REALISM_SEEDS } from "../../packages/engine/src/realism/harness";

/** config 트리에서 `enabled: boolean` 을 가진 노드의 점 경로를 전부 찾는다(토글 후보 발견용). */
function findEnabledPaths(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
  const out: string[] = [];
  const rec = node as Record<string, unknown>;
  if (typeof rec.enabled === "boolean") out.push(prefix ? `${prefix}.enabled` : "enabled");
  for (const [k, v] of Object.entries(rec)) {
    if (k === "enabled") continue;
    out.push(...findEnabledPaths(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

const BANDS = {
  shots: [7.2, 8.4],
  goals: [1.4, 1.85],
  onTarget: [2.9, 3.5],
  xgPerShot: [0.18, 0.24],
  shotConvPct: [17, 22],
} as const;

function mark(v: number, b: readonly [number, number]) {
  return v < b[0] ? "LOW " : v > b[1] ? "HIGH" : "OK  ";
}

const enabledPaths = findEnabledPaths(defaultEngineConfig);
console.log(`[토글 후보 ${enabledPaths.length}개]`);
for (const p of enabledPaths) console.log("  " + p);
console.log("");

const WANT = ["through", "pressUnit", "defLine", "lane", "telegraph", "vision"];
const toggles = enabledPaths.filter((p) => WANT.some((w) => p.toLowerCase().includes(w.toLowerCase())));

const POINTS: { label: string; ov: Record<string, unknown> }[] = [
  { label: "출하 0.40.0 (baseline)", ov: {} },
  { label: "shootXgThreshold 0.07→0.197 (#370 롤백 전)", ov: { "contest.shootXgThreshold": 0.197 } },
  ...toggles.map((p) => ({ label: `${p} = false`, ov: { [p]: false } })),
];

for (const p of POINTS) {
  let cfg = defaultEngineConfig;
  try {
    cfg = Object.keys(p.ov).length ? applyConfigOverrides(defaultEngineConfig, p.ov) : defaultEngineConfig;
  } catch (e) {
    console.log(`${p.label.padEnd(48)} SKIP (${(e as Error).message.slice(0, 70)})`);
    continue;
  }
  const m = aggregateRealism(cfg, REALISM_SEEDS).mean;
  console.log(
    `${p.label.padEnd(48)} shots ${m.shots.toFixed(2).padStart(5)} ${mark(m.shots, BANDS.shots)} | ` +
      `goals ${m.goals.toFixed(2)} ${mark(m.goals, BANDS.goals)} | ` +
      `onTgt ${m.onTarget.toFixed(2)} ${mark(m.onTarget, BANDS.onTarget)} | ` +
      `xG/shot ${m.xgPerShot.toFixed(3)} ${mark(m.xgPerShot, BANDS.xgPerShot)} | ` +
      `conv ${m.shotConvPct.toFixed(1)}% ${mark(m.shotConvPct, BANDS.shotConvPct)}`,
  );
}
