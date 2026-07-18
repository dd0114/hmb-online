import type { z } from "zod";
import { TeamInputJobContext, TeamInputPatchJobContext } from "@hmb/shared";
import {
  buildTeamInputPrompt,
  validateTeamInputOutput,
  tacticalJsonSchema,
  buildTeamInputPatchPrompt,
  validateTeamInputPatchOutput,
  tacticalPatchJsonSchema,
} from "../prompt/coach.js";

/**
 * kind 레지스트리 — AI 판단 종류별 (컨텍스트 스키마 · JSON 스키마 · 프롬프트 · 검증 게이트).
 * executor(AI 구현)는 kind 를 모른 채 이 레지스트리로 프롬프트/스키마를 얻고, 폴링 루프는 validate 로
 * 게이트한다. 새 AI 판단 추가 = kind 하나 등록(잡 프로토콜/executor 불변).
 * W1 재편: 파일큐 시대 'coach' → Java 잡 프로토콜의 'team-input'(shared TeamInputJobContext).
 */
export interface KindSpec {
  /** 잡 context 형태 검증. */
  contextSchema: z.ZodTypeAny;
  /** 구조화 출력(claude --json-schema)용 JSON Schema. */
  jsonSchema(): Record<string, unknown>;
  /** executor 가 AI 에 넘길 프롬프트(feedback=재시도 사유). */
  buildPrompt(context: unknown, feedback?: string): string;
  /** executor 산출(raw) → 검증·클램프된 output. 실패 시 throw(루프가 재시도/ok:false 처리). */
  validate(raw: unknown, context: unknown): unknown;
}

export const KINDS = {
  "team-input": {
    contextSchema: TeamInputJobContext,
    jsonSchema: tacticalJsonSchema,
    buildPrompt: (context, feedback) => buildTeamInputPrompt(TeamInputJobContext.parse(context), feedback),
    validate: (raw, context) => validateTeamInputOutput(raw, TeamInputJobContext.parse(context)),
  } satisfies KindSpec,
  // B(패치 생성) — A 위에 벌크 패치를 정적 머지. validate 가 최종 TacticalInput 을 반환(Java 무변경 소비).
  "team-input-patch": {
    contextSchema: TeamInputPatchJobContext,
    jsonSchema: tacticalPatchJsonSchema,
    buildPrompt: (context, feedback) => buildTeamInputPatchPrompt(TeamInputPatchJobContext.parse(context), feedback),
    validate: (raw, context) => validateTeamInputPatchOutput(raw, TeamInputPatchJobContext.parse(context)),
  } satisfies KindSpec,
} as const;

export type AiJobKind = keyof typeof KINDS;

/** executor 가 받는 잡(Java AiJob 에서 id·context 만 추린 실행 단위). kind = context.kind. */
export interface ExecutorJob {
  id: string;
  kind: AiJobKind;
  context: unknown;
}
