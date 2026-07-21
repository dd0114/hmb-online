import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import { measureSynchrony } from "./synchrony";

/**
 * 동기 이동 재현 계약 (#147, §2.5 E2E-TDD — 고치기 전에 버그를 박제한다).
 *
 * hero 지적: "팀이 갑자기 다 같이 동일 방향으로 동일 틱씩 움직인다".
 * 그 현상을 measureSynchrony 로 수치화해 **스냅샷 골든**으로 고정하고(재현 증빙),
 * 목표 밴드는 `it.fails` 로 박아둔다 — 시야 기반 개인 판단이 들어가면 이 fails 가 통과로 뒤집힌다.
 *
 * 현재(engine@0.16.0) 실측:
 *  - meanR 0.82 / R>0.9 인 팀-틱 57% → 절반 이상의 틱에서 팀 전원이 사실상 같은 방향.
 *  - 병진 비중 65% → 팀 움직임의 2/3 가 강체 평행이동(개별 움직임은 1/3).
 *  - 소유권 전환 후 t+4~t+11 에 R 0.91~0.94 고평탄 → 턴오버마다 ~8틱(=8초) 동기 행진.
 *
 * 원인(진단, #147 코멘트 참조): 소유권 전환이 전원 동시에 공격↔수비 목표식을 갈아치우고,
 * 모든 선수가 지연 없이 공통 팀 형태로 전속 수렴한다. 개별 상대 인지(시야)가 이동 판단에
 * 전혀 반영되지 않아(필드 플레이어 10명 중 압박 담당 1명 제외) 선수를 구분하는 항이 없다.
 */

// 4 시드로 충분(결정론이라 표본 분산 없음, 비용 절감). 골든이므로 시드 목록을 바꾸면 스냅샷도 갱신.
const SEEDS = REALISM_SEEDS.slice(0, 4);
const report = measureSynchrony(defaultEngineConfig, SEEDS);

describe("동기 이동 재현 골든 (#147)", () => {
  it("현 동기 지표를 스냅샷으로 박제한다(회귀·개선 모두 diff 로 드러남)", () => {
    expect(report).toMatchSnapshot();
  });

  it(`소유권 전환 직후 동기 행진이 실재한다 (peak R=${report.postFlipPeak})`, () => {
    // 전환 직후 여러 틱 동안 R 이 0.9 를 넘는 고평탄 구간 = 버그의 지문.
    expect(report.postFlipPeak).toBeGreaterThan(0.9);
    const plateau = report.postFlipR.filter((r) => r > 0.9).length;
    expect(plateau).toBeGreaterThanOrEqual(5);
  });
});

describe("목표 밴드 (#147 W2~W4 완료 시 통과로 뒤집힌다)", () => {
  it.fails(`인플레이 평균 정렬도 R ≤ 0.60 (현재 ${report.meanR})`, () => {
    expect(report.meanR).toBeLessThanOrEqual(0.6);
  });

  it.fails(`전원 같은 방향(R>0.9)인 팀-틱 ≤ 20% (현재 ${report.highRPct}%)`, () => {
    expect(report.highRPct).toBeLessThanOrEqual(20);
  });

  it.fails(`강체 병진 비중 ≤ 45% (현재 ${report.rigidPct}%) — 개별 움직임이 과반이어야`, () => {
    expect(report.rigidPct).toBeLessThanOrEqual(45);
  });

  it.fails(`소유권 전환 후 동기 행진 피크 ≤ 0.80 (현재 ${report.postFlipPeak})`, () => {
    expect(report.postFlipPeak).toBeLessThanOrEqual(0.8);
  });
});
