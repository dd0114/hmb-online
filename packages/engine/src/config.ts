import type { Vec2 } from "@hmb/shared";

/**
 * EngineConfig — 엔진의 모든 튜닝 값(magic number)을 격리하는 데이터드리븐 레이어. (PRD §7-6)
 *
 * 규칙: 엔진 코드 어디에도 상수를 하드코딩하지 않는다. 밸런싱은 이 객체만 바꾼다.
 * 재현 계약: 매치는 특정 `version` 하에서만 100% 동일 재현되므로, config 를 바꾸면
 * version 을 올리고 과거 매치는 그 버전으로 핀(pin)한다. (PRD §7-4)
 */
export interface EngineConfig {
  /** config 버전 태그. MatchLog.configVersion 으로 박제된다. */
  version: string;

  /** 틱 해상도(ms). 1000 = 1초 틱(Tier B). */
  msPerTick: number;
  /** 한 경기 길이(분). 전/후반 각 절반. */
  matchMinutes: number;

  /** 피치 실좌표 크기(m). */
  pitch: { width: number; height: number };
  /** 좌표 모드. Tier B 는 continuous. grid 는 백로그. */
  coordMode: "continuous" | "grid";
  /** grid 모드일 때 셀 크기(m). continuous 면 무시. */
  gridSize?: number;

  /** 고정소수 정수 스케일. 위치·거리·속도는 (실수 × fixedScale) 정수로만 계산. */
  fixedScale: number;

  /** 선수 인식 반경(m) — 이 안의 동료/상대만 지각. */
  perceptionRadius: number;

  /** 속도 모델: pace(0..100)를 m/tick 으로. */
  speed: {
    /** pace=100 일 때 최고 속도(m/tick). */
    maxPerTick: number;
    /** pace=0 일 때 최저 속도(m/tick). */
    minPerTick: number;
    /** 피로 100%일 때 속도 배수(0..1). */
    fatigueFloor: number;
  };

  /** 공 이동 속도(m/tick). */
  ball: {
    passSpeed: number;
    shotSpeed: number;
    /** 굴러가는(주인 없는) 공 감속 배수/틱. */
    looseDecay: number;
  };

  /** 행동 선택 기본 성향 계수(볼 소유자). behavior 로 가중. */
  decisionWeights: {
    pass: number;
    dribble: number;
    shoot: number;
    hold: number;
  };

  /** 경합 확률 기본치. (ESMS/xG 참고) */
  contest: {
    /** 패스 성공 기준선(0..1). passing 속성으로 가감. */
    passBase: number;
    /** 레인 수비수의 인터셉트 기준선. */
    interceptBase: number;
    /** 태클 성공 기준선. */
    tackleBase: number;
    /** 슛 기대득점(xG) 기준선. */
    xgBase: number;
    /** 슛 시도 가능한 최대 사거리(m, 상대 골대 기준). */
    shootRange: number;
    /** 각도 페널티 계수(중앙에서 벗어날수록 xG 감소). */
    shootAngleFactor: number;
    /** 거리 페널티 계수(멀수록 xG 감소). */
    shootDistanceFactor: number;
    /** 볼 주인을 태클할 수 있는 접근 거리(m). */
    tackleRange: number;
    /** 비행 중 패스를 가로챌 수 있는 거리(m). */
    interceptRange: number;
    /** 도착·루즈볼을 잡을 수 있는 컨트롤 거리(m). */
    controlRange: number;
  };

  /** 극단 behavior(0 또는 1 근처)에 주는 소프트캡 페널티 계수. */
  softCap: number;

  /** 틱당 기본 피로 증가(0..1 스케일). 질주/압박 시 가중. */
  fatiguePerTick: number;

  /** 오프더볼/수비 움직임 튜닝. */
  movement: {
    /** 공격 시 전방 런 최대 전진량(정규화 x, 0..1). forwardRunFreq 로 가중. */
    forwardRunReach: number;
    /** 폭 벌림 최대량(정규화 y 편차). widthTendency 로 가중. */
    widthReach: number;
    /** 수비 라인 유지 강도(base 로 복귀하는 비율). */
    lineDiscipline: number;
    /** 압박 발동 거리(m) — 볼과 이 거리 안이면 압박 런. */
    pressRange: number;
    /** 마크 시 상대 뒤쪽으로 붙는 간격(m). */
    markGap: number;
    /** 볼 소유팀이 공을 향해 지원 오는 최대 당김(정규화). */
    supportPull: number;
  };

  /** 포메이션 정규화 슬롯(0..1, 공격 방향 +x 프레임). 최소 4-3-3 정의. */
  formations: Record<string, Vec2[]>;
}

/**
 * 4-3-3 정규화 슬롯. x=진행방향(0:자기골, 1:상대골), y=폭(0:좌, 1:우).
 * 홈은 그대로, 어웨이는 엔진에서 x 를 미러(1-x)한다.
 */
const formation433: Vec2[] = [
  { x: 0.05, y: 0.5 }, // GK
  { x: 0.2, y: 0.16 }, // LB
  { x: 0.18, y: 0.38 }, // LCB
  { x: 0.18, y: 0.62 }, // RCB
  { x: 0.2, y: 0.84 }, // RB
  { x: 0.42, y: 0.3 }, // LCM
  { x: 0.4, y: 0.5 }, // CM
  { x: 0.42, y: 0.7 }, // RCM
  { x: 0.72, y: 0.18 }, // LW
  { x: 0.76, y: 0.5 }, // ST
  { x: 0.72, y: 0.82 }, // RW
];

/** 기본 EngineConfig. 밸런싱은 이 값만 조정한다. */
export const defaultEngineConfig: EngineConfig = {
  version: "engine@0.1.0",
  msPerTick: 1000,
  matchMinutes: 90,
  pitch: { width: 105, height: 68 },
  coordMode: "continuous",
  gridSize: 5,
  fixedScale: 1000,
  perceptionRadius: 30,
  speed: {
    maxPerTick: 7.0, // ~7 m/s 질주
    minPerTick: 3.0,
    fatigueFloor: 0.55,
  },
  ball: {
    passSpeed: 18,
    shotSpeed: 26,
    looseDecay: 0.82,
  },
  decisionWeights: {
    pass: 0.55,
    dribble: 0.32,
    shoot: 0.22,
    hold: 0.26,
  },
  contest: {
    passBase: 0.72,
    interceptBase: 0.28,
    tackleBase: 0.3,
    xgBase: 0.14,
    shootRange: 24,
    shootAngleFactor: 0.6,
    shootDistanceFactor: 0.04,
    tackleRange: 2.0,
    interceptRange: 1.8,
    controlRange: 2.5,
  },
  softCap: 0.25,
  fatiguePerTick: 0.0009,
  movement: {
    forwardRunReach: 0.18,
    widthReach: 0.12,
    lineDiscipline: 0.5,
    pressRange: 22,
    markGap: 2.5,
    supportPull: 0.14,
  },
  formations: {
    "4-3-3": formation433,
  },
};
