import { describe, it, expect } from "vitest";
import {
  runFirstHalf,
  defaultEngineConfig,
  demoSeed,
  demoHome,
  demoAway,
  demoSelect,
  type CarryState,
  type SimState,
} from "@hmb/engine";
import { serializeCarry, deserializeCarry } from "./simulate.js";

/**
 * resumeState 왕복 동등성 (#279 S1).
 *
 * zod `.object()` 는 **미선언 키를 조용히 버린다**(#154 와 동형). 그래서 엔진이 `SimState` 에 필드를
 * 하나 추가할 때마다 이 러너 스키마가 같이 안 자라면, 하프 재개가 **에러 없이** 그 상태만 잃은 채
 * 진행되고 다음 틱부터 갈라진다(무음 desync).
 *
 * 기존 `simulate.test.ts` 는 **단일 시드·단일 경계**(demoSeed 의 전반 종료 시점)만 본다 — 그 한 상태에
 * 우연히 없는 필드(비행 중인 공의 `claimant/waited/fromX/fromY/long`, `setPiece.restart = penalty`)는
 * 통째로 못 잡는다. 실제로 이 두 건이 드리프트해 있었다.
 *
 * 여기서는 ①여러 시드의 실제 하프 경계 상태와 ②**모든 선택 필드를 채운 합성 상태**를 둘 다
 * 왕복시켜 `byId`(런타임 재구성분)를 뺀 전부가 deep-equal 인지 본다. 합성 상태 쪽이 드리프트
 * 탐지의 본체다 — 실제 경계 상태는 우연에 의존하지만 합성 상태는 결정적으로 전 필드를 훑는다.
 */

const config = defaultEngineConfig;

/** byId(Map — 직렬화 대상 아님, deserialize 가 buildById 로 재구성)를 뺀 상태. */
function stateBody(state: SimState): Omit<SimState, "byId"> {
  const { byId: _byId, ...rest } = state;
  return rest;
}

/** serialize → JSON 왕복(실제 전송 경로) → deserialize. */
function roundTrip(carry: CarryState): CarryState {
  const wire = JSON.parse(JSON.stringify(serializeCarry(carry))) as unknown;
  return deserializeCarry(wire, config);
}

function carryFor(seed: string): CarryState {
  return runFirstHalf(seed, demoHome, demoAway, demoSelect, config);
}

describe("resumeState 왕복 동등성 — 실제 하프 경계 (다시드)", () => {
  for (const seed of [demoSeed, "20260730", "7"]) {
    it(`seed=${seed}: 하프 경계 SimState 가 왕복 후 deep-equal`, () => {
      const carry = carryFor(seed);
      const before = structuredClone(stateBody(carry.state));
      const after = stateBody(roundTrip(carry).state);
      expect(after).toEqual(before);
    });
  }
});

describe("resumeState 왕복 동등성 — 전 필드 합성 상태 (드리프트 탐지 본체)", () => {
  /** 모든 선택 필드를 채운 상태로 덮어쓴다 — 실제 경기에서는 특정 틱에만 존재하는 조합. */
  function fillAllOptionals(state: SimState): void {
    state.possessionSince = 1234;
    state.lastTurnover = { side: "away", tick: 1230, xFx: 42_000, yFx: 17_500 };
    state.plan = {
      home: { lineX: 51_234, blockDepth: 0.75 },
      away: { lineX: 12_345, blockDepth: 0.25 },
    };
    // BallFlight: #181 산물(claimant·waited·fromX·fromY) + E2(long) 까지 전부.
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = {
      toX: 90_000,
      toY: 30_000,
      speed: 5_000,
      kind: "pass",
      target: "H9",
      fromSide: "home",
      xg: 0.42,
      passOutcome: "fail_intercept",
      claimant: "A4",
      waited: 2,
      fromX: 40_000,
      fromY: 20_000,
      long: true,
    };
    state.players[0]!.markTarget = "A7";
    // #314 B: 런 오더가 살아 있는 상태로 하프가 끝날 수 있다 — 스키마가 이 필드를 흘리면
    // 재개 하프에서만 러너가 멈춘다(무음 desync). 비기본값이어야 드리프트가 드러난다.
    state.players[9]!.runOrder = { xFx: 88_000, yFx: 31_500, untilTick: 1236, fromId: "H6" };
    // S4/S5 자리 — **기본값(open / 빈 배열)으로 두면 안 된다.** 스키마가 이 필드를 흘려도
    // 기본값끼리는 우연히 같아 보일 수 있으므로, 비기본값을 넣어야 드리프트가 드러난다.
    state.phase = { home: "final_third", away: "transition_lose" };
    state.intents = [
      { side: "home", fromId: "H6", kind: "pass_to", xFx: 77_000, yFx: 22_000, tick: 1230, expiresTick: 1235, forId: "H9" },
      { side: "away", fromId: "A3", kind: "run_to", xFx: 12_000, yFx: 55_000, tick: 1231, expiresTick: 1237 },
    ];
  }

  it("모든 선택 필드가 채워진 상태가 왕복 후 deep-equal (하나라도 미선언이면 여기서 깨진다)", () => {
    const carry = carryFor(demoSeed);
    fillAllOptionals(carry.state);
    const before = structuredClone(stateBody(carry.state));
    const after = stateBody(roundTrip(carry).state);
    expect(after).toEqual(before);
  });

  for (const restart of [
    { kind: "corner", side: "home", nearY: 0 },
    { kind: "goal_kick", side: "away" },
    // 하프 마지막 틱 박스 파울 → 이 변형이 스키마에 없으면 union 파싱 실패 → throw → 400.
    { kind: "penalty", side: "home" },
  ] as const) {
    it(`setPiece.restart = ${restart.kind} 가 왕복에서 살아남는다`, () => {
      const carry = carryFor(demoSeed);
      fillAllOptionals(carry.state);
      carry.state.setPiece = { kind: "shot_out", side: "away", x: 1_000, y: 2_000, restart };
      const before = structuredClone(stateBody(carry.state));
      const after = stateBody(roundTrip(carry).state);
      expect(after.setPiece).toEqual(before.setPiece);
      expect(after).toEqual(before);
    });
  }
});
