import { describe, it, expect } from "vitest";
import { runMatch, runFirstHalf, resumeSecondHalf } from "./match";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";

/**
 * 하프타임 분할 재개가 "통짜 90분"과 완전히 동일함을 검증.
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
    // 90분/1초틱 = 5400, 전반 = 2700 틱(0..2699).
    expect(carry.snapshots.length).toBe(2700);
    expect(carry.nextTick).toBe(2700);
    // half_whistle 이벤트가 존재.
    expect(carry.events.some((e) => e.type === "half_whistle")).toBe(true);
    // full_whistle 은 아직 없음.
    expect(carry.events.some((e) => e.type === "full_whistle")).toBe(false);
  });
});
