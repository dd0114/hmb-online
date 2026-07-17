import { describe, it, expect } from "vitest";
import { runMatch, demoSeed, demoHome, demoAway, demoSelect } from "@hmb/engine";
import { SimulateRequest, SimulateResponse } from "@hmb/shared";
import { simulate } from "./simulate.js";

/**
 * AC-T1: /simulate 왕복이 zod 계약 파싱 통과. 같은 요청 2회 → 동일 MatchLog(결정론).
 * + half1/half2(resume) 합쳐서 엔진의 통짜 runMatch 와 완전히 동일(engine resume.test.ts 와 같은 기법).
 */

function req1(): SimulateRequest {
  return {
    seed: demoSeed,
    selectData: demoSelect,
    homeInput: demoHome,
    awayInput: demoAway,
    half: 1,
  };
}

describe("runner simulate — determinism (AC-T1)", () => {
  it("half=1: same request twice → deep-equal response", () => {
    const a = simulate(req1());
    const b = simulate(req1());
    expect(a).toEqual(b);
  });

  it("half=2 with resumeState: same request twice → deep-equal response", () => {
    const h1 = simulate(req1());
    const req2 = (): SimulateRequest => ({
      seed: demoSeed,
      selectData: demoSelect,
      homeInput: demoHome,
      awayInput: demoAway,
      half: 2,
      resumeState: h1.resumeState,
    });
    const a = simulate(req2());
    const b = simulate(req2());
    expect(a).toEqual(b);
  });

  it("half=2 without resumeState (substitution fallback): same request twice → deep-equal response", () => {
    const req = (): SimulateRequest => ({
      seed: demoSeed,
      selectData: demoSelect,
      homeInput: demoHome,
      awayInput: demoAway,
      half: 2,
    });
    const a = simulate(req());
    const b = simulate(req());
    expect(a).toEqual(b);
  });

  it("half1 + half2(resume) reproduces engine's own whole-match runMatch reference", () => {
    const whole = runMatch(demoSeed, demoHome, demoAway, demoSelect);

    const h1 = simulate(req1());
    const h2 = simulate({
      seed: demoSeed,
      selectData: demoSelect,
      homeInput: demoHome,
      awayInput: demoAway,
      half: 2,
      resumeState: h1.resumeState,
    });

    // half1 이 이어받을 상태를 만들고, half2 는 그 상태를 승계한다 — 두 응답을 이어붙이면
    // 통짜 90분과 완전히 동일해야 한다(승계 재개 결정론).
    const combinedTicks = [...h1.matchLog.tickSnapshots, ...h2.matchLog.tickSnapshots];
    expect(combinedTicks.length).toBe(whole.tickSnapshots.length);
    for (let i = 0; i < whole.tickSnapshots.length; i++) {
      expect(combinedTicks[i]!.hash).toBe(whole.tickSnapshots[i]!.hash);
    }

    const combinedEvents = [...h1.matchLog.events, ...h2.matchLog.events];
    expect(combinedEvents).toEqual(whole.events);

    // 각 half 응답의 finalScore 는 "그 half 동안" 만의 득점(서버가 합산하는 몫) — 합치면 통짜와 동일.
    expect({
      home: h1.matchLog.finalScore.home + h2.matchLog.finalScore.home,
      away: h1.matchLog.finalScore.away + h2.matchLog.finalScore.away,
    }).toEqual(whole.finalScore);

    // half=2 응답은 매치가 끝났으므로 더 이상 이어갈 resumeState 가 없다.
    expect(h2.resumeState).toBeUndefined();

    // lastHash = 각 응답 matchLog 마지막 틱 해시.
    expect(h1.lastHash).toBe(h1.matchLog.tickSnapshots[h1.matchLog.tickSnapshots.length - 1]!.hash);
    expect(h2.lastHash).toBe(h2.matchLog.tickSnapshots[h2.matchLog.tickSnapshots.length - 1]!.hash);
  });

  it("zod round-trip: request and response survive JSON stringify/parse under the shared contract", () => {
    const request = req1();
    const parsedReq = SimulateRequest.parse(JSON.parse(JSON.stringify(request)));
    expect(parsedReq).toEqual(request);

    const response = simulate(request);
    const parsedRes = SimulateResponse.parse(JSON.parse(JSON.stringify(response)));
    expect(parsedRes).toEqual(JSON.parse(JSON.stringify(response)));
    // resumeState (opaque) 도 JSON 왕복 후 그대로 재사용 가능해야 half=2 재개가 성립.
    expect(parsedRes.resumeState).toEqual(JSON.parse(JSON.stringify(response.resumeState)));
  });

  it("malformed SimulateRequest is rejected by the zod contract", () => {
    const bad = { seed: "42", half: 3 }; // half 밖 selectData/inputs 누락 + half 값 범위 밖
    const parsed = SimulateRequest.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("half=2 with a malformed resumeState throws (runner-main maps this to 400)", () => {
    expect(() =>
      simulate({
        seed: demoSeed,
        selectData: demoSelect,
        homeInput: demoHome,
        awayInput: demoAway,
        half: 2,
        resumeState: { not: "a real carry" },
      }),
    ).toThrow();
  });
});
