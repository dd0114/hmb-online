import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../src/match";
import { defaultEngineConfig } from "../src/config";
import { demoSeed, demoHome, demoAway, demoSelect } from "../src/fixtures";

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

/** 데모 MatchLog 생성. */
export function buildDemoLog(): MatchLog {
  return runMatch(demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig);
}

/** MatchLog 를 dev-viewer/match-log.json 으로 저장하고 요약을 반환. */
export function writeDemo(outPath?: string): { path: string; summary: Record<string, unknown> } {
  const log = buildDemoLog();
  const here = dirname(fileURLToPath(import.meta.url));
  const path = outPath ?? join(here, "match-log.json");
  writeFileSync(path, JSON.stringify(log));
  const summary = {
    configVersion: log.configVersion,
    seed: log.seed,
    ticks: log.tickSnapshots.length,
    finalScore: log.finalScore,
    events: log.events.length,
    goals: log.events.filter((e) => e.type === "goal").length,
    shots: log.events.filter((e) => e.type === "shot").length,
    lastHash: log.tickSnapshots[log.tickSnapshots.length - 1]?.hash,
  };
  return { path, summary };
}

// Node 22+ 에서 직접 실행되면 파일을 생성.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { path, summary } = writeDemo();
  // eslint-disable-next-line no-console
  console.log(`[generate-demo] wrote ${path}\n${JSON.stringify(summary, null, 2)}`);
}
