import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import { measureJitter } from "./jitter";

/**
 * 마크 진동 계약 (#178, §2.5 E2E-TDD — 고치기 전에 버그를 박제했다).
 *
 * hero 제보: "공 잡은 선수 위아래로 빠르게 움직인다. 부자연스럽고 다른 유닛보다 너무 빠르다."
 * gameqa 진단: `vision.markReach` 마크 당김이 **위치가 아니라 고정 길이 스텝**이라, 이미 마크에
 * 붙어 있으면 마크를 지나쳐 반대편을 목표로 잡는다 → 다음 틱엔 방향이 뒤집혀 매 틱 ±3m 왕복.
 * `w = markReach·(1 − dist/rad)` 가 **가까울수록 커져서** 진동을 키운다. 압박 지정 수비수는
 * 목표가 이미 공 위치라 마크와 겹쳐 최악이 된다 = hero 가 본 장면.
 *
 * 인과 격리(gameqa, 같은 시드 재시뮬): vision off / markReach=0 이면 진동이 사라진다 →
 * 반경·주의·기억이 아니라 **당김의 오버슛**이 단독 원인.
 *
 * ## 계약 설계 — 관계 계약이 주(主)
 * 절대 임계만 걸면 "얼마가 정상인가"를 이 파일이 임의로 정하게 된다. 대신 **시야 계층을 끈
 * 같은 시드**를 대조군으로 삼아 "시야 계층이 진동을 새로 만들어내지 않는다"를 건다 —
 * 수정 전 6.1배(43.1 vs 7.05), 수정 후 0.90배. 절대 밴드는 두 값이 함께 표류하는 경우의 백스톱.
 *
 * 주 지표는 **bigReversalPer100**(양쪽 변위 ≥2m/tick 인 반전) 이다. 하한 없는 반전율은
 * 미세 조정의 방향 뒤집힘까지 세어 관객이 못 보는 변화에 반응한다(synchrony.ts 가 두 번 걸린
 * 표본 구성 아티팩트). 관객이 본 것은 매 틱 ±5m 짜리 제자리 왕복이므로 그것만 센다.
 */

// 4 시드로 충분(결정론이라 표본 분산 없음, 비용 절감). 골든이므로 시드 목록을 바꾸면 스냅샷도 갱신.
const SEEDS = REALISM_SEEDS.slice(0, 4);
const report = measureJitter(defaultEngineConfig, SEEDS);

/** 시야 계층을 끈 기준선 — "당김이 없을 때 진동이 얼마인가"의 대조군(롤백 스위치 재사용). */
const visionOff = measureJitter(
  { ...defaultEngineConfig, vision: { ...defaultEngineConfig.vision, enabled: false } },
  SEEDS,
);

describe("마크 진동 골든 (#178)", () => {
  it("현 진동 지표를 스냅샷으로 박제한다(회귀·개선 모두 diff 로 드러남)", () => {
    expect(report).toMatchSnapshot();
  });
});

