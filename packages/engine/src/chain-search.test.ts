import { describe, it, expect } from "vitest";
import { runFirstHalf, runMatch, resumeSecondHalf } from "./match";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import { defaultEngineConfig, type EngineConfig } from "./config";
import { createPitch } from "./pitch";
import { createRng } from "./rng";
import { passOptions } from "./perception";
import { ballOwnerOf, type SimState, type SimPlayer } from "./simstate";
import { decideBallOwnerChain, evaluateState } from "./chain";
import {
  EV_SCALE,
  GENERATORS,
  candidateKey,
  chainProbe,
  newChainProbe,
  setChainProbe,
  toActionCandidate,
} from "./action";

/**
 * #279 S2 — 후보 표현형 + 생성기 골격 + 노드 예산의 **계약**.
 *
 * 여기서 박제하는 것은 S5 가 매달릴 성질이다:
 *  1) 후보 표현형이 **좌표 1급 · receiver nullable** 이다(= 좌표 타깃이 표현 가능하다).
 *  2) 생성이 `GENERATORS` **고정 순서**로 돈다(= 노드 예산 컷오프가 결정론적이다).
 *  3) EV 가 **정수**다(= 동점이 정확히 동점, 부동오차가 정렬을 못 뒤집는다).
 *  4) 노드 예산이 실제로 **구속하고**, 구속해도 결정론이 유지된다.
 *  5) 계측(probe)은 **결과를 바꾸지 않는다**(관측이 상태가 되면 안 된다).
 *  6) weighted 경로는 `chain.search` 노브에 **면역**이다(골든 롤백 보장).
 */

const config = defaultEngineConfig;
const pitch = createPitch(config);

function chainCfg(patch: Partial<EngineConfig["chain"]> = {}): EngineConfig {
  return { ...config, chain: { ...config.chain, mode: "chain", ...patch } };
}

/** 공을 실제로 들고 있는 선수가 있는 상태를 얻는다(하프 진행 → 소유자 탐색). */
function stateWithOwner(): { state: SimState; owner: SimPlayer } {
  const cfg = chainCfg();
  const state = runFirstHalf(demoSeed, demoHome, demoAway, demoSelect, cfg).state;
  const owner = ballOwnerOf(state);
  if (owner) return { state, owner };
  // 소유자가 없는 틱(루즈볼)이면 임의의 필드 플레이어에게 소유를 부여해 결정 경로만 검사한다.
  const p = state.players.find((q) => !q.isGK)!;
  state.ball.owner = p.id;
  state.ball.ownerSide = p.side;
  state.ball.posFx = { ...p.posFx };
  return { state, owner: p };
}

