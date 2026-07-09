import type { CoachRequest } from "./coach.js";

/**
 * AI 백엔드 추상화 — "AI 가 도는 방식"의 인터페이스. 나중에 다른 AI/transport(구독 워커·다른 프로바이더·
 * 모델 교체)로 갈아끼운다. 각 백엔드는 raw 산출물만 반환하고, 검증/가드레일(validateCoachOutput)은
 * 백엔드 무관 공통(coach.ts)이 처리한다.
 */
export interface CoachBackend {
  /** 백엔드 식별(로그·캐시 키에 사용). 예: "anthropic:claude-sonnet-5", "stub". */
  readonly name: string;
  /** directive+roster → TacticalInput 형태의 raw 객체(검증 전). */
  generate(req: CoachRequest): Promise<unknown>;
}
