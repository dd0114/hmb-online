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

describe("G-A 단조성: 슛 노브↑ → 슛 수↑ (config 가 실제 레버)", () => {
  // ── engine@0.24.0 사슬 코어 채택으로 **레버가 바뀌었다** (#279) ────────────────────────
  // 이 계약의 목적은 예나 지금이나 하나다: **슛 빈도를 config 로 움직일 수 있는가**(구조적 회귀
  // 가드 + S8 밸런스의 전제). 바뀐 것은 "그 노브가 무엇인가" 뿐이다.
  //
  // 왜 `decisionWeights.shoot` 이 더 이상 레버가 아닌가:
  //   weighted 코어는 **행동별 즉시 점수**를 가중 추첨하므로 `decisionWeights.shoot` 이 곧 슛 성향이다.
  //   chain 코어는 행동이 아니라 **도달하는 상태의 EV** 를 비교한다(chain.ts:evaluateCandidateEv) —
  //   슛의 EV = xg × `chain.goalValue` + (1−xg) × 턴오버가치 라 `decisionWeights` 를 아예 읽지 않는다.
  //   실측(GUARD_SEEDS=60, chain): shoot 0.15/0.30/0.80 전부 **12.31 로 동일**(완전 무반응).
  //   ⚠️ 선수 단위 `behavior.shootTendency` 는 chain 에서도 살아 있다(EV 배수) — 죽은 것은
  //      **config 팀 레벨 상수** 하나다. 이 사실은 S8(밸런스 1회)의 입력이다.
  //
  // 그래서 사다리를 **활성 코어의 실제 레버**(`chain.goalValue`)로 옮긴다. 임계(비율 1.35배 · 절대
  // 3.5)는 **하나도 손대지 않았다** — 판정 세기를 낮추지 않고 노브만 현행화한 것이다.
  //
  // 실측(engine@0.24.0 chain, GUARD_SEEDS=60시드):
  //   8→1.20 · 10→7.65 · 12→12.31(기본) · 14→14.22 · 18→16.77 · 26→17.50 · (40→18.54)
  //   하단 8 은 "슛 EV 가 패스 EV 를 못 이겨 거의 안 쏘는" 축퇴 구간이라 사다리 최하단으로 둔다.
  //
  // ── 무엇을 잃었나(명시) ──────────────────────────────────────────────────────────
  // 구 사다리가 재던 `decisionWeights.shoot` 의 미세 단조성(0.04~0.08 폭 감도)은 chain 에서 **정의
  // 자체가 없다**. 그 감도는 weighted(롤백 경로)에서만 의미가 있으므로 아래 별도 it 에서 2점
  // 대비로만 지킨다(60시드 × 6 rung 을 두 코어 모두 도는 비용은 게이트 시간에 안 맞는다).
  it("chain.goalValue 사다리 8→26 엄격 단조 + 26→40 비엄격(포화 구간)", () => {
    const ladder = [8, 10, 12, 14, 18, 26];
    const SAT = 40; // 포화 구간 상단(비엄격 판정)
    const measure = (goalValue: number) =>
      aggregateRealism({ ...cfg, chain: { ...cfg.chain, goalValue } }, GUARD_SEEDS).mean.shots;

    const shots = ladder.map(measure);
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i], `goalValue ${ladder[i - 1]}→${ladder[i]} 구간에서 증가해야 (측정 ${shots.join(" → ")})`)
        .toBeGreaterThan(shots[i - 1]!);
    }
    const sat = measure(SAT);
    // 포화 상단: 증가는 요구하지 않되 **하락은 금지**(tol 은 구 계약과 동일한 1.0슛).
    expect(sat, `goalValue 26→${SAT} 는 포화 구간이라 증가는 안 봐도 되지만 하락하면 회귀다 (26=${shots[shots.length - 1]}, ${SAT}=${sat})`)
      .toBeGreaterThanOrEqual(shots[shots.length - 1]! - 1.0);

    // 총효과 판정식은 구 계약 그대로(비율 주 + 절대 하한). 현재: 1.20 → 18.54 = 절대 17.34 · 15.45배.
    const span = sat - shots[0]!;
    const ratio = sat / shots[0]!;
    const label = `전 구간 총효과 (8=${shots[0]} → ${SAT}=${sat}) 절대 ${span.toFixed(2)} · 비율 ${ratio.toFixed(2)}배`;
    expect(ratio, `${label} — 레버 비율이 죽었다`).toBeGreaterThan(1.35);
    expect(span, `${label} — 절대 폭 하한(무한 침식 방지)`).toBeGreaterThan(3.5);
  });

  // 롤백 경로(`chain.mode: "weighted"`)의 레버도 살아 있어야 한다 — 롤백이 "돌아가긴 하는데 튜닝은
  // 못 하는" 상태면 롤백 스위치로서 쓸모가 없다. 2점 대비(사다리 아님)인 이유는 비용이다.
  // 실측(engine@0.24.0 weighted, GUARD_SEEDS=60): 0.15→9.53 · 0.80→13.69 = 절대 4.16 · 1.44배.
  it("롤백 경로(weighted)의 decisionWeights.shoot 은 여전히 레버다 (0.15 vs 0.80)", () => {
    const weighted: EngineConfig = { ...cfg, chain: { ...cfg.chain, mode: "weighted" } };
    const measure = (shoot: number) =>
      aggregateRealism({ ...weighted, decisionWeights: { ...cfg.decisionWeights, shoot } }, GUARD_SEEDS).mean.shots;
    const lo = measure(0.15);
    const hi = measure(0.8);
    const label = `weighted shoot 0.15=${lo} → 0.80=${hi} (절대 ${(hi - lo).toFixed(2)} · 비율 ${(hi / lo).toFixed(2)}배)`;
    expect(hi / lo, `${label} — 롤백 경로의 레버 비율이 죽었다`).toBeGreaterThan(1.35);
    expect(hi - lo, `${label} — 롤백 경로의 절대 폭 하한`).toBeGreaterThan(3.5);
  });
});
