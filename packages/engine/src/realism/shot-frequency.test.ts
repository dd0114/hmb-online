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
  it("shoot 0.34→0.6 로 올리면 팀당 슛이 유의미하게(≥2) 증가", () => {
    const hotter: EngineConfig = {
      ...cfg,
      decisionWeights: { ...cfg.decisionWeights, shoot: 0.6 },
    };
    // 전체 20 시드. 8 시드는 표본 분산이 너무 커 효과크기가 요동친다(같은 대비에서 Δ가
    // 8시드 4.00 vs 20시드 2.65 로 흔들림) — 임계를 낮추는 대신 표본을 늘려 계약을 강화한다.
    //
    // 정직한 이력(검증 세션 지적으로 박제): 표본을 8→20 으로 바꾼 시점(#147 W2, 19b4b10)에
    // 이 계약은 8시드 Δ=1.25 로 **실패**했고 20시드 2.40 으로만 통과했다 — 그때의 표본 변경은
    // "강화"가 아니라 그 실패를 가린 것이었다. W2 동작 변경은 효과 없음으로 판명돼 01d959e 에서
    // 철회됐고(엔진 0.16.0 복귀), 현재는 8시드 4.00 / 20시드 2.65 로 **둘 다 통과**한다.
    // 그럼에도 표본 20 을 유지하는 근거는 그 두 값의 벌어짐 자체(8시드 분산 과다)다.
    const base = aggregateRealism(cfg, REALISM_SEEDS).mean.shots;
    const more = aggregateRealism(hotter, REALISM_SEEDS).mean.shots;
    expect(more).toBeGreaterThan(base + 2);
  });
});
