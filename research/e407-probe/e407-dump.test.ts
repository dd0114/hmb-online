import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

/** E407 ④ 실화면 캡처용 MatchLog 덤프(분석 전용). */
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "research", "e407-capture");

describe("E407 ④ 캡처용 로그 덤프", () => {
  it("worst 표본 시드 로그를 research/e407-capture 에 쓴다", () => {
    mkdirSync(outDir, { recursive: true });
    for (const seed of ["27182818", "2718281828"]) {
      const log = runMatch(
        seed,
        makeTacticalInput("H", seed),
        makeTacticalInput("A", seed),
        makeSelectData(),
        defaultEngineConfig,
      );
      writeFileSync(join(outDir, `log-${seed}.json`), JSON.stringify(log));
    }
    expect(true).toBe(true);
  }, 120000);
});
