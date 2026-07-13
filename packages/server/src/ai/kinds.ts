import type { z } from "zod";
import type { AiJobKind } from "./protocol.js";
import { CoachContext, validateCoachOutput, tacticalJsonSchema, buildCoachPrompt } from "../coach.js";

/**
 * kind 레지스트리 — AI 판단 종류별 (컨텍스트 스키마 · JSON 스키마 · 프롬프트 · 검증 게이트).
 * executor(AI 구현)는 kind 를 모른 채 이 레지스트리로 프롬프트/스키마를 얻고, 워커는 validate 로
 * 게이트한다. 새 AI 판단 추가 = kind 하나 등록(프로토콜/큐/워커/executor 불변).
 */
export interface KindSpec {
  /** AiJob.context 형태 검증. */
  contextSchema: z.ZodTypeAny;
  /** 구조화 출력(claude --json-schema)용 JSON Schema. */
  jsonSchema(): Record<string, unknown>;
  /** executor 가 AI 에 넘길 프롬프트(feedback=재시도 사유). */
  buildPrompt(context: unknown, feedback?: string): string;
  /** executor 산출(raw) → 검증·클램프된 output. 실패 시 throw(워커가 재시도/failed 처리). */
  validate(raw: unknown, context: unknown): unknown;
}

export const KINDS: Record<AiJobKind, KindSpec> = {
  coach: {
    contextSchema: CoachContext,
    jsonSchema: tacticalJsonSchema,
    buildPrompt: (context, feedback) => buildCoachPrompt(CoachContext.parse(context), feedback),
    validate: (raw, context) => validateCoachOutput(raw, CoachContext.parse(context).prefix),
  },
};
