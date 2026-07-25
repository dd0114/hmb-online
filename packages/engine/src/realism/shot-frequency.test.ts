import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { aggregateRealism, GUARD_SEEDS } from "./harness";

/**
 * G-A 슛 빈도 계약 (#99, §2.5 E2E-TDD).
 *  A) 단조성: 슛 성향(decisionWeights.shoot)을 올리면 팀당 슛 수가 늘어난다(구조적 회귀 가드).
 *  B) 리얼 config 다수시드 팀당 슛 ∈ [12,14](벤치, football-stats.md §3) + 골 가뭄 아님(골>0).
 * A 는 config 노브가 슛 빈도의 실제 레버임을 박제(threshold 절벽·멀티플라이어 상호작용에도 방향 보존).
 * B 는 G-A 튜닝 목표(팀당 슛 23.85→~13.6, 골 2.98→~1.6).
 */

const cfg = defaultEngineConfig;

// 20 시드(팀-경기 40). SD 크지만 평균은 밴드 내 안정.
const agg = aggregateRealism(cfg, GUARD_SEEDS);

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
  it("shoot 사다리 0.15→0.80 **전 구간** 단조 증가한다", () => {
    // 단일 대비의 "효과크기 ≥N" 대신 사다리 단조성을 박는다 — rung 선택이 튜닝 여지가 되지 않도록
    // 직전 기본값(0.34)을 포함한 **전 구간**을 쓴다.
    //
    // 실측(#182 코너 rest defence 후, GUARD_SEEDS=40시드):
    //   0.15→11.03 · 0.22→12.09 · 0.30→13.19 · 0.34→13.71 · 0.45→15.94 · 0.60→15.96 · 0.80→17.43
    // 이력: 직전 튜닝(attackWidthReach 0.13)에서는 0.34→0.45 구간이 15.25→14.70 으로 **감소**해
    // 계약 구간을 0.15-0.34 로 한정했었다. awr 0.10 으로 조정하니 포화·역전이 사라져 전 구간
    // 단조가 됐다 — 즉 그 비단조는 엔진의 본질이 아니라 그 config 지점의 성질이었다.
    // #182: 20시드에서 0.30→0.34·0.45→0.60 이 각각 −0.25/−0.33 으로 뒤집혔는데, 같은 config 를
    // n=40·60 으로 재면 전 구간 단조였다(11.03→…→17.43 / 11.26→…→17.46). 즉 그 dip 은 엔진이
    // 아니라 **표본오차**(SE≈0.7 > rung 간격)였다 → 측정 표본을 GUARD_SEEDS 로 올린다.
    // 단조성 주장 자체는 그대로 유지(느슨하게 하지 않음). 위 밴드 테스트는 20시드에서도
    // 통과하므로(13.53) 이 상향은 밴드 회피가 아니다 — 근거는 harness.ts GUARD_SEEDS 주석.
    const ladder = [0.15, 0.22, 0.3, 0.34, 0.45, 0.6, 0.8];
    const shots = ladder.map(
      (shoot) =>
        aggregateRealism({ ...cfg, decisionWeights: { ...cfg.decisionWeights, shoot } }, GUARD_SEEDS).mean.shots,
    );
    // #181: 소유 이전이 controlRange 안에서만 일어나게 되면서 **경기당 소유 횟수 자체가 상한**을
    // 갖는다 → shoot 을 계속 올려도 어느 지점부터 슛이 더 늘지 않는다(포화). 실측(20시드):
    //   0.15→10.05 · 0.22→11.68 · 0.30→12.10 · 0.34→13.13 · 0.45→13.53 · 0.60→13.53 · 0.80→14.68
    // 0.45→0.60 이 정확히 동률이다. 이건 "레버가 죽었다"가 아니라 **모델의 성질**이므로,
    // 레버가 여력을 갖는 구간(≤0.45)은 **엄격 증가**로, 포화 구간은 **비감소**로 박는다.
    // (구간을 좁혀 통과시키면 그 자체가 튜닝 여지가 되므로 사다리는 전 구간 유지한다.)
    const STRICT_UP_TO = 0.45;
    for (let i = 1; i < shots.length; i++) {
      const msg = `shoot ${ladder[i - 1]}→${ladder[i]} (측정 ${shots.join(" → ")})`;
      if (ladder[i]! <= STRICT_UP_TO) expect(shots[i], `${msg} 구간에서 증가해야`).toBeGreaterThan(shots[i - 1]!);
      else expect(shots[i], `${msg} 포화 구간이라도 감소하면 안 된다`).toBeGreaterThanOrEqual(shots[i - 1]!);
    }
    expect(shots[shots.length - 1]! - shots[0]!).toBeGreaterThan(4);
  });
});
