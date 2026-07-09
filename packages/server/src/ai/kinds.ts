import type { z } from "zod";
import type { AiJobKind } from "./protocol.js";
import { CoachContext, validateCoachOutput } from "../coach.js";

/**
 * kind 레지스트리 — AI 판단 종류별 (컨텍스트 스키마, 검증 게이트).
 * 워커는 executor(AI 구현)와 무관하게 이 레지스트리로 잡을 파싱·검증한다.
 * 새 AI 판단 추가 = kind 하나 등록(프로토콜/큐/워커 불변).
 */
export interface KindSpec {
  contextSchema: z.ZodTypeAny;
  /** executor 산출(raw) → 검증·클램프된 output. 실패 시 throw(워커가 failed 처리). */
  validate(raw: unknown, context: unknown): unknown;
}

export const KINDS: Record<AiJobKind, KindSpec> = {
  coach: {
    contextSchema: CoachContext,
    validate: (raw, context) => validateCoachOutput(raw, CoachContext.parse(context).prefix),
  },
};
