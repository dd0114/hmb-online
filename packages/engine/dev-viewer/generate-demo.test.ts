import { describe, it, expect } from "vitest";
import { writeDemo } from "./generate-demo";
import { defaultEngineConfig } from "../src/config";

/**
 * 데모 생성기(및 뷰어 입력 파일) 산출 검증.
 * 이 테스트가 dev-viewer/match-log.json 을 (재)생성한다 — Node 20 에서 동작.
 */
describe("dev-viewer demo generation", () => {
  it("writes match-log.json with a full match", () => {
    const { path, summary } = writeDemo();
    // eslint-disable-next-line no-console
    console.log(`[generate-demo] wrote ${path} ${JSON.stringify(summary)}`);
    // summary 는 **리얼 config** 매치(벤치 대조용)라 총 틱은 config 에서 유도한다 —
    // #365 로 경기 길이가 노브가 됐다(90 → 45분). 상수로 박으면 길이를 바꾼 날 이 단언만 옛 값을 말한다.
    const realTicks = Math.round((defaultEngineConfig.matchMinutes * 60_000) / defaultEngineConfig.msPerTick);
    expect(summary.ticks).toBe(realTicks);
    expect(typeof summary.lastHash).toBe("string");
    expect(path.endsWith("match-log.json")).toBe(true);
  });
});
