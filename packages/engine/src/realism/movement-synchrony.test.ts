import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import { REALISM_SEEDS } from "./harness";
import { measureSynchrony } from "./synchrony";

/**
 * 동기 이동 계약 (#147, §2.5 E2E-TDD — 고치기 전에 버그를 박제한다).
 *
 * hero 지적: "팀이 갑자기 다 같이 동일 방향으로 동일 틱씩 움직인다".
 * 현상을 measureSynchrony 로 수치화해 **스냅샷 골든**으로 고정하고, 목표 밴드는 `it.fails` 로
 * 박아둔다 — 시야 기반 개인 판단(W3/W4)이 들어가면 그 fails 가 통과로 뒤집힌다.
 *
 * ## W1 진단(engine@0.16.0)
 * 소유권 전환이 전원 동시에 공격↔수비 목표식을 갈아치우고, 모든 선수가 지연 없이 공통 팀 형태로
 * 전속 수렴한다. 개별 상대 인지(시야)가 이동 판단에 전혀 반영되지 않아(필드 플레이어 10명 중
 * 압박 담당 1명 제외) 선수를 구분하는 항이 없다.
 *
 * ## W2 결과: 시도한 가설 4개 전부 **측정상 효과 없음** → 엔진 동작 변경 없이 종료
 * 로밍 노이즈 연속화·위상 개인화, 전환 반응 지연, 도달 톨러런스, 목표 관성을 각각 구현해 쟀다.
 * 크기 인지 지표(synchrony.ts 참조)로는 **어느 것도 weightedR/bigMoveR/rigidPct/peak 을 움직이지 못했다.**
 * 특히 로밍 연속화는 초판 지표에서 "R 0.823→0.729 개선"으로 보였으나, 그 값의 변화는
 * "완전정지 → 초당 5~25cm 표류"(렌더 2px 미만)라는 표본 구성 변화가 만든 것이었다 —
 * 크기 하한을 걸면 lockstep 25.78%→25.81% 로 **차이가 사라진다**(검증 세션 B1·B5가 반증).
 * 그래서 W2 는 **엔진 동작을 바꾸지 않고 종료**했고, 남은 것은 이 계약과 측정 유틸이다.
 * 실제 해소는 W3(시야 인지)·W4(시야 기반 개인 이동)의 몫 — 상대를 보고 각자 다른 목적지로
 * 움직이는 항이 생겨야 블록 병진을 개인 움직임이 넘어선다.
 */

// 4 시드로 충분(결정론이라 표본 분산 없음, 비용 절감). 골든이므로 시드 목록을 바꾸면 스냅샷도 갱신.
const SEEDS = REALISM_SEEDS.slice(0, 4);
const report = measureSynchrony(defaultEngineConfig, SEEDS);

describe("동기 이동 골든 (#147)", () => {
  it("현 동기 지표를 스냅샷으로 박제한다(회귀·개선 모두 diff 로 드러남)", () => {
    expect(report).toMatchSnapshot();
  });
});

describe("목표 밴드 (#147 W3~W4 완료 시 통과로 뒤집힌다)", () => {
  it.fails(`변위가중 정렬도 weightedR ≤ 0.60 (현재 ${report.weightedR})`, () => {
    expect(report.weightedR).toBeLessThanOrEqual(0.6);
  });

  it.fails(`큰 움직임 정렬도 bigMoveR ≤ 0.65 (현재 ${report.bigMoveR}) — 관객이 보는 질주가 제각각이어야`, () => {
    expect(report.bigMoveR).toBeLessThanOrEqual(0.65);
  });

  it.fails(`강체 병진 비중 ≤ 45% (현재 ${report.rigidPct}%) — 개별 움직임이 과반이어야`, () => {
    expect(report.rigidPct).toBeLessThanOrEqual(45);
  });

  it.fails(`소유권 전환 후 동기 행진 피크 ≤ 0.80 (현재 ${report.postFlipPeak})`, () => {
    expect(report.postFlipPeak).toBeLessThanOrEqual(0.8);
  });
});
