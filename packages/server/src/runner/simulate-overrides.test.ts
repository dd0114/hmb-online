import { describe, it, expect } from "vitest";
import { demoSeed, demoHome, demoAway, demoSelect, defaultEngineConfig } from "@hmb/engine";
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

/** resumeState 안의 오버레이 지문 필드명 — 계약이 실제 이름을 참조하게 해 개명에 깨지게 한다. */
const RESUME_HASH_FIELD = "overridesHash";

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

  /**
   * 구 러너(= 지금 라이브)가 만든 resumeState 를 흉내낸다.
   *
   * ⚠️ **전제를 먼저 단언한다.** 이 계약은 한 번 통째로 공허했다(독립검증 5차 blocker): B4 가
   * 필드를 `configHash` → `overridesHash` 로 개명했는데 여기 `delete` 는 옛 이름을 지우고 있었다.
   * 없는 키를 지우는 것은 no-op 이라 **가드를 필수로 굳혀도 405/405 가 통과했다** — 즉
   * "#241 재발 방지의 마지막 조각"을 지키는 것이 아무것도 없었다. 키 이름이 다시 바뀌면
   * **여기서 먼저 깨지게** 만든다.
   */
  const legacyResumeState = (resumeState: unknown): Record<string, unknown> => {
    const copy = { ...(resumeState as Record<string, unknown>) };
    expect(RESUME_HASH_FIELD in copy, `resumeState 에 ${RESUME_HASH_FIELD} 가 없다 — 필드가 개명됐으면 ` +
      `이 계약도 같이 고쳐야 한다(안 고치면 아무것도 안 지운 채 통과한다)`).toBe(true);
    delete copy[RESUME_HASH_FIELD];
    return copy;
  };

  it("T-R6: 지문이 **없는 구 resumeState** 는 그대로 통과한다 (#241 재발 방지)", () => {
    // 이 브랜치가 배포되는 순간 비행 중인 매치의 resumeState 에는 이 키가 없다. 필수로 굳으면
    // 배포 그 자체가 진행 중 매치를 전부 FAILED 로 민다 = 이 웨이브가 막겠다는 사건.
    const a = simulate(h1());
    expect(() => simulate({ ...base, half: 2, resumeState: legacyResumeState(a.resumeState) })).not.toThrow();
  });

  it("구 resumeState 재개 결과는 가드 이전과 동일하다(가드가 동작을 바꾸지 않는다)", () => {
    const a = simulate(h1());
    const withHash = simulate({ ...base, half: 2, resumeState: a.resumeState });
    const withoutHash = simulate({ ...base, half: 2, resumeState: legacyResumeState(a.resumeState) });
    expect(withoutHash.lastHash).toBe(withHash.lastHash);
  });
});

/**
 * **B4 — 오버레이를 안 쓰는 매치는 러너 재배포를 넘어서도 죽지 않는다.**
 *
 * 초판의 재개 가드는 <b>병합된 config 전체</b>의 지문을 무조건 싣고 무조건 대조했다. 그래서
 * 러너 이미지가 재배포되며 기본 `EngineConfig` 가 한 글자라도 달라지고 `config.version` 이 안 오르면
 * (무효 노브 하나를 지우는 배포가 정확히 그렇다 — 경기가 bit-identical 이라 범프 사유가 없다)
 * <b>오버레이를 한 번도 쓴 적 없는</b> 진행 중 매치가 h2 에서 전부 죽었다. 이 웨이브가 최우선
 * 계약으로 내건 "아무도 안 보내면 오늘과 bit-identical"이 재배포 경계에서 거짓이 되고, 폭발 반경이
 * 이 기능 사용자가 아니라 <b>전 유저</b>인 형태다.
 *
 * 가드가 물어야 하는 것은 하나다 — <b>h2 가 h1 과 같은 오버레이를 받았는가.</b>
 */
describe("B4 — 재개 가드는 **오버레이**를 비교한다(병합 config 전체가 아니라)", () => {
  /** 러너 재배포 흉내: 경기는 그대로인데(INERT 노브) 유효 config 지문만 달라진다. */
  const redeployed = {
    ...defaultEngineConfig,
    decisionWeights: { ...defaultEngineConfig.decisionWeights, shoot: 0.999 },
  };

  it("오버레이 0건 매치는 러너 기본값이 달라져도 h2 가 산다", () => {
    const a = simulate({ ...base, half: 1 });
    expect(() =>
      simulate({ ...base, half: 2, resumeState: a.resumeState }, redeployed),
    ).not.toThrow();
  });

  it("`config.version` 이 오르면 여전히 거부한다 — 진짜 동작 변경의 축은 그대로다", () => {
    const a = simulate({ ...base, half: 1 });
    const bumped = { ...defaultEngineConfig, version: `${defaultEngineConfig.version}-next` };
    expect(() => simulate({ ...base, half: 2, resumeState: a.resumeState }, bumped))
      .toThrow(/version mismatch/);
  });

  it("오버레이를 쓴 매치도 재배포를 넘어서 산다 — 같은 오버레이면 같은 매치다", () => {
    const a = simulate(h1(LIVE_KNOB));
    expect(() =>
      simulate({ ...base, half: 2, resumeState: a.resumeState, configOverrides: LIVE_KNOB }, redeployed),
    ).not.toThrow();
  });

  it("그런데 **오버레이가 달라지면 여전히 죽는다** — 가드가 무르지 않았다", () => {
    const a = simulate(h1(LIVE_KNOB));
    expect(() =>
      simulate({ ...base, half: 2, resumeState: a.resumeState, configOverrides: { "contest.shootRange": 12 } }),
    ).toThrow(/overrides mismatch/);
    expect(() => simulate({ ...base, half: 2, resumeState: a.resumeState })).toThrow(/overrides mismatch/);
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

  it("**재생에는 throw 가 하나도 남지 않았다** — 비용 상한마저 버린다(M-A)", () => {
    // 이 자리엔 "비용 상한은 재생에서도 throw" 계약이 있었다. 그 근거("답이 시간에 따라 안 바뀐다")가
    // 거짓이라 M-A 로 뒤집혔다 — 상한은 `msPerTick`(구조값, 배포로 바뀐다)에 달려 있다.
    const res = simulate(h1({ matchMinutes: 100000 }));
    expect(res.matchLog.tickSnapshots.length).toBeGreaterThan(0);
    expect(res.droppedOverrides?.map((d) => d.path)).toEqual(["matchMinutes"]);
    // 버린 뒤엔 base 값으로 돈다 = 러너를 재우는 위험은 그대로 막혔다.
    expect(res.lastHash).toBe(simulate(h1()).lastHash);
  });
});
