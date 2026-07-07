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
  version: "engine@0.2.0-showcase",
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
