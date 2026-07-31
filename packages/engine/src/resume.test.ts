import { describe, it, expect } from "vitest";
import { runMatch, runFirstHalf, resumeSecondHalf } from "./match";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import { defaultEngineConfig } from "./config";

/**
 * 하프타임 분할 재개가 "통짜 한 경기"와 완전히 동일함을 검증.
 * delta 를 전반과 동일 입력으로 주면(=전술 무변경) 시드·좌표·스코어·RNG 연속성에 의해
 * 모든 틱 해시와 이벤트가 monolithic 과 일치해야 한다.
 */

describe("halftime resume equals monolithic (AC: resume)", () => {
  it("split first/second half reproduces the whole-match log", () => {
    const whole = runMatch(demoSeed, demoHome, demoAway, demoSelect);

    const carry = runFirstHalf(demoSeed, demoHome, demoAway, demoSelect);
    const split = resumeSecondHalf(carry, demoHome, demoAway);

    expect(split.finalScore).toEqual(whole.finalScore);
    expect(split.tickSnapshots.length).toBe(whole.tickSnapshots.length);

    for (let i = 0; i < whole.tickSnapshots.length; i++) {
      expect(split.tickSnapshots[i]!.hash).toBe(whole.tickSnapshots[i]!.hash);
    }

    expect(split.events).toEqual(whole.events);
  });

  it("first half ends at the half mark and carries live RNG state", () => {
    const carry = runFirstHalf(demoSeed, demoHome, demoAway, demoSelect);
    // 하프 마크는 config 에서 유도한다 — #365 로 경기 길이가 노브가 됐다(90 → 45분, 하프 2700 → 1350).
    // 상수로 박으면 길이를 바꾼 날 "재개가 하프에서 갈라진다"는 계약이 아니라 옛 숫자를 주장한다.
    const half = Math.round((defaultEngineConfig.matchMinutes * 60_000) / defaultEngineConfig.msPerTick / 2);
    expect(carry.snapshots.length).toBe(half);
    expect(carry.nextTick).toBe(half);
    // half_whistle 이벤트가 존재.
    expect(carry.events.some((e) => e.type === "half_whistle")).toBe(true);
    // full_whistle 은 아직 없음.
    expect(carry.events.some((e) => e.type === "full_whistle")).toBe(false);
  });
});
