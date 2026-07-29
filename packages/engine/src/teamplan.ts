import type { TeamSide } from "@hmb/shared";
import type { EngineConfig } from "./config";
import type { Pitch } from "./pitch";
import type { SimState } from "./simstate";

/**
 * teamplan — **팀 단위 파생 상태**(틱당 1회, 선수 순회 밖에서 계산).
 *
 * 왜 별도 파일인가: `decision.ts` 는 이미 870줄이고, 무엇보다 이 계산은 `decideOffBall` **안에서**
 * 하면 안 된다 — 그 함수는 `state.players` 순회 안에서 불리고 `player.seen` 을 **변이**하므로,
 * 거기서 팀 상태를 만들면 배열 순서 의존이 생긴다(결정론 규율 §5-1). 계산 지점은
 * `match.ts:stepTick` 의 압박 배정 자리(= decide 루프 **앞**, 틱당 1회) 하나뿐이다.
 *
 * ⚠️ **#279 S1 범위**: 지금은 **자리만 만든다**. 필드 값은 "현재 동작을 재현하는 중립값"이고
 * **아무도 소비하지 않는다**(동작 변경 0 이 이 스테이지의 목표). 소비는 S3(수비 구조)에서
 * `decideOffBall` 의 수비 분기를 이 공유 라인으로 갈아끼울 때 시작된다.
 *
 * 규율:
 *  - 순수 함수. `Rng` 를 받지 않는다(= 소비할 수 없다).
 *  - `state.players` 배열 순서에 의존하지 않는다(퇴장이 splice 로 순서를 바꾼다, §5-3).
 *  - 정수 고정소수만. `Math.pow/exp/sin/cos` 금지(§5-4).
 */

/** 한 팀의 이번 틱 계획. */
export interface TeamPlan {
  /**
   * 공유 수비 라인의 x(고정소수 정수).
   *
   * 중립값 = 현재 `decision.ts:decideOffBall` 수비 분기가 **선수마다 중복 계산**하고 있는
   * `blockCenterX` 를 그대로 팀 레벨로 올린 것이다(값·공식 동일 = 동작 변경 0). S3 가
   * "각자 자기 base 에서 16% 보간" 을 "이 라인으로 투영 + 역할별 오프셋" 으로 바꿀 때
   * 여기가 그 라인이 된다.
   */
  lineX: number;
  /**
   * 블록 압축 계수(0.5 + compactness). 중립값 = 현재 수비 분기의 `compact` 와 동일.
   * S3 에서 라인 두께/역할 오프셋 산정의 입력이 된다.
   */
  blockDepth: number;
}

/**
 * `decision.ts` 수비 블록 공식의 팀 레벨 상수 — **여기서 새로 고른 값이 아니라 현행 값의 이관**이다.
 * (원본: `decideOffBall` 의 `lineShift` / `blockCenterX`. S3 에서 decision.ts 가 이 계획을
 *  소비하게 되면 원본 리터럴은 사라지고 여기 하나만 남는다. 그때 config 노브
 *  `movement.lineDiscipline`·`blockLineRangeM` 로 승격된다 — 로드맵 W5-2.)
 */
const LINE_HEIGHT_RANGE = 0.2; // (defensiveLineHeight - 0.5) 가 피치 길이에서 갖는 실권한 폭.
const BLOCK_BEHIND_BALL = 0.06; // 블록 중심을 공보다 자기 골 쪽으로 물리는 기본량(피치 길이 비).

/**
 * `side` 팀의 이번 틱 계획. 순수 함수 — state 를 **변이하지 않는다**(호출부가 `state.plan` 에 담는다).
 */
export function computeTeamPlan(
  state: SimState,
  side: TeamSide,
  config: EngineConfig,
  pitch: Pitch,
): TeamPlan {
  void config; // S1 중립값은 아직 config 노브를 쓰지 않는다(S3 에서 lineDiscipline 등이 들어온다).
  const team = state.teams[side];
  const sign = side === "home" ? 1 : -1;
  const lineShift = (team.defensiveLineHeight - 0.5) * pitch.wFx * LINE_HEIGHT_RANGE;
  const lineX =
    state.ball.posFx.x - sign * Math.round(pitch.wFx * BLOCK_BEHIND_BALL) + sign * Math.round(lineShift);
  return { lineX, blockDepth: 0.5 + team.compactness };
}
