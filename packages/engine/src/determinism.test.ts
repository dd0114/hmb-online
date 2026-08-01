import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import { atLeastTier } from "./realism/tier";

/**
 * AC3(재현성): 동일 (seed, home, away, select, config) 로 runMatch 를 N회 돌리면
 * 모든 finalScore + 마지막 tick hash + 이벤트 수가 완전히 동일해야 한다(desync 0).
 *
 * ⚠️ **결정론은 어느 티어에서도 면제가 없다**(#377 P v1). 티어가 정하는 것은 "성질을 보는가"가
 * 아니라 **반복 횟수**뿐이다 — T0(매 커밋)은 축약 반복으로 같은 성질을 확인하고, T1 이상에서
 * 80회 전량을 돈다(그 80회가 T0 예산 1분의 1/3 을 혼자 먹는다). 틱별 해시 동일성·시드 민감도는
 * **항상** 돈다.
 */

const N = atLeastTier(1) ? 80 : 8;

function summarize(seed = demoSeed) {
  const log = runMatch(seed, demoHome, demoAway, demoSelect);
  const last = log.tickSnapshots[log.tickSnapshots.length - 1]!;
  return {
    score: log.finalScore,
    events: log.events.length,
    goals: log.events.filter((e) => e.type === "goal").length,
    ticks: log.tickSnapshots.length,
    lastHash: last.hash,
    // 전 구간 해시를 하나로 접어 desync 를 강하게 검출.
    hashChain: log.tickSnapshots.map((s) => s.hash).join("").length,
    firstHash: log.tickSnapshots[0]!.hash,
  };
}

describe("determinism (AC3)", () => {
  it(`reproduces identical result across ${N} runs (desync 0)`, () => {
    const ref = summarize();
    for (let i = 0; i < N; i++) {
      expect(summarize()).toEqual(ref);
    }
  });

  it("every tick hash is stable between two runs", () => {
    const a = runMatch(demoSeed, demoHome, demoAway, demoSelect);
    const b = runMatch(demoSeed, demoHome, demoAway, demoSelect);
    expect(a.tickSnapshots.length).toBe(b.tickSnapshots.length);
    for (let i = 0; i < a.tickSnapshots.length; i++) {
      expect(a.tickSnapshots[i]!.hash).toBe(b.tickSnapshots[i]!.hash);
    }
    expect(a.finalScore).toEqual(b.finalScore);
  });

  it("different seed diverges (hash sensitivity)", () => {
    const a = runMatch(demoSeed, demoHome, demoAway, demoSelect);
    const b = runMatch("9999999999", demoHome, demoAway, demoSelect);
    const aLast = a.tickSnapshots[a.tickSnapshots.length - 1]!.hash;
    const bLast = b.tickSnapshots[b.tickSnapshots.length - 1]!.hash;
    expect(aLast).not.toBe(bLast);
  });

  it("golden summary snapshot (score + event count + final hash)", () => {
    expect(summarize()).toMatchSnapshot();
  });
});
