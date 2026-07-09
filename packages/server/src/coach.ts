import type { TacticalInput } from "@hmb/shared";

/** 감독 자연어 지시 → 팀 전술 입력(TacticalInput) 변환 요청. */
export interface CoachRequest {
  /** 감독 자연어 지시(예: "양 풀백 오버랩, 와이드, 하이라인, 강한 압박"). */
  directive: string;
  /** 팀 로스터·포메이션 컨텍스트(선수 ID·역할·슬롯) — 프롬프트에 주입. */
  rosterContext: string;
  /** 결정론 시드(10진 문자열). */
  seed: string;
  /** 팀 prefix (홈="H", 어웨이="A"). */
  prefix: string;
}

/**
 * 프롬프트 → TacticalInput. 이 게임의 핵심(방식1: AI 는 인풋만 사전생성).
 *
 * S3b(서버 트랙)에서 구현: `@anthropic-ai/sdk` 로 Claude(claude-sonnet-5) 호출 →
 * structured output(`zodOutputFormat(TacticalInput)`) 또는 tool-use 로 JSON 강제 →
 * `clampTacticalInput` 가드레일 적용 후 반환. (PoC: packages/engine/poc 가 같은 계약을
 * 서브에이전트로 이미 검증.)
 */
export async function promptToTacticalInput(_req: CoachRequest): Promise<TacticalInput> {
  throw new Error("NOT_IMPLEMENTED: promptToTacticalInput — S3b 서버 트랙에서 Claude API 연결");
}
