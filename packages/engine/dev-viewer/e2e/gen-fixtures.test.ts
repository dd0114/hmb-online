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
const SEED = "1000000031";
// ⚠️ 매치 전개가 바뀌면 **아래 5조건 전부**로 재스캔한다(gameqa 체크리스트, #186 이 스캐너 체크인 소유):
//   ①offside ≥1  ②card ≥1  ③penalty ≥1  ④#42 패턴(세이브→라이브체인→빗나감) 포함
//   ⑤**그 체인의 스팬이 짧을 것** — ④만 맞고 스팬이 길면 e2e 가 그 구간을 실제 재생하다 타임아웃한다
//     (#181 실측: 1000000015 는 span41 로 실패). ⑤가 가장 빠뜨리기 쉽다.
// 이력: 1000000000 → …004 → …013 → …076(#181) → …016(#182) → …137(#176 데드볼 규칙)
//   → **…031**(#230 데드볼 GK 이탈 픽스 — 정지 중 배치가 바뀌며 …137 의 ④체인이 소멸).
//   재스캔(--count 120) 결과 후보(스팬): 1000000031:3 · 1000000045:13.

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
