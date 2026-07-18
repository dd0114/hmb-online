import type { TeamSide, PlayerAttributes } from "@hmb/shared";
import type { PlayerBehavior, Duty, TeamInput } from "@hmb/shared";

/**
 * simstate — 엔진 내부 시뮬 상태 타입(직렬화 계약 아님, 엔진 전용).
 * 좌표·속도는 모두 고정소수 정수(fixed). posFx 등의 값은 EngineConfig.fixedScale 스케일.
 */

/** 시뮬 내부 선수 상태. */
export interface SimPlayer {
  id: string;
  side: TeamSide;
  role: string;
  duty: Duty;
  behavior: PlayerBehavior;
  markTarget?: string;
  mentalModifier: number;
  attrs: PlayerAttributes;
  /** 역할 기본 위치(실좌표 fixed, 미러 반영 완료). */
  baseFx: { x: number; y: number };
  /** 현재 위치(fixed). */
  posFx: { x: number; y: number };
  /** 이번 틱 목표 위치(fixed). */
  targetFx: { x: number; y: number };
  /** 피로 0..1. 클수록 느려짐. */
  fatigue: number;
  isGK: boolean;
  /** id 의 결정론 해시(오프더볼 시드 노이즈용, 초기화 시 1회 계산). */
  idHash: number;
  /** 연속 드리블 틱 수(드리블 체인 모멘텀용). 소유 상실/비드리블 시 0. */
  dribbleStreak: number;
  /** 받은 옐로카드 수(2장 누적 시 퇴장). */
  yellowCards: number;
}

/** 공 비행 상태(패스/슛/루즈볼). */
export interface BallFlight {
  toX: number;
  toY: number;
  /** 이동 속도(fixed m/tick). */
  speed: number;
  kind: "pass" | "shot" | "loose";
  /** 패스 의도 수신자 playerId. */
  target?: string;
  /** 공을 찬 팀. */
  fromSide: TeamSide;
  /** 슛을 쏜 xG(이벤트 기록용). */
  xg?: number;
  /** 패스 계획 결과: 성공/인플레이 턴오버/아웃오브바운즈. (성공률 결정론 제어) */
  passOutcome?: "success" | "fail_intercept" | "fail_out";
}

/**
 * shot_out 정지 종료 시 이어질 재시작 명령(코너킥 or 골킥).
 * 슛(세이브 굴절/빗맞음)이 아웃되면 공을 골문 프레임(키퍼/포스트 옆)에 먼저 두고 짧게 정지한 뒤,
 * 이 명령으로 실제 세트피스(공이 코너 깃발/골킥 스팟에 놓이는 단계)를 시작한다.
 */
export type DeferredRestart =
  | { kind: "corner"; side: TeamSide; nearY: number }
  | { kind: "goal_kick"; side: TeamSide }
  // 박스 파울 → 공을 접촉 지점에 두는 "파울 비트" 정지 후 페널티 스팟 배치+런업(2단계, 코너 패턴).
  | { kind: "penalty"; side: TeamSide };

/** 진행 중인 세트피스 컨텍스트(정지 동안 재배치에 사용). */
export interface SetPiece {
  /**
   * kind:
   *  - corner/throw_in/goal_kick/kickoff: 일반 세트피스.
   *  - goal: 골 직후 세리머니 정지. 공은 네트에 머물고, 정지가 끝나면 side 팀이 센터 킥오프.
   *  - free_kick: 파울/오프사이드 후 프리킥. side 팀이 재개.
   *  - penalty: 박스 내 파울 후 페널티. 정지가 끝나면 side 팀 테이커가 고xG 슛.
   *  - shot_out: 슛이 세이브 굴절/빗맞음으로 아웃된 직후의 짧은 정지. 공은 골문 프레임
   *    (키퍼 위치 또는 포스트 옆)에 머물고(코너 깃발 직행 금지), 정지가 끝나면 restart
   *    (코너킥/골킥) 세트피스가 시작된다.
   */
  kind: "corner" | "throw_in" | "goal_kick" | "kickoff" | "goal" | "free_kick" | "penalty" | "shot_out";
  /** 재시작(수혜) 팀. goal 이면 킥오프할 실점팀. shot_out 이면 정지 동안 공을 지킨 수비팀. */
  side: TeamSide;
  /** 재시작 지점(fixed). */
  x: number;
  y: number;
  /** shot_out 정지 종료 시 실행할 세트피스(코너/골킥). shot_out 외에는 undefined. */
  restart?: DeferredRestart;
}

/** 공 상태. */
export interface Ball {
  posFx: { x: number; y: number };
  owner: string | null;
  ownerSide: TeamSide | null;
  flight: BallFlight | null;
}

/** 전체 시뮬 상태. */
export interface SimState {
  players: SimPlayer[];
  byId: Map<string, SimPlayer>;
  ball: Ball;
  score: { home: number; away: number };
  possession: TeamSide;
  tick: number;
  /** 매치 시드의 결정론 해시(오프더볼 변주 시드 노이즈용). 재개 시에도 관통. */
  seedHash: number;
  /** 팀 전술 파라미터(라인/압박/폭). 움직임 결정에 사용. */
  teams: { home: TeamInput; away: TeamInput };
  /** 남은 정지(dead ball) 틱. >0 이면 결정/경합/공비행 없이 재배치만. */
  stoppage: number;
  /** 진행 중 세트피스(정지 동안). 없으면 null. */
  setPiece: SetPiece | null;
}