describe("#279 S2 — 후보 표현형(action.ts)", () => {
  it("GENERATORS 순서가 계약이다 (새 생성기는 **뒤에** 추가한다)", () => {
    // 앞에 끼우면 정렬 tiebreak(candidateKey 의 첫 키 = gen)와 노드 예산 소진 순서가 통째로 밀린다.
    // #314 A 가 `clear`(걷어내기)를 그 규율대로 맨 뒤에 붙였다 — 앞 5개의 상대 순서는 불변.
    // #314 A 가 `clear` 를, #377 M3-C 가 `through`(공간 타깃 스루패스)를 규율대로 **뒤에** 붙였다.
    expect([...GENERATORS]).toEqual(["shoot", "direct", "long", "carry", "hold", "clear", "through"]);
    expect([...GENERATORS].slice(0, 5)).toEqual(["shoot", "direct", "long", "carry", "hold"]);
  });

  it("PassOption 어댑터는 좌표를 타깃으로 채우고 원본을 보존한다", () => {
    const { state, owner } = stateWithOwner();
    const opts = passOptions(state, owner, config, pitch);
    expect(opts.length).toBeGreaterThan(0);
    const speed = 18 * config.fixedScale;
    for (const o of opts) {
      const c = toActionCandidate(o, "direct", "direct", speed);
      // 좌표가 1급: 사람 타깃이면 리시버 위치와 같아야 한다.
      expect(c.toXFx).toBe(o.receiver.posFx.x);
      expect(c.toYFx).toBe(o.receiver.posFx.y);
      expect(c.receiver).toBe(o.receiver);
      // 기하 특징은 생성 시 1회 계산 — 원본 값을 손대지 않는다(평가에서 재계산 금지).
      expect(c.laneDangerFx).toBe(o.laneDanger);
      expect(c.forwardGainFx).toBe(o.forwardGain);
      expect(c.distFx).toBe(o.dist);
      expect(c.opt).toBe(o);
      // 실행 파라미터: 비행틱 = ceil(거리/공속).
      expect(c.flightTicks).toBe(Math.ceil(o.dist / speed));
      expect(c.durationTicks).toBe(c.flightTicks);
    }
  });

  it("receiver 는 nullable 이고, 좌표만 있는 후보의 정렬키가 유일하다 (S5 의 전제)", () => {
    // 좌표 타깃(receiver=null) 두 개는 receiver 키로 갈리지 않는다 — gen+좌표가 갈라야 한다.
    const base = {
      kind: "pass" as const,
      form: "through" as const,
      gen: "long" as const,
      receiver: null,
      ballSpeedFx: 0,
      flightTicks: 0,
      durationTicks: 0,
      laneDangerFx: 0,
      forwardGainFx: 0,
      distFx: 0,
    };
    const a = candidateKey({ ...base, toXFx: 100, toYFx: 200 });
    const b = candidateKey({ ...base, toXFx: 100, toYFx: 201 });
    expect(a).not.toBe(b);
  });
});

