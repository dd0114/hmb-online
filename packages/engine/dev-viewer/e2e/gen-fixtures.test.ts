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
const SEED = "1000000186";
// ⚠️ 매치 전개가 바뀌면 **아래 5조건 전부**로 재스캔한다(gameqa 체크리스트, #186 이 스캐너 체크인 소유):
//   ①offside ≥1  ②card ≥1  ③penalty ≥1  ④#42 패턴(세이브→라이브체인→빗나감) 포함
//   ⑤**그 체인의 스팬이 짧을 것** — ④만 맞고 스팬이 길면 e2e 가 그 구간을 실제 재생하다 타임아웃한다
//     (#181 실측: 1000000015 는 span41 로 실패). ⑤가 가장 빠뜨리기 쉽다.
// 이력: 1000000000 → …004 → …013 → …076(#181) → …016(#182) → …137(#176 데드볼 규칙)
//   → …031(#230 데드볼 GK 이탈 픽스 — 정지 중 배치가 바뀌며 …137 의 ④체인이 소멸)
//   → …099(#279 사슬 코어 채택 engine@0.24.0 — 코어 교체로 매치 전개가 통째로 바뀌며
//     …031 의 ④체인이 소멸: restarts.spec.ts:95 가 "체인 없음"으로 실패했다).
//   → **…001**(#307 프리킥 벽/백업 + 데드볼 도착 페이싱 — 데드볼 배치·정지 길이가 바뀌며
//     …099 에서 penalty 가 소멸: 이 파일의 ③단언이 실패했다).
//   재스캔(--count 200 --max-span 20) 결과 후보(스팬): **1000000001:12** · …038:18 · …054:18 ·
//   …082:18 · …024:20 · …075:20 · …138:20.
//   → **…237**(engine@0.25.0 볼륨 재보정 — 공 물리 3건 + 데드볼 2건 + config 재보정으로 매치
//     전개가 통째로 바뀌며 …001 의 ①offside/②card/③penalty 조합이 소멸).
//   재스캔 실측(스캐너 그대로, `--count 300` + `--from 1000000300 --count 500`, 총 800시드):
//     후보 **단 1개 = 1000000237(스팬 17틱, save@1942)** — 백업 시드가 없다.
//   → **…186**(engine@0.26.0 = #320 공 물리 속도벡터 재작성 + 볼륨 재보정 gv 24→11 ·
//     xgBase 0.42→0.35 — 목표점 보간을 걷어내며 매치 전개가 통째로 바뀌어 …237 의 ③penalty 가
//     소멸). 재스캔 `--count 300 --max-span 20` 후보 **9개**(스팬): **1000000186:6** · …167:9 ·
//     …240:16 · …006:17 · …224:17 · …149:18 · …227:19 · …114:20 · …154:20 — 백업이 넉넉해졌다.
// ℹ️ 위 "후보가 희소하다"는 경고는 **0.25.0 한정**이었고 #320 에서 해소됐다: 속도 기반에서
//    공 소유 틱이 회복되며 태클 시도가 늘어 파울/PK 가 함께 돌아왔다(`foul.base` 는 태클 시도당
//    확률이라 자동으로 따라 올라간다 — 0.25.0 에서 내려간 것과 정확히 같은 경로).
// ⚠️ 이 시드들 중 `shot:one_on_one` 을 가진 것은 **하나도 없다** — chain 코어가 one_on_one
//    판정 자체를 갖고 있지 않기 때문이다(decision.ts 에만 있고 chain.ts 에는 없다).
//    상세는 shot-outcomes.spec.ts 의 test.fail 주석.

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