describe("마크 진동 상한 (#178)", () => {
  it(`볼 옆 수비수의 큰 왕복이 시야off 기준선의 1.3배 이하 (현재 ${report.nearOwner.bigReversalPer100} vs 기준선 ${visionOff.nearOwner.bigReversalPer100})`, () => {
    expect(report.nearOwner.bigReversalPer100).toBeLessThanOrEqual(visionOff.nearOwner.bigReversalPer100 * 1.3);
  });

  it(`수비수 전원의 큰 왕복이 시야off 기준선의 1.3배 이하 (현재 ${report.all.bigReversalPer100} vs 기준선 ${visionOff.all.bigReversalPer100})`, () => {
    expect(report.all.bigReversalPer100).toBeLessThanOrEqual(visionOff.all.bigReversalPer100 * 1.3);
  });

  it(`볼 옆 수비수 평균 이동이 시야off 기준선의 1.2배 이하 (현재 ${report.nearOwner.avgMoveM} vs 기준선 ${visionOff.nearOwner.avgMoveM}) — 진동은 주행거리도 부풀린다`, () => {
    expect(report.nearOwner.avgMoveM).toBeLessThanOrEqual(visionOff.nearOwner.avgMoveM * 1.2);
  });

  // 절대 백스톱: 두 값이 함께 표류하면 위 관계 계약은 통과해버린다.
  //
  // ── engine@0.24.0 사슬 채택 재보정 (#279) ⚠️ S8 에서 재검토 ──────────────────────────
  // 임계 10 → **11**. 근거는 "느슨하게 하자"가 아니라 **표본 구성이 바뀌었다** 이다:
  //   · nearOwner 표본 **6939 → 4608 (−34%)**. 사슬 코어는 패스를 훨씬 많이 해서(시퀀스당 3.85
  //     vs 2.48) "소유자가 공을 들고 있고 그 옆에 수비수가 있는" 틱 자체가 줄고, 남은 표본이
  //     **패스 직후 방향 전환 구간**에 몰린다. 그 구간의 반전은 진동이 아니라 정상 반응이다.
  //   · 구성이 통제된 **관계 계약(주 지표)은 오히려 좋아졌다**: 시야off 대비 0.90배 → **0.78배**
  //     (10.26 vs 기준선 13.17). 즉 시야 계층이 만드는 진동분은 줄었고, 기준선 자체가 올라갔다.
  // 임계 11 은 여전히 이빨이 있다 — 수정 전 버그값 43.1 은 물론, 여기서 +7% 만 더 표류해도 잡힌다.
  // 이 값의 최종 재보정은 S8(밸런스 1회) 및 H5 루즈볼 물리(#313) 이후에 다시 본다.
  //
  // ── 재기준 11 → 20 · 2.0 → 3.0 (#353 홀드 압박 + #357 볼륨 재보정) ────────────────
  // ⚠️ **이건 "값이 넘쳐서 넓힌 것"이 아니다 — 임계가 대조군 아래로 내려가 측정 대상을 잃었다.**
  //   지금 시야off(= 당김 없음) 기준선이 **20.71** 이다. 즉 마크 당김을 **완전히 끈 세계**가
  //   구 임계 11 을 이미 두 배 가까이 넘는다. 그 상태의 "≤11" 은 당김 오버슛(#178 이 고친 것)을
  //   재는 것이 아니라 **엔진 전체의 이동량 수준**을 재는 숫자다 — 이 파일의 목적이 아니다.
  //   같은 이유로 평균 이동도 기준선이 2.78 이라 구 임계 2.0 이 대조군 아래였다.
  // 방향은 오히려 좋다: 현재 **18.97 < 기준선 20.71**(0.92배) — 시야 계층은 진동을 **줄인다**.
  // 주 계약(관계식 ≤1.3배)은 셋 다 통과하고 있고, 이 백스톱은 "둘이 함께 표류"를 잡는 보조다.
  // 20 · 3.0 = 실측 18.97 · 2.85 위 5% 여유. 원 버그값 43.1 에 대한 이빨은 그대로다.
  // (표본 구성 변화 이력: nearOwner 표본 6939 → 4608 → 사슬+홀드압박으로 다시 이동.)
  it(`절대 백스톱 — 볼 옆 큰 왕복 ≤ 20/100, 평균 이동 ≤ 3.0 m/tick (현재 ${report.nearOwner.bigReversalPer100} · ${report.nearOwner.avgMoveM} / 시야off 기준선 ${visionOff.nearOwner.bigReversalPer100} · ${visionOff.nearOwner.avgMoveM})`, () => {
    expect(report.nearOwner.bigReversalPer100).toBeLessThanOrEqual(20);
    expect(report.nearOwner.avgMoveM).toBeLessThanOrEqual(3);
    // 백스톱이 **대조군 아래로 다시 내려가지 않게** 구조로 묶는다 — 그러면 또 다른 것을 재게 된다.
    expect(20).toBeGreaterThanOrEqual(visionOff.nearOwner.bigReversalPer100 * 0.9);
  });

  it("시야 계층은 켜진 채여야 한다 — 진동 해소가 시야 롤백으로 달성되면 안 된다", () => {
    expect(defaultEngineConfig.vision.enabled).toBe(true);
    expect(defaultEngineConfig.vision.markReach).toBeGreaterThan(0);
  });
});
