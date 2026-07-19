/**
 * 팀 지시 4종의 **5스텝 세그먼트** 매핑 (이슈 #106 R2, hero 확정).
 *
 * 서버 계약(`TeamTactics`)은 **0..1 실수 그대로**다 — 바뀌는 건 입력 위젯뿐이다.
 * 슬라이더(step 0.05)는 폰에서 최악이었고 "높음/보통/낮음"이 전술 언어에 맞다 → 5스텝으로
 * 이산화하고 `0 / .25 / .5 / .75 / 1` 로 매핑한다(해상도 손실은 #106 에서 수용 결정).
 *
 * 서버·프리셋에서 온 임의 실수(예: 0.6)도 표시해야 하므로 `stepIndexOf` 는 **가장 가까운 스텝**으로
 * 스냅해 보여주기만 하고, 값 자체는 사용자가 스텝을 누르기 전까지 바꾸지 않는다(무손실 표시).
 */
import type { TeamTactics } from "../api/v2";
import { TACTICS_LABELS } from "./tactics-logic";

export type TacticsKey = keyof TeamTactics;

/** 5스텝 → 계약값. 인덱스 0..4. */
export const STEP_VALUES = [0, 0.25, 0.5, 0.75, 1] as const;

export const STEP_COUNT = STEP_VALUES.length;

/** 스텝 라벨 — 항목마다 방향 언어가 다르다(라인=높낮이, 폭=좁고넓음 …). */
export const STEP_LABELS: Record<TacticsKey, readonly [string, string, string, string, string]> = {
  line: ["매우낮음", "낮음", "보통", "높음", "매우높음"],
  press: ["매우약함", "약함", "보통", "강함", "매우강함"],
  tempo: ["매우느림", "느림", "보통", "빠름", "매우빠름"],
  width: ["매우좁음", "좁음", "보통", "넓음", "매우넓음"],
};

/** 스텝 인덱스 → 전송값. 범위 밖 인덱스는 클램프. */
export function valueOfStep(index: number): number {
  const i = Math.max(0, Math.min(STEP_COUNT - 1, Math.round(index)));
  return STEP_VALUES[i]!;
}

/** 0..1 실수 → 가장 가까운 스텝 인덱스(표시용 스냅). */
export function stepIndexOf(value: number): number {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  return Math.round(v * (STEP_COUNT - 1));
}

/** 현재 값이 어떤 라벨로 읽히는지 (레일 표시 + 테스트 계약). */
export function stepLabelOf(key: TacticsKey, value: number): string {
  return STEP_LABELS[key][stepIndexOf(value)]!;
}

/** 스크린리더용 전체 라벨: "압박 매우강함". */
export function stepAriaLabel(key: TacticsKey, index: number): string {
  return `${TACTICS_LABELS[key]} ${STEP_LABELS[key][index]}`;
}
