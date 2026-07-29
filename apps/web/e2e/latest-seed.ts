/**
 * 목 로스터가 읽을 **최신 발행 시드**를 고른다.
 *
 * ⚠️ 왜 파일명을 박지 않는가(#256 에서 실제로 물린 자리): 두 아트 스펙이 `players.v2.3.json` 을
 * 리터럴로 박고 있었는데, v2.4 가 신규 LEGEND 2종(P181 석다이크·P182 오시야스)을 채번하자
 * **새 유닛이 표본에서 조용히 빠졌다** — 스펙은 전부 green 인데 새 아트는 한 픽셀도 검증되지
 * 않는 상태. p3-unit-art 가 "표본을 `active` 로 고르지 말라"고 경고한 것과 **같은 실패모드**가
 * 한 층 위(시드 파일 핀)에서 재발한 것이다.
 *
 * 정렬은 문자열이 아니라 **버전 숫자 튜플**로 한다("v2.10" > "v2.9" 가 문자열 비교로는 거짓).
 * `viewer-skins.test.ts` 와 같은 규약이다.
 */
import { readdirSync } from "node:fs";

/** `data/players` 안에서 가장 높은 버전의 `players.v*.json` 파일명. */
export function latestSeedFile(playersDir: string): string {
  const files = readdirSync(playersDir).filter((f) => /^players\.v[\d.]+\.json$/.test(f));
  if (files.length === 0) throw new Error(`발행 시드가 없다: ${playersDir}`);
  const num = (f: string) => f.slice("players.v".length, -".json".length).split(".").map(Number);
  return files
    .sort((a, b) => {
      const [x, y] = [num(a), num(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      }
      return 0;
    })
    .pop()!;
}
