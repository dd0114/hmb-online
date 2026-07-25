import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMatch } from "../../src/match";
import { defaultEngineConfig } from "../../src/config";
import { demoSelect, makeTacticalInput } from "../../src/fixtures";

// e2e 보조 픽스처 생성기.
// 쇼케이스 데모(match-log.json)엔 시드/튜닝에 따라 offside·card·penalty 같은 희귀 이벤트가
// 없을 수 있다. 이 시드(real config)는 셋 다 포함하므로, 그 타입 계약검증용 풀해상도 로그를
// e2e/fixture-real.json 으로 만든다. (생성물은 gitignore.)
const here = dirname(fileURLToPath(import.meta.url));
<<<<<<< HEAD
const SEED = "1000000076"; // real config 에서 offside+card+penalty + #42(세이브→라이브체인→빗나감) 패턴을 모두 포함하는 시드. 매치 전개가 바뀔 때마다 **네 조건 전부**로 재스캔한다(1000000000 → 1000000004 → 1000000013 → 1000000076, #181 공 도착/아웃 판정 수정으로 타임라인 변경). ⚠️ #42 는 **체인 스팬**(save→off_target 틱 간격)도 짧아야 한다 — e2e 가 그 구간을 실제 재생으로 통과하므로 스팬이 길면 타임아웃한다(1000000015 는 span41 로 실패). 스캔 결과(스팬): 1000000076:6 · 1000000101:10 · 1000000016:16 · 1000000030:22.
=======
const SEED = "1000000018"; // real config 에서 offside+card+penalty + #42(세이브→라이브체인→빗나감) 패턴을 모두 포함하는 시드. 매치 전개가 바뀔 때마다 **네 조건 전부**로 재스캔한다(1000000000 → 1000000004 → 1000000013 → 1000000018, #182 코너 rest defence 로 타임라인 변경). 스캔 결과 보유 시드: 1000000018/37/56/81/90/93.
>>>>>>> 8f4e7f1 ([Spider] test(engine): #182 골든 갱신 + 시드 핀 재스캔 + 가드 표본 40시드 (#182))

describe("e2e fixtures", () => {
  it("writes fixture-real.json containing offside + card + penalty events", () => {
    const log = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), demoSelect, defaultEngineConfig);
    // 이 계약검증이 의미가 있으려면 real 데모에 세 희귀 타입이 실제로 있어야 한다.
    expect(log.events.some((e) => e.type === "offside")).toBe(true);
    expect(log.events.some((e) => e.type === "card")).toBe(true);
    expect(log.events.some((e) => e.type === "penalty")).toBe(true);
    writeFileSync(join(here, "fixture-real.json"), JSON.stringify(log));
  });
});
