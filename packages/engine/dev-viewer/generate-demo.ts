import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../src/match";
import { defaultEngineConfig } from "../src/config";
import { demoSeed, demoHome, demoAway, demoSelect } from "../src/fixtures";
import { computeMatchStats, formatStatsReport, type StatsOptions, type MatchStats } from "./match-stats";

/**
 * generate-demo — fixtures 로 runMatch 를 실행해 dev-viewer/match-log.json 을 만든다.
 * index.html 이 이 JSON 을 fetch 해서 경기를 애니메이션한다.
 *
 * 실행 방법(둘 중 택1):
 *  1) 테스트 러너(권장, Node 20 OK):
 *       npx vitest run packages/engine/dev-viewer/generate-demo.test.ts
 *     → match-log.json 이 (재)생성된다.
 *  2) Node 22+ 직접 실행:
 *       node --experimental-strip-types packages/engine/dev-viewer/generate-demo.ts
 */

/** 데모 MatchLog 생성(리얼 config = 스탯 증빙용). */
export function buildDemoLog(): MatchLog {
  return runMatch(demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig);
}

/**
 * 쇼케이스 config — 뷰어 관전용(리얼 아님). 경기 시간을 줄이고 골 확률을 높여
 * "짧고 잘 보이는" 데모를 만든다. 리얼 config(defaultEngineConfig)는 그대로 유지.
 * 튜닝 노브(가독성): matchMinutes(관전시간) · contest.xgBase/onTargetBase(골 빈도).
 */
export const showcaseConfig = {
  ...defaultEngineConfig,
  version: "engine@0.4.0-showcase",
  matchMinutes: 24,
  decisionWeights: {
    ...defaultEngineConfig.decisionWeights,
    shoot: 1.6, // 슛 더 자주(관전 재미).
  },
  contest: {
    ...defaultEngineConfig.contest,
    xgBase: 0.5, // 0.225 → 0.5 (슛당 득점 확률↑ = 골 더 많이)
    onTargetBase: 0.55, // 유효슛↑ → 세이브 상황↑
    shootXgThreshold: 0.05,
    saveCornerProb: 0.7, // 세이브→코너 굴절↑
    offTargetBlockCornerProb: 0.45, // 빗맞음→코너↑
    oneOnOneClearM: 7.0,
    oneOnOneXgMult: 2.0, // 1대1 하이라이트 더 강하게
  },
  variety: {
    ...defaultEngineConfig.variety,
    dribbleChainProb: 0.8,
    dribbleChainBonus: 1.6,
    dribbleChainMaxTicks: 6,
    defenderOverlapProb: 0.2,
    overlapReach: 0.45,
    decisionTemperature: 0.7,
    roamNoiseAmp: 4.5,
  },
};

/** 쇼케이스 MatchLog(뷰어용). */
export function buildShowcaseLog(): MatchLog {
  return runMatch(demoSeed, demoHome, demoAway, demoSelect, showcaseConfig);
}

/**
 * 골 검증(AC-goal-in-net): 각 goal 이벤트의 골 틱 스냅샷에서 공이
 *  - 골라인 근처(x < nearLine 또는 x > width-nearLine)  AND
 *  - 골포스트 y 범위 안(centerY ± goalWidth/2)
 * 에 있으면 PASS. 센터(52.5,34)로 리셋되면 FAIL.
 */
function buildGoalInNetReport(log: MatchLog, label: string): { report: string; allPass: boolean } {
  const width = defaultEngineConfig.pitch.width; // 105
  const height = defaultEngineConfig.pitch.height; // 68
  const goalWidth = defaultEngineConfig.pitch.goalWidth; // 7.32
  const centerY = height / 2;
  const halfPost = goalWidth / 2;
  const yLo = centerY - halfPost;
  const yHi = centerY + halfPost;
  const nearLine = 3; // 골라인 근처 허용 오차(m).

  const snapByTick = new Map<number, (typeof log.tickSnapshots)[number]>();
  for (const s of log.tickSnapshots) snapByTick.set(s.tick, s);

  const goals = log.events.filter((e) => e.type === "goal");
  const lines: string[] = [];
  lines.push(`=== AC-goal-in-net: ${label} (${log.configVersion}, seed ${log.seed}) ===`);
  lines.push(
    `골라인 근처 기준: x < ${nearLine} 또는 x > ${width - nearLine} | 골포스트 y 범위: ${yLo.toFixed(2)}..${yHi.toFixed(2)}`,
  );
  lines.push(`총 골: ${goals.length}`);
  let allPass = true;
  goals.forEach((g, i) => {
    const snap = snapByTick.get(g.tick);
    if (!snap) {
      allPass = false;
      lines.push(`  #${i + 1} tick=${g.tick} team=${g.team} FAIL: 스냅샷 없음`);
      return;
    }
    const { x, y } = snap.ball;
    const nearGoalLine = x < nearLine || x > width - nearLine;
    const inPosts = y >= yLo && y <= yHi;
    const pass = nearGoalLine && inPosts;
    if (!pass) allPass = false;
    lines.push(
      `  #${i + 1} tick=${g.tick} team=${g.team} ball=(${x.toFixed(2)},${y.toFixed(2)}) ` +
        `골라인=${nearGoalLine ? "O" : "X"} 포스트내=${inPosts ? "O" : "X"} => ${pass ? "PASS" : "FAIL"}`,
    );
  });
  lines.push(`결과: ${allPass ? "ALL PASS" : "FAIL"} (센터(52.5,34) 리셋이면 FAIL)`);
  return { report: lines.join("\n"), allPass };
}

