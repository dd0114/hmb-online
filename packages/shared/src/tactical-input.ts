import { z } from "zod";
import { Vec2 } from "./vec.js";

/**
 * TacticalInput — 방식1(AI=인풋 사전생성)의 직렬화 계약. (PRD §6-1)
 * AI 가 자연어 프롬프트에서 생성하는 "선수별 행동 파라미터" 세트이자,
 * 결정론 공간 엔진의 입력이며 Phase 3 PvP 의 네트워크 페이로드다.
 *
 * seed 는 uint64 를 안전하게 표현하기 위해 문자열(10진수)로 둔다 (R8 결정).
 */

/** 선수 개별 행동 파라미터 (0..1, 값이 클수록 그 성향이 강함). */
export const PlayerBehavior = z.object({
  positioningFreedom: z.number(), // roam — 위치 이탈 정도
  forwardRunFreq: z.number(), // 침투(오프더볼 전진 런) 빈도
  widthTendency: z.number(), // 사이드로 벌림(풀백 오버랩)
  supportDepth: z.number(), // 공격 가담 깊이
  pressAggression: z.number(), // 개인 압박 적극성
  passRisk: z.number(),
  passDirectness: z.number(),
  dribbleTendency: z.number(),
  shootTendency: z.number(),
});
export type PlayerBehavior = z.infer<typeof PlayerBehavior>;

export const Duty = z.enum(["defend", "support", "attack"]);
export type Duty = z.infer<typeof Duty>;

export const PlayerInput = z.object({
  playerId: z.string(),
  role: z.string(),
  duty: Duty,
  /** 포메이션 슬롯. 정규화 좌표(0..1). */
  basePosition: Vec2,
  behavior: PlayerBehavior,
  /** 전담 마크 대상(상대 playerId). */
  markTarget: z.string().optional(),
  /** 팀톡·사기 반영. -1..+1 */
  mentalModifier: z.number(),
});
export type PlayerInput = z.infer<typeof PlayerInput>;

export const TeamInput = z.object({
  formation: z.string(), // "4-3-3" 등
  defensiveLineHeight: z.number(), // 0..1
  compactness: z.number(), // 0..1
  tempo: z.number(), // 0..1
  width: z.number(), // 0..1
  pressingScheme: z.object({
    intensity: z.number(), // 0..1
    triggerLine: z.number(), // 0..1 (어디서부터 압박)
  }),
  offsideTrap: z.boolean(),
});
export type TeamInput = z.infer<typeof TeamInput>;

export const TacticalInput = z.object({
  /** 결정론 시드. uint64 를 10진 문자열로 (BigInt-safe). */
  seed: z.string(),
  team: TeamInput,
  players: z.array(PlayerInput),
  meta: z
    .object({
      generatedAt: z.string().optional(),
      promptHash: z.string().optional(),
    })
    .optional(),
});
export type TacticalInput = z.infer<typeof TacticalInput>;
