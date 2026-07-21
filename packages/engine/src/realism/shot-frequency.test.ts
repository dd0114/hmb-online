import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { aggregateRealism, REALISM_SEEDS } from "./harness";

/**
 * G-A 슛 빈도 계약 (#99, §2.5 E2E-TDD).
 *  A) 단조성: 슛 성향(decisionWeights.shoot)을 올리면 팀당 슛 수가 늘어난다(구조적 회귀 가드).
 *  B) 리얼 config 다수시드 팀당 슛 ∈ [12,14](벤치, football-stats.md §3) + 골 가뭄 아님(골>0).
 * A 는 config 노브가 슛 빈도의 실제 레버임을 박제(threshold 절벽·멀티플라이어 상호작용에도 방향 보존).
 * B 는 G-A 튜닝 목표(팀당 슛 23.85→~13.6, 골 2.98→~1.6).
 */

const cfg = defaultEngineConfig;

// 20 시드(팀-경기 40). SD 크지만 평균은 밴드 내 안정.
const agg = aggregateRealism(cfg, REALISM_SEEDS);

describe("G-A 슛 빈도 밴드(팀당 12–14) + 골 유지", () => {
  it(`팀당 슛 12–14 (측정 ${agg.mean.shots})`, () => {
    expect(agg.mean.shots).toBeGreaterThanOrEqual(12);
    // 상한은 D4 확정 벤치(12-14)와 일치시킨다. 이전엔 14.5 로 느슨해 제목(12-14)과 어긋났고,
    // #147 W2 때 실측 14.15 가 그 슬랙에 숨었다(검증 세션 지적). W2 철회 후 현재 14.00 —
    // 밴드 상단에 정확히 걸터앉아 있어 여유가 없다(밸런스 여유 확보는 S4 #10 소관).
    expect(agg.mean.shots).toBeLessThanOrEqual(14);
  });
  it(`슛당 xG 0.10–0.12 밴드 근처 (측정 ${agg.mean.xgPerShot}) — 슛만 깎고 질 왜곡 금지`, () => {
    expect(agg.mean.xgPerShot).toBeGreaterThanOrEqual(0.1);
    expect(agg.mean.xgPerShot).toBeLessThanOrEqual(0.13);
  });
  it(`골 가뭄 아님: 팀당 골 ∈ [1.4, 1.9] (측정 ${agg.mean.goals})`, () => {
    // 슛만 과하게 줄여 골 가뭄을 만들지 않는다(§ 매니저 요구). 벤치 1.4–1.65 + 시드분산 여유.
    // 상한 2.5 는 과도한 슬랙이었다(#147 W2 의 1.78 이 여기 숨음) → 1.9 로 조임. 현재 1.65.
    expect(agg.mean.goals).toBeGreaterThanOrEqual(1.4);
    expect(agg.mean.goals).toBeLessThanOrEqual(1.9);
  });
});

describe("G-A 단조성: shoot 성향↑ → 슛 수↑ (config 가 실제 레버)", () => {
  it("shoot 사다리 0.15→0.34 에서 팀당 슛이 단조 증가한다(그 위는 포화·비단조 — 아래 주석)", () => {
    // 단일 대비의 "효과크기 ≥N" 대신 **사다리 단조성**을 박는다. 단, rung 선택 자체가 튜닝 여지가
    // 되지 않도록 **직전 기본값 0.34 를 반드시 포함**하고, 포함하지 않는 구간의 사유를 명시한다.
    //
    // 실측 사다리(engine@0.17.0, 20시드):
    //   0.15→8.82 · 0.22→11.20 · 0.30→13.35 · 0.34→15.25 · 0.45→14.70 · 0.60→15.28 · 0.80→15.50
    // ⚠️ **0.34 위는 포화이며 단조도 아니다**(0.34→0.45 에서 15.25→14.70 으로 *감소*). 다른 제약
    //    (사거리·xG 임계·패스 대안)이 먼저 묶여서다. 그래서 계약 구간을 0.15–0.34 로 한정한다 —
    //    이 한정은 실패 회피가 아니라 **레버가 실제로 작동하는 구간의 선언**이고, 감소 구간을 숨기지
    //    않기 위해 여기 수치를 그대로 남긴다.
    // 이력: 구 계약("0.34→0.6 에서 ≥+2")은 시야 계층(#147 W3) 이후 델타 0.03 으로 무너졌다
    //    (레거시에서는 2.43 이라 통과했다). 임계를 낮추는 대신 구간 단조성으로 바꿨다.
    const ladder = [0.15, 0.22, 0.3, 0.34];
    const shots = ladder.map(
      (shoot) =>
        aggregateRealism({ ...cfg, decisionWeights: { ...cfg.decisionWeights, shoot } }, REALISM_SEEDS).mean.shots,
    );
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i], `shoot ${ladder[i - 1]}→${ladder[i]} 구간에서 증가해야 (측정 ${shots.join(" → ")})`)
        .toBeGreaterThan(shots[i - 1]!);
    }
    // 작동 구간의 효과크기가 실질적이어야 한다(노브가 살아있다는 증거).
    expect(shots[shots.length - 1]! - shots[0]!).toBeGreaterThan(4);
  });
});
