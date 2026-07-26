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
const SEED = "1000000016";
// ⚠️ 매치 전개가 바뀌면 **아래 5조건 전부**로 재스캔한다(gameqa 체크리스트, #186 이 스캐너 체크인 소유):
//   ①offside ≥1  ②card ≥1  ③penalty ≥1  ④#42 패턴(세이브→라이브체인→빗나감) 포함
//   ⑤**그 체인의 스팬이 짧을 것** — ④만 맞고 스팬이 길면 e2e 가 그 구간을 실제 재생하다 타임아웃한다
//     (#181 실측: 1000000015 는 span41 로 실패). ⑤가 가장 빠뜨리기 쉽다.
// 이력: 1000000000 → …004 → …013 → …076(#181 공 도착/아웃 판정) → **…016**(#182 코너 rest defence).
//   #182 리베이스 후 …076 은 penalty·체인이 모두 사라져 실격(직접 확인). 재스캔 결과(스팬):
//   1000000016:4 · 1000000022:4 · 1000000034:8 · 1000000111:19 · 1000000115:22 → 최단 스팬 채택.
// 재선정은 손으로 하지 말고 **스캐너**를 쓴다(#186 체크인):
//   npx tsx packages/engine/dev-viewer/e2e/scan-fixture-seed.mjs --count 200
// 위 5조건을 한 번에 재고 후보를 **스팬 짧은 순**으로 뱉는다(120시드 ≈17초 실측). ④ 판정식은
// restarts.spec.ts 와 동일하게 유지한다 — 느슨하게 잡으면 스캔은 통과인데 스펙이 깨진다.

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
