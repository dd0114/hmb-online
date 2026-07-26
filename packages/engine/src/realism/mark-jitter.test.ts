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
  it(`절대 백스톱 — 볼 옆 큰 왕복 ≤ 10/100, 평균 이동 ≤ 2.0 m/tick (현재 ${report.nearOwner.bigReversalPer100} · ${report.nearOwner.avgMoveM})`, () => {
    expect(report.nearOwner.bigReversalPer100).toBeLessThanOrEqual(10);
    expect(report.nearOwner.avgMoveM).toBeLessThanOrEqual(2);
  });

  it("시야 계층은 켜진 채여야 한다 — 진동 해소가 시야 롤백으로 달성되면 안 된다", () => {
    expect(defaultEngineConfig.vision.enabled).toBe(true);
    expect(defaultEngineConfig.vision.markReach).toBeGreaterThan(0);
  });
});
