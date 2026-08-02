import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { writeDemo } from "./generate-demo";
import { defaultEngineConfig } from "../src/config";
import type { MatchLog } from "@hmb/shared";

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

  /**
   * 쇼케이스 데모가 **희귀 연출을 잃지 않았는가** — e2e(`shot-outcomes.spec.ts`)가 이 로그의
   * `shot:one_on_one` 에 의존한다.
   *
   * ⚠️ 왜 여기서 거나: #377 M1-pre 에서 이 로그의 1대1 이 1건 → 0건으로 사라지며 e2e 가
   * 빨개졌는데, 실패 지점이 브라우저 스펙이라 원인이 **엔진 전개 변화**라는 게 안 보였다
   * (실제로 "base 도 red"라고 잘못 귀속했고 독립검증이 정정했다). 생성 시점에 걸면 다음 세션은
   * **여기서** 이유와 처방을 함께 본다.
   *
   * 1대1 빈도는 경기당 0.5~1건(#316 잔여)이라 **여유가 얇다** — 0 이 되면 시드 재선정이 처방이고,
   * 근본은 #316(빈도 자체를 올리는 것)이다.
   */
  it("쇼케이스 데모에 e2e 가 의존하는 이벤트가 전부 남아 있다", () => {
    // ⚠️ 초판은 `shot:one_on_one` **하나만** 봤다. 그러다 #377 M3-A 에서 이번엔 `tackle` 이
    // 0 이 되며 `log.spec.ts`(티어 렌더)가 브라우저에서 빨개졌다 — **같은 부류가 두 번째**다.
    // 하나씩 추가하는 대신 **e2e 가 의존하는 타입 전체**를 여기서 건다. 처방은 언제나 같다:
    // `generate-demo.ts` 의 SHOWCASE_SEED 재선정(네 축 모두 있는 시드).
    const { path } = writeDemo();
    const log = JSON.parse(readFileSync(path, "utf8")) as MatchLog;
    const count = (f: (e: MatchLog["events"][number]) => boolean) => log.events.filter(f).length;
    const need: [string, number, string][] = [
      ["shot:one_on_one", count((e) => e.type === "shot" && e.detail === "one_on_one"), "shot-outcomes.spec.ts"],
      ["tackle", count((e) => e.type === "tackle"), "log.spec.ts(티어 렌더)"],
      ["card", count((e) => e.type === "card"), "log.spec.ts(major 티어)"],
      ["goal", count((e) => e.type === "goal"), "captions/goal 연출 + perceptibility 골 빈도"],
    ];
    for (const [name, n, who] of need) {
      expect(
        n,
        `쇼케이스 데모에서 ${name} 이 사라졌다 → ${who} 가 빨개진다. ` +
          "처방: generate-demo.ts 의 SHOWCASE_SEED 재선정(의존 타입 전부 있는 시드).",
      ).toBeGreaterThan(0);
    }
  });
});
