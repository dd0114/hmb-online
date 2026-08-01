import { describe, it, expect } from "vitest";
import { demoSeed, demoHome, demoAway, demoSelect } from "@hmb/engine";
import { SimulateRequest } from "@hmb/shared";
import { simulate } from "./simulate.js";

/**
 * #383 W1 — `configOverrides` 를 **시뮬 경로 전체**에 대해 거는 계약 (T-R1·R2·R4·R5·R6).
 *
 * 가장 중요한 것은 T-R1(등가)이다: 이 기능이 켜져 있어도 **아무도 오버레이를 안 보내면**
 * 오늘 배포와 한 비트도 다르지 않아야 한다. 그게 성립해야 W1 을 W2/W3 과 독립적으로 머지할 수 있다.
 */

const base = { seed: demoSeed, selectData: demoSelect, homeInput: demoHome, awayInput: demoAway } as const;

const h1 = (configOverrides?: Record<string, number | boolean>): SimulateRequest =>
  configOverrides === undefined ? { ...base, half: 1 } : { ...base, half: 1, configOverrides };

/** 오버레이가 실제로 경기를 바꾸는 노브 — "선언만 하고 미소비"를 잡으려면 살아 있는 노브여야 한다. */
const LIVE_KNOB = { "contest.shootRange": 40 } as const;

describe("T-R1 등가 — 오버레이 없음 == {} == undefined (현행 bit-identical)", () => {
  it("half=1: 세 형태의 응답이 완전히 동일", () => {
    const absent = simulate({ ...base, half: 1 });
    const undef = simulate({ ...base, half: 1, configOverrides: undefined });
    const empty = simulate({ ...base, half: 1, configOverrides: {} });

    expect(undef.lastHash).toBe(absent.lastHash);
    expect(empty.lastHash).toBe(absent.lastHash);
    expect(undef.matchLog).toEqual(absent.matchLog);
    expect(empty.matchLog).toEqual(absent.matchLog);
    expect(empty.resumeState).toEqual(absent.resumeState);
  });

  it("half=2 승계까지 동일 — 재개 경로에도 회귀가 없다", () => {
    const run = (overrides?: Record<string, number | boolean>) => {
      const a = simulate(h1(overrides));
      const b = simulate(
        overrides === undefined
          ? { ...base, half: 2, resumeState: a.resumeState }
          : { ...base, half: 2, resumeState: a.resumeState, configOverrides: overrides },
      );
      return b;
    };
    expect(run({}).lastHash).toBe(run(undefined).lastHash);
    expect(run({}).matchLog).toEqual(run(undefined).matchLog);
  });
});

describe("T-R2 주입이 실제로 먹는다 (죽은 노브 금지)", () => {
  it("살아 있는 노브를 바꾸면 lastHash 가 달라진다", () => {
    const plain = simulate(h1());
    const tuned = simulate(h1(LIVE_KNOB));
    expect(tuned.lastHash).not.toBe(plain.lastHash);
  });

  it("오버레이도 결정론이다 — 같은 오버레이 두 번 = 같은 응답", () => {
    expect(simulate(h1(LIVE_KNOB))).toEqual(simulate(h1(LIVE_KNOB)));
  });

  it("응답에 유효 config 지문이 실린다(무오버레이와 다르다)", () => {
    const plain = simulate(h1());
    const tuned = simulate(h1(LIVE_KNOB));
    expect(plain.effectiveConfigHash).toBeTypeOf("string");
    expect(tuned.effectiveConfigHash).not.toBe(plain.effectiveConfigHash);
  });
});

