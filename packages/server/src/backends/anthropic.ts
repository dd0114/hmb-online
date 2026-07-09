import Anthropic from "@anthropic-ai/sdk";
import { COACH_SYSTEM, tacticalJsonSchema, type CoachRequest } from "../coach.js";
import type { CoachBackend } from "../coach-backend.js";

const TOOL_NAME = "set_tactical_input";
/** 기본 모델 — sonnet(컨텍스트 이해). 테스트/튜닝 시 opts.model 또는 env COACH_MODEL 로 교체. */
export const DEFAULT_COACH_MODEL = "claude-sonnet-5";

export interface AnthropicCoachOptions {
  /** 모델(기본 claude-sonnet-5). env COACH_MODEL 로도 지정 가능. */
  model?: string;
  /** Anthropic 클라이언트 주입(테스트/모의). 미지정 시 자격증명 자동 해석(API 키 또는 구독 프로필). */
  client?: Anthropic;
  /** system+roster 프롬프트 캐싱(cache_control) 사용. 기본 true. */
  cache?: boolean;
  maxTokens?: number;
}

/**
 * Anthropic 백엔드 — Claude(기본 sonnet) tool-use 로 JSON 강제 + 안정 프리픽스(system+schema+roster) 캐싱.
 * 인증: `ANTHROPIC_API_KEY`(메터드) 또는 미설정 시 `claude login`/`ant auth` 구독 프로필(정액제).
 */
export function anthropicCoachBackend(opts: AnthropicCoachOptions = {}): CoachBackend {
  const model = opts.model ?? process.env["COACH_MODEL"] ?? DEFAULT_COACH_MODEL;
  const useCache = opts.cache ?? true;
  const maxTokens = opts.maxTokens ?? 4096;
  const tool: Anthropic.Tool = {
    name: TOOL_NAME,
    description: "감독 지시를 반영한 팀 전술 입력(TacticalInput). behavior·team 수치 0..1, mentalModifier -1..1.",
    input_schema: tacticalJsonSchema() as Anthropic.Tool.InputSchema,
  };

  return {
    name: `anthropic:${model}`,
    async generate(req: CoachRequest): Promise<unknown> {
      const client = opts.client ?? new Anthropic();
      // 안정 프리픽스(tools+system+roster) 를 캐시 → directive 만 매번 바뀌게(캐시 극대화).
      const rosterText = `팀 로스터/포메이션:\n${req.rosterContext}`;
      const rosterBlock: Anthropic.TextBlockParam = useCache
        ? { type: "text", text: rosterText, cache_control: { type: "ephemeral" } }
        : { type: "text", text: rosterText };
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: COACH_SYSTEM }, rosterBlock],
        messages: [{ role: "user", content: `seed: ${req.seed}\n\n감독 지시:\n${req.directive}` }],
        tools: [tool],
        tool_choice: { type: "tool", name: TOOL_NAME },
      });
      const block = res.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        throw new Error(`AI(${model}) 가 ${TOOL_NAME} tool 을 호출하지 않음`);
      }
      return block.input;
    },
  };
}
