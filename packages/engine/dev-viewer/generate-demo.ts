import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../src/match";
import { defaultEngineConfig } from "../src/config";
import { demoSeed, demoHome, demoAway, demoSelect } from "../src/fixtures";
import { computeMatchStats, formatStatsReport } from "./match-stats";

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
  version: "engine@0.3.0-showcase",
  matchMinutes: 24,
  contest: {
    ...defaultEngineConfig.contest,
    xgBase: 0.5, // 0.225 → 0.5 (슛당 득점 확률↑ = 골 더 많이)
    onTargetBase: 0.42,
    shootXgThreshold: 0.05,
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
  const stats = computeMatchStats(log, demoGkIds());
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
    // 슛 킥 이벤트만(off_target/saved 결과 이벤트 제외).
    shots: log.events.filter((e) => e.type === "shot" && e.detail == null).length,
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