/** 데모 SelectData 에서 GK playerId 집합. */
function demoGkIds(): Set<string> {
  const gk = new Set<string>();
  for (const p of demoSelect.home.players) if (p.position === "GK") gk.add(p.playerId);
  for (const p of demoSelect.away.players) if (p.position === "GK") gk.add(p.playerId);
  return gk;
}

/** 데모 입력에서 수비수(back four, base 진행도<=0.25, GK 제외) playerId 집합 — 오버랩 계측용. */
function demoDefenderIds(): Set<string> {
  const def = new Set<string>();
  for (const inp of [demoHome, demoAway]) {
    for (const p of inp.players) {
      if (p.role !== "GK" && p.basePosition.x <= 0.25) def.add(p.playerId);
    }
  }
  return def;
}

/** 리얼 계측용 StatsOptions. */
function statsOpts(): StatsOptions {
  return {
    defenderIds: demoDefenderIds(),
    pitchWidthM: defaultEngineConfig.pitch.width,
    finalThirdLine: defaultEngineConfig.setPiece.finalThirdLine,
  };
}

/**
 * 변주 OFF 기준(baseline) config — 모든 variety 노브 0 + 1대1 부스트 비활성.
 * 이 config 는 engine@0.3.0 최적수렴 동작과 동일해야 한다(변주 전/후 대조 + 회귀 앵커).
 */
const baselineConfig = {
  ...defaultEngineConfig,
  version: "engine@0.4.0-baseline",
  contest: { ...defaultEngineConfig.contest, oneOnOneXgMult: 1 },
  variety: {
    ...defaultEngineConfig.variety,
    dribbleChainProb: 0,
    defenderOverlapProb: 0,
    decisionTemperature: 0,
    roamNoiseAmp: 0,
  },
};

/** 변주 전/후 핵심 지표 대조 리포트(AC-variety.log). */
function buildVarietyReport(before: MatchStats, after: MatchStats, beforeHash: string, afterHash: string): string {
  const sum = (t: MatchStats, k: keyof MatchStats["home"]): number =>
    (t.home[k] as number) + (t.away[k] as number);
  const avg = (t: MatchStats, k: keyof MatchStats["home"]): number =>
    Math.round(((t.home[k] as number) + (t.away[k] as number)) / 2 * 10) / 10;
  const L: string[] = [];
  L.push("=== HMB S1 엔진 변주(다이나믹) 전/후 대조 — AC-variety ===");
  L.push(`before=engine@0.4.0-baseline(변주 OFF, ==0.3.0)  after=${defaultEngineConfig.version}(변주 ON)  seed ${demoSeed}`);
  L.push(`baseline lastHash=${beforeHash}  (0.3.0 golden=4e7a2771 → 일치 시 변주 OFF==0.3.0 회귀 보증)`);
  L.push(`variety(after) lastHash=${afterHash}`);
  L.push("");
  const col = (s: string, w: number): string => s.padEnd(w);
  L.push(col("지표(양팀 합/평균)", 26) + col("before", 12) + col("after", 12) + "해석");
  const rowSum = (label: string, k: keyof MatchStats["home"], note: string): void => {
    L.push(col(label, 26) + col(String(sum(before, k)), 12) + col(String(sum(after, k)), 12) + note);
  };
  const rowAvg = (label: string, k: keyof MatchStats["home"], note: string): void => {
    L.push(col(label, 26) + col(String(avg(before, k)), 12) + col(String(avg(after, k)), 12) + note);
  };
  rowAvg("평균 드리블 체인(틱)", "avgDribbleChain", "롱드리블(연속 돌파)");
  rowSum("최대 드리블 체인(틱)", "maxDribbleChain", "");
  rowSum("드리블 체인 수", "dribbleChains", "");
  rowSum("수비 오버랩(횟수)", "defenderOverlaps", "돌발 전진(뒤공간 노출)");
  rowSum("수비 오버랩(player-틱)", "defenderOverlapTicks", "");
  rowAvg("위치 분산(RMS m)", "posSpreadM", "슬롯 고착 완화(로밍)");
  L.push("");
  rowSum("슛(시도)", "shots", "");
  rowSum("유효슛", "onTarget", "세이브 상황↑");
  rowSum("세이브", "savedShots", "");
  rowSum("off_target", "offTargetShots", "");
  rowSum("1대1 찬스", "oneOnOne", "하이라이트");
  rowSum("슛→코너 전환", "shotToCorner", "");
  rowSum("슛→골킥 전환", "shotToGoalKick", "");
  rowSum("코너", "corners", "");
  rowSum("골", "goals", "");
  return L.join("\n");
}

