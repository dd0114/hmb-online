import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * AI 잡 프로토콜 — 이 시스템의 내구 계약(언어중립 JSON).
 * 게임서버는 어떤 AI 가 도는지 모른다: 이 봉투만 지키면 워커(구독 세션·메터드 API·다른 벤더·Java 구현)를
 * 무중단 교체할 수 있다. (에픽 #32 §1 "큐가 곧 인터페이스")
 */

/** AI 판단 종류. 확장 지점(coach → 추후 halftime 개입 등). */
export const AI_JOB_KINDS = ["coach"] as const;
export const AiJobKind = z.enum(AI_JOB_KINDS);
export type AiJobKind = z.infer<typeof AiJobKind>;

/** 큐에 쌓이는 잡. id = promptHash(kind, context) — 멱등키(재시도·중복 방지·결과캐시 키). */
export const AiJob = z.object({
  id: z.string().min(8),
  kind: AiJobKind,
  /** kind 별 페이로드(coach = CoachContext). 워커가 kind 레지스트리로 파싱·검증. */
  context: z.unknown(),
  /** 정보용 타임스탬프(서버 시간) — 시뮬 결정론 영역 아님. */
  enqueuedAt: z.string(),
});
export type AiJob = z.infer<typeof AiJob>;

/** 워커가 내보내는 결과. ok=true 면 output 은 검증 게이트를 통과한 상태. */
export const AiJobResult = z.object({
  id: z.string(),
  kind: AiJobKind,
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  meta: z
    .object({
      executor: z.string().optional(),
      elapsedMs: z.number().optional(),
    })
    .optional(),
});
export type AiJobResult = z.infer<typeof AiJobResult>;

/** 키 정렬 canonical JSON — 같은 내용이면 키 순서와 무관하게 같은 문자열. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`);
  return `{${entries.join(",")}}`;
}

/** 잡 멱등키 = sha256(kind + canonical(context)) 32 hex. 같은 지시=같은 키 → 결과캐시로 AI 호출 스킵. */
export function promptHash(kind: string, context: unknown): string {
  return createHash("sha256").update(`${kind}\n${stableStringify(context)}`).digest("hex").slice(0, 32);
}
