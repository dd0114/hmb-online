import { zodToJsonSchema } from "zod-to-json-schema";
import { TacticalInput, clampTacticalInput } from "@hmb/shared";
import type { CoachBackend } from "./coach-backend.js";

/** 감독 자연어 지시 → 팀 전술 입력(TacticalInput) 변환 요청. */
export interface CoachRequest {
  /** 감독 자연어 지시(예: "양 풀백 오버랩, 와이드, 하이라인, 강한 압박"). */
  directive: string;
  /** 팀 로스터·포메이션 컨텍스트(선수 ID·역할·슬롯) — 프롬프트에 주입. */
  rosterContext: string;
  /** 결정론 시드(10진 문자열). */
  seed: string;
  /** 팀 prefix (홈="H", 어웨이="A"). 산출 playerId 검증에 사용. */
  prefix: string;
}

/** 코치 시스템 프롬프트(고정, 백엔드 무관). */
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
 * TacticalInput(zod v3) → JSON Schema(generic). 백엔드가 tool input_schema/structured output 으로 JSON 강제.
 * SDK zod helper 는 zod v4 요구 → 계약(shared)은 v3 유지, 스키마만 변환.
 */
export function tacticalJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(TacticalInput, { $refStrategy: "none" }) as Record<string, unknown>;
  delete raw["$schema"];
  return raw;
}

/**
 * AI 산출 raw → zod 검증 + sanity(11명·prefix) + 가드레일(clampTacticalInput).
 * 순수 함수(테스트 가능, 키·백엔드 무관). AI 산출물의 안전 게이트.
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
  return clampTacticalInput(parsed); // 모든 수치 유효 범위로 클램프
}

/**
 * 프롬프트 → TacticalInput (방식1 핵심). AI 실행은 주입된 `backend`(CoachBackend 인터페이스)가 담당 —
 * anthropic(sonnet 등)·stub·다른 AI 로 교체 가능. 가드레일(validateCoachOutput)은 백엔드 무관 공통.
 */
export async function promptToTacticalInput(req: CoachRequest, backend: CoachBackend): Promise<TacticalInput> {
  const raw = await backend.generate(req);
  return validateCoachOutput(raw, req.prefix);
}
