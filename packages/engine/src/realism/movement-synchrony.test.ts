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
 * ## W2(engine@0.17.0) 가 실제로 고친 것 = **이산 동시전환(lockstep)**, 행진이 아니다
 * 로밍 시드 노이즈가 `floor(tick/25)` 계단식이라 버킷 안 25틱 동안 오프셋이 상수였고
 * (틱별 개인 움직임 기여 0), 경계에서 전 선수가 **같은 틱에 동시에** 방향을 틀었다 —
 * 변주 기능이 사실상 죽어 있던 결함. 연속 보간 + idHash 위상으로 복구.
 *  → **lockstepPct(전원이 *정확히* 같은 방향인 팀-틱) 40.89% → 19.92%** (독립 QA 가
 *    R=1.00 스파이크 소멸로 육안 확인).
 *  → 반면 **weightedR 0.825→0.823 · bigMoveR 0.843→0.838 · peak 0.94→0.95 는 무변**.
 *    즉 관객이 보는 "블록 행진" 자체는 그대로다. 이 구분은 검증 세션이 초판 지표의 표본구성
 *    아티팩트를 반증하면서 드러났다(초판 단위 R 은 0.823→0.729 로 개선처럼 보였으나, 그 값의
 *    변화는 "완전정지 → 초당 5~25cm 표류"라는 렌더 2px 미만의 변화가 만든 것이었다).
 *    지표 설계 경위는 synchrony.ts 헤더 참조.
 *
 * 남은 행진(weightedR·rigidPct·peak)은 W3(시야 인지)·W4(시야 기반 개인 이동)의 몫이다.
 */

// 4 시드로 충분(결정론이라 표본 분산 없음, 비용 절감). 골든이므로 시드 목록을 바꾸면 스냅샷도 갱신.
const SEEDS = REALISM_SEEDS.slice(0, 4);
const report = measureSynchrony(defaultEngineConfig, SEEDS);

describe("동기 이동 골든 (#147)", () => {
  it("현 동기 지표를 스냅샷으로 박제한다(회귀·개선 모두 diff 로 드러남)", () => {
    expect(report).toMatchSnapshot();
  });

  it(`W2 성과 래칫: 완전 동조(lockstep) ≤ 25% (측정 ${report.lockstepPct}%, W1 기준선 40.89%)`, () => {
    // W2 가 **실제로** 없앤 것 = 계단식 노이즈의 이산 동시전환. 그 성과만 지킨다.
    // (블록 행진은 아직 못 고쳤으므로 여기서 지키지 않는다 — 아래 it.fails 가 그 계약.)
    expect(report.lockstepPct).toBeLessThanOrEqual(25);
  });

  it(`블록 행진은 아직 미해결임을 명시적으로 박제 (weightedR ${report.weightedR})`, () => {
    // 이 테스트는 "아직 안 고쳐졌다"를 사실로 고정한다. W3/W4 로 실제 개선되면
    // 여기가 실패하고, 그때 아래 it.fails 들과 함께 계약을 뒤집는다(진전의 신호).
    expect(report.weightedR).toBeGreaterThan(0.6);
    expect(report.postFlipPeak).toBeGreaterThan(0.8);
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
