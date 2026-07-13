import type { AiJob } from "./protocol.js";
import { stubExecutor } from "./executors/stub.js";
import { claudeCodeExecutor } from "./executors/claude-code.js";

/**
 * AI 실행 추상화(워커 내부) — "AI 가 도는 방식"을 갈아끼우는 지점.
 * 산출은 raw(unknown) 로만 반환하고, 검증 게이트(kinds.ts)는 executor 무관 공통.
 * 구현체: stub(결정론·오프라인) / claude-code(정액제 구독 CLI, 에픽 #32 옵션 D) /
 * (예비) anthropic-api(메터드 폴백 — 구독 캡 대응).
 */
export interface AiExecutor {
  /** 식별자(결과 meta·로그에 기록). 예: "stub", "claude-code:sonnet". */
  readonly name: string;
  /** attempt.feedback = 이전 검증 실패 사유(워커 재시도 시 전달). */
  execute(job: AiJob, attempt?: { feedback: string }): Promise<unknown>;
}

/** env 로 executor 선택. AI_EXECUTOR=stub|claude-code (기본 stub — 키/로그인 0으로 동작). */
export function createExecutor(kind: string = process.env["AI_EXECUTOR"] ?? "stub"): AiExecutor {
  switch (kind) {
    case "stub":
      return stubExecutor();
    case "claude-code":
      return claudeCodeExecutor();
    default:
      throw new Error(`알 수 없는 AI_EXECUTOR: ${kind}`);
  }
}
