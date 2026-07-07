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

/** 진행 중인 세트피스 컨텍스트(정지 동안 재배치에 사용). */
export interface SetPiece {
  kind: "corner" | "throw_in" | "goal_kick" | "kickoff";
  /** 재시작(수혜) 팀. */
  side: TeamSide;
  /** 재시작 지점(fixed). */
  x: number;
  y: number;
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
  /** 팀 전술 파라미터(라인/압박/폭). 움직임 결정에 사용. */
  teams: { home: TeamInput; away: TeamInput };
  /** 남은 정지(dead ball) 틱. >0 이면 결정/경합/공비행 없이 재배치만. */
  stoppage: number;
  /** 진행 중 세트피스(정지 동안). 없으면 null. */
  setPiece: SetPiece | null;
}