/**
 * MatchLog 를 dev-viewer/match-log.json 으로 저장하고, 매치 스탯을
 * evidence/S1/AC-stats-v2.log 로 저장한다. 벤치마크 대조 스탯을 summary 로 반환.
 */
export function writeDemo(outPath?: string): { path: string; statsPath: string; summary: Record<string, unknown> } {
  // 뷰어용은 쇼케이스(짧게+골↑), 스탯 증빙은 리얼 config 로 계측.
  const showcase = buildShowcaseLog();
  const log = buildDemoLog(); // 리얼 config — 벤치마크 대조 스탯용
  const here = dirname(fileURLToPath(import.meta.url));
  const path = outPath ?? join(here, "match-log.json");
  writeFileSync(path, JSON.stringify(showcase));

  // 매치 스탯 계측(리얼 config) → evidence/S1/AC-stats-v2.log.
  const opts = statsOpts();
  const stats = computeMatchStats(log, demoGkIds(), opts);
  const report = formatStatsReport(stats, {
    configVersion: log.configVersion,
    seed: log.seed,
    finalScore: log.finalScore,
  });
  const repoRoot = join(here, "..", "..", "..");
  const evidenceDir = join(repoRoot, "evidence", "S1");
  mkdirSync(evidenceDir, { recursive: true });
  const statsPath = join(evidenceDir, "AC-stats-v2.log");
  writeFileSync(statsPath, report + "\n");

  // 변주 전/후 대조(baseline=변주 OFF vs default=변주 ON) → evidence/S1/AC-variety.log.
  const baseLog = runMatch(demoSeed, demoHome, demoAway, demoSelect, baselineConfig);
  const baseStats = computeMatchStats(baseLog, demoGkIds(), opts);
  const baseHash = baseLog.tickSnapshots[baseLog.tickSnapshots.length - 1]?.hash ?? "";
  const afterHash = log.tickSnapshots[log.tickSnapshots.length - 1]?.hash ?? "";
  const varietyPath = join(evidenceDir, "AC-variety.log");
  writeFileSync(varietyPath, buildVarietyReport(baseStats, stats, baseHash, afterHash) + "\n");

  // 골 검증(AC-goal-in-net): 쇼케이스(골 많음)+리얼 두 로그 모두 계측 → evidence/S1/AC-goal-in-net.log.
  const showGoals = buildGoalInNetReport(showcase, "showcase(viewer)");
  const realGoals = buildGoalInNetReport(log, "real(default)");
  const goalNetPath = join(evidenceDir, "AC-goal-in-net.log");
  writeFileSync(goalNetPath, `${showGoals.report}\n\n${realGoals.report}\n`);

  const summary = {
    configVersion: log.configVersion,
    seed: log.seed,
    ticks: log.tickSnapshots.length,
    finalScore: log.finalScore,
    events: log.events.length,
    goals: log.events.filter((e) => e.type === "goal").length,
    // 슛 킥 이벤트만(off_target/saved 결과 이벤트 제외; one_on_one 포함).
    shots: log.events.filter((e) => e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target").length,
    oneOnOne: log.events.filter((e) => e.type === "shot" && e.detail === "one_on_one").length,
    corners: log.events.filter((e) => e.type === "kickoff" && e.detail === "corner").length,
    throwIns: log.events.filter((e) => e.type === "kickoff" && e.detail === "throw_in").length,
    goalKicks: log.events.filter((e) => e.type === "kickoff" && e.detail === "goal_kick").length,
    home: stats.home,
    away: stats.away,
    lastHash: log.tickSnapshots[log.tickSnapshots.length - 1]?.hash,
  };
  return { path, statsPath, summary };
}

// Node 22+ 에서 직접 실행되면 파일을 생성.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { path, summary } = writeDemo();
  // eslint-disable-next-line no-console
  console.log(`[generate-demo] wrote ${path}\n${JSON.stringify(summary, null, 2)}`);
}
