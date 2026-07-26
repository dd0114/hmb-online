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
  it("shoot 사다리 0.15→0.65 엄격 단조 + 0.65→0.80 비엄격(포화 구간)", () => {
    // 이 계약의 목적: **config 의 shoot 노브가 슛 빈도의 실제 레버임**을 박제한다(구조적 회귀 가드).
    // 단일 대비의 "효과크기 ≥N" 대신 사다리를 쓰는 이유는 rung 선택이 튜닝 여지가 되지 않게 하기 위함.
    //
<<<<<<< HEAD
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
=======
    // ── 사다리 간격을 측정해상도에 맞춘 이유 (#182, gameqa 결정 A) ────────────────────────
    // 구 사다리는 0.30↔0.34 처럼 **폭 0.04** 인 rung 을 포함했다. 그 구간의 참효과는
    // **+0.38 슛**인데(대표본 n=120 실측), 팀당 슛의 팀-경기 SD ≈ 5 라
    //   SE(Δ) = √(SD²+SD²)/√(2n) ≈ 0.66 (n=60) · 0.47 (n=120)
    // 즉 **참효과 < 측정오차** → 부호가 표본마다 뒤집힌다(실측 n=60 Δ=−0.34, n=120 Δ=+0.39).
    // 표본을 더 키워도 안정 판정하려면 n≳250 이라 실용적이지 않다.
    // ※ 이건 #182(코너 rest defence)가 만든 문제가 아니다 — **그 변경을 꺼도 동일**했다
    //   (지터 X: n=60 Δ=+0.02 = 동전던지기, n=120 Δ=+0.38). 즉 rung 해상도 자체의 잠복 결함.
    // → 모든 인접 간격을 **≥0.08** 로 벌려 참효과가 SE 를 넘게 만든다(폭 0.11 rung 의 참효과는
    //   +1.6 으로 n=60 에서 여유 있게 판정 가능). 기본값(0.30)은 사다리에 그대로 유지한다.
    //
    // ── 무엇을 잃었나(명시) ──────────────────────────────────────────────────────────
    // 상단 0.65→0.80 의 **엄격 단조 판정을 포기**했다. 그 구간은 표본 문제가 아니라 **포화**다
    // (bug176 실측 0.60→0.80 = +0.05 슛 = 0.07σ). 표본을 늘려도 해소되지 않으므로 엄격 단조로
    // 두면 영구 플래키가 된다. 대신 **비엄격 가드**(하락 금지)로 남겨 "상단에서 슛이 오히려
    // 줄어드는" 회귀는 계속 잡는다. 포화 자체의 타당성은 별건(QA #25)으로 다룬다.
    // 잃은 것 = 0.65↔0.80 사이의 미세 증가 방향성. 남긴 것 = 하락 금지 + 전 구간 총효과.
    const ladder = [0.15, 0.22, 0.3, 0.38, 0.5, 0.65];
    const SAT = 0.8; // 포화 구간 상단(비엄격 판정)
    const measure = (shoot: number) =>
      aggregateRealism({ ...cfg, decisionWeights: { ...cfg.decisionWeights, shoot } }, GUARD_SEEDS).mean.shots;

    const shots = ladder.map(measure);
>>>>>>> dded747 ([Spider] test(engine): 사다리 재간격 + 상단 포화 비엄격 가드 (#182, gameqa 결정 A))
    for (let i = 1; i < shots.length; i++) {
      const msg = `shoot ${ladder[i - 1]}→${ladder[i]} (측정 ${shots.join(" → ")})`;
      if (ladder[i]! <= STRICT_UP_TO) expect(shots[i], `${msg} 구간에서 증가해야`).toBeGreaterThan(shots[i - 1]!);
      else expect(shots[i], `${msg} 포화 구간이라도 감소하면 안 된다`).toBeGreaterThanOrEqual(shots[i - 1]!);
    }
    // 총효과: 사다리 양끝 차이가 충분히 커야 노브가 "실제 레버"다.
    expect(shots[shots.length - 1]! - shots[0]!).toBeGreaterThan(4);

    // 포화 상단: 증가는 요구하지 않되 **하락은 금지**. tol 은 SE(Δ)≈0.66(n=60) 의 약 1.5배 —
    // 노이즈 한 방으로는 못 뚫고, 실제 하락 회귀(≫1슛)는 잡히는 폭.
    const sat = measure(SAT);
    expect(sat, `shoot 0.65→${SAT} 는 포화 구간이라 증가는 안 봐도 되지만 하락하면 회귀다 (0.65=${shots[shots.length - 1]}, ${SAT}=${sat})`)
      .toBeGreaterThanOrEqual(shots[shots.length - 1]! - 1.0);
  });
});
