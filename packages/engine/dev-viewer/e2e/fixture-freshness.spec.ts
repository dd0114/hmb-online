import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultEngineConfig } from "../../src/config";

/**
 * #188 (#189 게이트 구멍 2) — **입력 로그가 현재 엔진 것인지** 한 줄로 단언한다.
 *
 * globalSetup 이 재생성을 책임지지만, 그건 러너 밖 동작이라 리포트에 안 남는다. 이 계약이 있으면
 * "낡은 로그로 통과했다"는 상태가 **테스트 결과에 드러난다**. 노리는 건 거짓 실패가 아니라
 * **거짓 green** 이다 — 엔진이 바뀌었는데 옛 타임라인 로그엔 사례가 남아 있어 계약이 통과해버리는 것.
 *
 * 쇼케이스 로그는 `engine@X.Y.Z-showcase` 로 접미사가 붙으므로 **접두** 비교한다.
 */
const here = dirname(fileURLToPath(import.meta.url));

const LOGS = [
  { label: "showcase match-log.json", path: join(here, "..", "match-log.json") },
  { label: "real fixture-real.json", path: join(here, "fixture-real.json") },
];

for (const { label, path } of LOGS) {
  test(`e2e 입력 로그가 현재 엔진 버전이다 — ${label} (#188)`, () => {
    const log = JSON.parse(readFileSync(path, "utf8")) as { configVersion?: string };
    expect(
      log.configVersion,
      `${label} 의 configVersion 이 없다 — 생성물 포맷이 바뀌었는지 확인해라`,
    ).toBeTruthy();
    expect(
      log.configVersion!.startsWith(defaultEngineConfig.version),
      `${label} 가 낡았다: 로그 ${log.configVersion} ≠ 엔진 ${defaultEngineConfig.version}. ` +
        `낡은 로그로 계약을 검증하면 거짓 green 이 난다(globalSetup 이 재생성했어야 한다).`,
    ).toBe(true);
  });
}