describe("#279 S2 — EV 는 정수 고정소수다", () => {
  it("evaluateState 가 정수를 돌려준다 (부동오차가 정렬을 뒤집을 수 없다)", () => {
    const { state } = stateWithOwner();
    for (const p of state.players) {
      const v = evaluateState(
        state,
        { side: p.side, xFx: p.posFx.x, yFx: p.posFx.y, shooting: p.attrs.shooting, fatigue: p.fatigue },
        config,
        pitch,
      );
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("EV_SCALE 이 값의 자릿수를 정한다 (정규화 항의 가중합 스케일)", () => {
    const { state, owner } = stateWithOwner();
    const v = evaluateState(
      state,
      { side: owner.side, xFx: owner.posFx.x, yFx: owner.posFx.y, shooting: 50, fatigue: 0 },
      config,
      pitch,
    );
    // V = advance(≤1) + threat·xg + space(≤1) 의 가중합. 상한은 넉넉히 잡아도 goalValue 스케일 밖.
    expect(Math.abs(v)).toBeLessThan(100 * EV_SCALE);
  });
});

describe("#279 S2 — 노드 예산 + 빔", () => {
  it("기본값은 비구속이다 (S2 의 무회귀 게이트를 예산이 오염하지 않는다)", () => {
    const probe = newChainProbe();
    setChainProbe(probe);
    try {
      runMatch(demoSeed, demoHome, demoAway, demoSelect, chainCfg());
    } finally {
      setChainProbe(null);
    }
    expect(probe.decisions).toBeGreaterThan(100);
    expect(probe.beamClipped).toBe(0);
    expect(probe.recurseClipped).toBe(0);
    expect(probe.budgetHit).toBe(0);
    // 기본값이 실측 최댓값보다 크다는 것이 "비구속"의 근거다.
    expect(probe.maxCandidates).toBeLessThan(config.chain.search.beamTop);
  });

  it("예산을 조이면 실제로 구속하고, 그래도 유효한 행동을 낸다", () => {
    const tight = chainCfg({ search: { maxNodes: 3, beamTop: 2, recurseBeam: 1 } });
    const probe = newChainProbe();
    setChainProbe(probe);
    let log;
    try {
      log = runMatch(demoSeed, demoHome, demoAway, demoSelect, tight);
    } finally {
      setChainProbe(null);
    }
    expect(probe.beamClipped).toBeGreaterThan(0);
    expect(probe.budgetHit).toBeGreaterThan(0);
    // 예산이 걸려도 경기는 완주한다(예산 소진 = "그 시점 best 로 확정", 예외 아님).
    expect(log.tickSnapshots.length).toBeGreaterThan(0);
  });

  it("컷오프가 결정론적이다 — 같은 시드·같은 예산이면 두 실행이 bit-identical", () => {
    const tight = chainCfg({ search: { maxNodes: 7, beamTop: 3, recurseBeam: 1 } });
    const a = runMatch(demoSeed, demoHome, demoAway, demoSelect, tight);
    const b = runMatch(demoSeed, demoHome, demoAway, demoSelect, tight);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("예산이 비구속이면 값을 더 키워도 결과가 같다 (예산이 조용히 개입하지 않는다)", () => {
    const a = runMatch(demoSeed, demoHome, demoAway, demoSelect, chainCfg());
    const b = runMatch(
      demoSeed,
      demoHome,
      demoAway,
      demoSelect,
      chainCfg({ search: { maxNodes: 100000, beamTop: 999, recurseBeam: 999 } }),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("#279 S2 — 계측(probe)", () => {
  it("계측을 켜도 시뮬 결과가 바뀌지 않는다 (관측이 상태가 되면 안 된다)", () => {
    const cfg = chainCfg();
    const off = runMatch(demoSeed, demoHome, demoAway, demoSelect, cfg);
    const probe = newChainProbe();
    setChainProbe(probe);
    let on;
    try {
      on = runMatch(demoSeed, demoHome, demoAway, demoSelect, cfg);
    } finally {
      setChainProbe(null);
    }
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(chainProbe()).toBeNull();
  });

  it("생성/채택 합계가 정합한다 (채택 총합 = 결정 수)", () => {
    const probe = newChainProbe();
    setChainProbe(probe);
    try {
      runMatch(demoSeed, demoHome, demoAway, demoSelect, chainCfg());
    } finally {
      setChainProbe(null);
    }
    const picked = GENERATORS.reduce((s, g) => s + probe.picked[g], 0);
    expect(picked).toBe(probe.decisions);
    // hold 와 carry 는 매 결정마다 정확히 1개씩 생성된다(행동을 안 늘렸다는 증거).
    // ⚠️ 단 **재시작 틱은 예외**다(#349) — 거기선 킥 후보만 만든다(Law 8/13/15/16). 그래서
    // 자릿수 계약을 `decisions − restarts` 로 정확히 좁힌다(느슨하게 ≤ 로 바꾸지 않는다:
    // 그러면 생성기가 조용히 죽어도 통과한다).
    expect(probe.restarts).toBeGreaterThan(0); // 게이트가 실제로 발화한다
    expect(probe.generated.hold).toBe(probe.decisions - probe.restarts);
    expect(probe.generated.carry).toBe(probe.decisions - probe.restarts);
  });
});

describe("#279 S2 — weighted 경로 무변경", () => {
  // engine@0.24.0 에서 기본 코어가 chain 이 됐으므로 **weighted 를 명시적으로 켜서** 잰다.
  // (기본값에 기대면 이 계약이 "chain 이 search 노브에 면역"이라는 거짓을 주장하게 된다 —
  //  chain 은 당연히 예산에 반응해야 하고, 실제로 반응한다 = 위 4) 계약.)
  const weightedConfig: EngineConfig = { ...config, chain: { ...config.chain, mode: "weighted" } };

  it("chain.search 노브는 weighted 결과에 영향이 0 이다 (롤백 보장)", () => {
    const a = runMatch(demoSeed, demoHome, demoAway, demoSelect, weightedConfig);
    const b = runMatch(demoSeed, demoHome, demoAway, demoSelect, {
      ...weightedConfig,
      chain: { ...weightedConfig.chain, search: { maxNodes: 1, beamTop: 1, recurseBeam: 0 } },
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("사슬 코어는 같은 상태·같은 Rng 로 항상 같은 행동을 낸다", () => {
    const { state, owner } = stateWithOwner();
    const cfg = chainCfg();
    const a = decideBallOwnerChain(state, owner, createRng("s2-fixed"), cfg, pitch);
    const b = decideBallOwnerChain(state, owner, createRng("s2-fixed"), cfg, pitch);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("#279 S2 후속 — 정렬 전순서 성질 (독립 검증 M5)", () => {
  /**
   * 왜 이 테스트가 따로 필요한가 — "같은 상태·같은 Rng 면 같은 행동"만으로는 **부족하다**.
   * 그 테스트는 같은 배열을 같은 엔진에 넣으므로 **비일관 비교자에서도 통과**한다(V8 의 sort 는
   * 같은 입력에 같은 출력을 낸다). 실제로 구 코어에는 완전 동점에서 양방향 모두 1 을 반환하는
   * 비교자 버그가 있었고(#279 W2 에서 수리), 그 버그를 되돌려도 재현성 테스트는 green 이었다.
   *
   * 정수 EV 로 바꾼 뒤 **완전 동점이 실제로 발생한다**(독립 검증 실측: 최상위 동점 0.028%,
   * 인접 동점 다수). 그러면 tiebreak 이 실질적 선택자가 되므로, 비교자 자체의
   * **반사성·비대칭성·추이성**을 직접 검사해야 회귀가 잡힌다.
   */
  const cfg: EngineConfig = { ...defaultEngineConfig, chain: { ...defaultEngineConfig.chain, mode: "chain" } };

  /** 실제 경기에서 나온 후보 집합으로 키 전순서를 검사한다(합성 후보로는 실제 충돌 패턴을 못 만든다). */
  function realCandidateKeys(): string[] {
    const pitch = createPitch(cfg);
    const carry = runFirstHalf(demoSeed, demoHome, demoAway, demoSelect, cfg);
    const state: SimState = carry.state;
    const owner: SimPlayer | null = ballOwnerOf(state) ?? null;
    const keys: string[] = [];
    const target = owner ?? state.players.find((p) => !p.isGK)!;
    for (const o of passOptions(state, target, cfg, pitch)) {
      for (const gen of GENERATORS) {
        keys.push(candidateKey(toActionCandidate(o, gen, "direct", 18_000)));
      }
    }
    return keys;
  }

  it("candidateKey 는 후보마다 유일하다 (동점에서 순서가 정해진다)", () => {
    const keys = realCandidateKeys();
    expect(keys.length).toBeGreaterThan(5);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("키 비교자가 전순서다 — 반사성·비대칭성·추이성", () => {
    const keys = realCandidateKeys().sort();
    const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    for (const a of keys) expect(cmp(a, a)).toBe(0); // 반사성: 자기 자신은 항상 0
    for (const a of keys) {
      for (const b of keys) {
        // 비대칭성: cmp(a,b) + cmp(b,a) === 0. 구 버그(`a<b?-1:1`)는 동점에서 1+1=2 가 되어 깨진다.
        // (`toBe(-cmp(b,a))` 로 쓰면 동점에서 `-0 !== +0` 으로 **테스트가** 깨진다 — 코드가 아니라.)
        expect(cmp(a, b) + cmp(b, a)).toBe(0);
      }
    }
    for (const a of keys) {
      for (const b of keys) {
        for (const c of keys) {
          if (cmp(a, b) <= 0 && cmp(b, c) <= 0) expect(cmp(a, c)).toBeLessThanOrEqual(0); // 추이성
        }
      }
    }
  });

  it("chain 모드도 재개(하프 분할)가 통짜와 동일하다", () => {
    const whole = runMatch(demoSeed, demoHome, demoAway, demoSelect, cfg);
    const carry = runFirstHalf(demoSeed, demoHome, demoAway, demoSelect, cfg);
    const split = resumeSecondHalf(carry, demoHome, demoAway);
    expect(split.finalScore).toEqual(whole.finalScore);
    expect(split.events.length).toBe(whole.events.length);
    const last = (l: typeof whole): string => l.tickSnapshots[l.tickSnapshots.length - 1]!.hash;
    expect(last(split)).toBe(last(whole));
  });
});
