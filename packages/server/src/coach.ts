import { z } from "zod";
import { TacticalInput, clampTacticalInput } from "@hmb/shared";

/**
 * coach — "감독 자연어 지시 → TacticalInput" AI 판단의 kind 정의(방식1 핵심).
 * 여기는 executor(AI 구현) 무관 공통: 컨텍스트 스키마 + 프롬프트 소재 + 검증 게이트.
 */

/** 큐에 실리는 coach 잡 컨텍스트(= AiJob.context). */
export const CoachContext = z.object({
  /** 감독 자연어 지시. 유일한 가변부 — 캐시 프리픽스 밖. */
  directive: z.string().min(1),
  /** 로스터·포메이션 컨텍스트(안정부 — 프롬프트 캐시 프리픽스). */
  rosterContext: z.string().min(1),
  /** 결정론 시드(10진 문자열). */
  seed: z.string().min(1),
  /** 팀 prefix ("H"|"A") — 산출 playerId 검증에 사용. */
  prefix: z.string().min(1),
});
export type CoachContext = z.infer<typeof CoachContext>;

/** 코치 시스템 프롬프트(고정 — 프롬프트 캐시 프리픽스의 일부. W2 executor 가 사용). */
export const COACH_SYSTEM = [
  "너는 축구 게임의 AI 감독이다. 감독의 자연어 지시를 시뮬레이션 엔진의 전술 파라미터(TacticalInput)로 번역한다.",
  "규칙:",
  "- players 는 주어진 로스터의 playerId 를 정확히 그대로 사용한다(11명).",
  "- 모든 behavior 값과 team 수치는 0..1, mentalModifier 는 -1..1 범위.",
  "- basePosition 은 주어진 슬롯을 기본으로 하되 지시에 맞게 조정 가능(x=0 자기 골문→1 상대 골문, y=0..1 좌우 폭).",
  "behavior 의미: forwardRunFreq=오프더볼 전진 침투, widthTendency=측면으로 벌림(풀백/윙어 오버랩), supportDepth=공격 가담 깊이, pressAggression=개인 압박, passRisk=위험 전진패스, passDirectness=직선 패스, dribbleTendency, shootTendency, positioningFreedom=로밍.",
  "감독 지시의 의도를 파라미터로 충실히 반영하라(예: '풀백 오버랩' → 해당 풀백 widthTendency·forwardRunFreq↑; '로우블록' → defensiveLineHeight↓·compactness↑·pressAggression↓).",
].join("\n");

/**
 * 검증 게이트(가드레일) — AI 산출 raw → zod 스키마 검증 + sanity(11명·prefix) + clamp.
 * 어떤 executor(AI)가 만들었든 이 게이트를 통과해야 결과가 된다. 순수 함수.
 */
export function validateCoachOutput(raw: unknown, expectPrefix: string): TacticalInput {
  const parsed = TacticalInput.parse(raw); // zod 스키마 검증(형태·타입)
  if (parsed.players.length !== 11) {
    throw new Error(`선수는 11명이어야 함 (got ${parsed.players.length})`);
  }
  for (const p of parsed.players) {
    if (!p.playerId.startsWith(expectPrefix)) {
      throw new Error(`playerId prefix 불일치: ${p.playerId} (expect ${expectPrefix}*)`);
    }
  }
  return clampTacticalInput(parsed); // 모든 수치를 유효 범위로 클램프
}
