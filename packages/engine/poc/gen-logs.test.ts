import { it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMatch } from "../src/match";
import { defaultEngineConfig } from "../src/config";
import { demoSeed, makeTacticalInput, makeSelectData } from "../src/fixtures";
import { clampTacticalInput, TacticalInput } from "@hmb/shared";

// PoC 뷰어용 로그 생성기: 코치 산출물(homeA/homeB)로 각 경기를 돌려 full MatchLog 을 저장.
// 뷰어가 window.__LOG__ 로 로드한다(build-test-viewer 로 조립).
const here = dirname(fileURLToPath(import.meta.url));
const load = (n: string) => clampTacticalInput(TacticalInput.parse(JSON.parse(readFileSync(join(here, "inputs", n), "utf8"))));

it("writes poc match-A.json / match-B.json (viewer logs)", () => {
  const select = makeSelectData();
  const away = makeTacticalInput("A", demoSeed);
  for (const [name, file] of [["homeA.json", "match-A.json"], ["homeB.json", "match-B.json"]] as const) {
    const log = runMatch(demoSeed, load(name), away, select, defaultEngineConfig);
    writeFileSync(join(here, file), JSON.stringify(log));
  }
});