describe("T-R4 오버레이 왕복 재개 동일성", () => {
  it("오버레이 X 로 h1→h2 분할 == 오버레이 X 로 돌린 매치 전체", () => {
    const a = simulate(h1(LIVE_KNOB));
    const b = simulate({ ...base, half: 2, resumeState: a.resumeState, configOverrides: LIVE_KNOB });

    // 두 번 돌려도 같은 곳에 도착한다(승계 결정론) + 후반이 실제로 진행됐다.
    const a2 = simulate(h1(LIVE_KNOB));
    const b2 = simulate({ ...base, half: 2, resumeState: a2.resumeState, configOverrides: LIVE_KNOB });
    expect(b2.lastHash).toBe(b.lastHash);
    expect(b.matchLog.tickSnapshots.length).toBeGreaterThan(0);
  });
});

describe("T-R5/T-R6 재개 config 가드 — 무음 desync 금지 · 구 상태 통과", () => {
  it("h1 과 다른 오버레이로 h2 를 재개하면 **throw**(조용히 갈라지지 않는다)", () => {
    const a = simulate(h1(LIVE_KNOB));
    expect(() =>
      simulate({ ...base, half: 2, resumeState: a.resumeState, configOverrides: { "contest.shootRange": 12 } }),
    ).toThrow(/config/i);
  });

  it("오버레이로 만든 상태를 **오버레이 없이** 재개해도 throw", () => {
    const a = simulate(h1(LIVE_KNOB));
    expect(() => simulate({ ...base, half: 2, resumeState: a.resumeState })).toThrow(/config/i);
  });

  it("T-R6: `configHash` 가 **없는 구 resumeState** 는 그대로 통과한다 (#241 재발 방지)", () => {
    const a = simulate(h1());
    const legacy = { ...(a.resumeState as Record<string, unknown>) };
    delete legacy["configHash"];
    expect(() => simulate({ ...base, half: 2, resumeState: legacy })).not.toThrow();
  });

  it("구 resumeState 재개 결과는 가드 이전과 동일하다(가드가 동작을 바꾸지 않는다)", () => {
    const a = simulate(h1());
    const withHash = simulate({ ...base, half: 2, resumeState: a.resumeState });
    const legacy = { ...(a.resumeState as Record<string, unknown>) };
    delete legacy["configHash"];
    const withoutHash = simulate({ ...base, half: 2, resumeState: legacy });
    expect(withoutHash.lastHash).toBe(withHash.lastHash);
  });
});

/**
 * B3 — **`simulate` 는 미지 경로로 죽지 않는다.** 이 자리엔 원래 "미지 경로는 throw" 계약이
 * 있었고, 그게 정확히 blocker 였다: `simulate` 를 부르는 것은 운영자가 아니라 **이미 시작한
 * 매치**다. 엔진이 노브를 지운 뒤 그 오버레이가 박힌 매치가 h1 을 돌리면 러너 400 →
 * `failMatch` → 매치 FAILED 이고, 원장의 현재 리비전이 그 키를 든 한 신규 매치도 전부 같은
 * 길로 간다. 거절은 작성 게이트가 한다(`config-http.test.ts` 의 `/config/validate` 400).
 */
describe("B3 — simulate(재생)은 미지 경로에 죽지 않고 버린다", () => {
  it("미지 경로가 박혀 있어도 하프가 정상 산출된다 + 버린 사실이 응답에 실린다", () => {
    const res = simulate(h1({ "contest.nopeNope": 1 }));
    expect(res.matchLog.tickSnapshots.length).toBeGreaterThan(0);
    expect(res.droppedOverrides?.map((d) => d.path)).toEqual(["contest.nopeNope"]);
  });

  it("그 하프는 오버레이 없이 돈 하프와 **비트 동일**하다 — 버린 값이 몰래 새지 않는다", () => {
    expect(simulate(h1({ "contest.nopeNope": 1 })).lastHash).toBe(simulate(h1()).lastHash);
  });

  it("런타임 비용 상한은 재생에서도 여전히 throw 다 — 성질이 다른 유일한 게이트", () => {
    expect(() => simulate(h1({ matchMinutes: 100000 }))).toThrow(/단일 프로세스/);
  });
});
