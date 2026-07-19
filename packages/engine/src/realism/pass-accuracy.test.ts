import { describe, it, expect } from "vitest";
import type { PlayerAttributes, PlayerBehavior } from "@hmb/shared";
import { defaultEngineConfig } from "../config";
import { createPitch } from "../pitch";
import { toFixed } from "../fixedmath";
import { computePassProb } from "../decision";
import type { SimPlayer } from "../simstate";
import type { PassOption } from "../perception";
import type { SimState } from "../simstate";
import { aggregateRealism } from "./harness";

/**
 * E1 패스 정확도 계약 (§2.5 E2E-TDD).
 *  A) computePassProb 단조성: 전진·롱 패스 성공률 < 숏 패스(벤치: 전진/파이널서드 55–70% ≪ 전체 78–85%).
 *  B) 리얼 config 다수시드 평균 패스 성공률 ∈ [78, 85]% (벤치, football-stats.md §2).
 * A 는 config 페널티 구조의 구조적 보장(회귀 가드), B 는 E1 튜닝 목표.
 */

const cfg = defaultEngineConfig;
const scale = cfg.fixedScale;
const pitch = createPitch(cfg);

const ATTRS: PlayerAttributes = {
  technical: 50, mental: 50, physical: 50, passing: 50, shooting: 50,
  tackling: 50, pace: 50, stamina: 50, positioning: 50,
};
const BEH: PlayerBehavior = {
  positioningFreedom: 0.5, forwardRunFreq: 0.5, widthTendency: 0.5, supportDepth: 0.5,
  pressAggression: 0.5, passRisk: 0.5, passDirectness: 0.5, dribbleTendency: 0.5, shootTendency: 0.5,
};

function mkPlayer(id: string, xM: number, yM: number): SimPlayer {
  const fx = { x: toFixed(xM, scale), y: toFixed(yM, scale) };
  return {
    id, side: "home", role: "CM", duty: "support", behavior: { ...BEH },
    mentalModifier: 0, attrs: { ...ATTRS }, baseFx: { ...fx }, posFx: { ...fx },
    targetFx: { ...fx }, fatigue: 0, isGK: false, idHash: 1, dribbleStreak: 0, yellowCards: 0,
  };
}

/** opt: forwardGain(m)·dist(m)·receiver 파이널서드 여부만 제어(computePassProb 가 쓰는 값). */
function mkOpt(fwdM: number, distM: number, receiverXm: number): PassOption {
  return {
    receiver: mkPlayer("H9", receiverXm, 34),
    dist: toFixed(distM, scale),
    laneDanger: toFixed(10, scale),
    forwardGain: toFixed(fwdM, scale),
  };
}

describe("E1-A computePassProb 단조성 (전진/롱 < 숏)", () => {
  const owner = mkPlayer("H6", 40, 34);
  // 압박 없음(상대 0명) → pressers 0. 순수 forward/dist/finalThird 효과만.
  const state = { players: [owner], teams: {}, ball: {} } as unknown as SimState;

  const shortCentral = computePassProb(state, owner, mkOpt(2, 10, 45), cfg, pitch); // 숏·횡
  const forward = computePassProb(state, owner, mkOpt(18, 18, 60), cfg, pitch); // 전진
  const longForward = computePassProb(state, owner, mkOpt(20, 35, 75), cfg, pitch); // 롱·전진·파이널서드

  it("숏·중앙 패스가 전체 벤치(78–85%) 근처로 가장 높다", () => {
    expect(shortCentral).toBeGreaterThan(0.78);
  });
  it("전진 패스는 숏보다 유의미하게 낮다(≥10%p)", () => {
    expect(forward).toBeLessThan(shortCentral - 0.1);
  });
  it("롱·전진 패스는 전진보다도 낮다(거리 페널티)", () => {
    expect(longForward).toBeLessThan(forward);
  });
  it("롱·파이널서드 패스는 벤치 파이널서드(55–70%) 이하로 낮다", () => {
    expect(longForward).toBeLessThan(0.7);
  });
});

describe("E1-B 리얼 config 다수시드 패스 성공률 ∈ [78,85]%", () => {
  // 10 시드(팀-경기 20)로도 SD ~1.3 → 평균 매우 안정. 벤치 밴드 검증.
  const agg = aggregateRealism(cfg, [
    "4815162342", "9999999999", "1234567890", "2718281828", "1414213562",
    "1618033988", "31415926", "27182818", "16180339", "14142135",
  ]);
  it(`평균 패스 성공률 78–85% (측정 ${agg.mean.passSuccessPct}%)`, () => {
    expect(agg.mean.passSuccessPct).toBeGreaterThanOrEqual(78);
    expect(agg.mean.passSuccessPct).toBeLessThanOrEqual(85);
  });
});
