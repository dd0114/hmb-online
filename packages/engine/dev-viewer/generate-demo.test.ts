import { describe, it, expect } from "vitest";
import { writeDemo } from "./generate-demo";

/**
 * 데모 생성기(및 뷰어 입력 파일) 산출 검증.
 * 이 테스트가 dev-viewer/match-log.json 을 (재)생성한다 — Node 20 에서 동작.
 */
describe("dev-viewer demo generation", () => {
  it("writes match-log.json with a full match", () => {
    const { path, summary } = writeDemo();
    // eslint-disable-next-line no-console
    console.log(`[generate-demo] wrote ${path} ${JSON.stringify(summary)}`);
    expect(summary.ticks).toBeGreaterThan(5000);
    expect(typeof summary.lastHash).toBe("string");
    expect(path.endsWith("match-log.json")).toBe(true);
  });
});
