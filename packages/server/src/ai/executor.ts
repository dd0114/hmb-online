import type { AiJob } from "./protocol.js";
import { stubExecutor } from "./executors/stub.js";

/**
 * AI 실행 추상화(워커 내부) — "AI 가 도는 방식"을 갈아끼우는 지점.
 * 산출은 raw(unknown) 로만 반환하고, 검증 게이트(kinds.ts)는 executor 무관 공통.
 * 구현체: stub(결정론·오프라인) / claude-code(정액제 구독 세션+서브에이전트, W2 #34) /
 * (예비) anthropic-api(메터드 폴백 — 구독 캡 대응).
 */
export interface AiExecutor {
  /** 식별자(결과 meta·로그에 기록). 예: "stub", "claude-code:sonnet". */
  readonly name: string;
  execute(job: AiJob): Promise<unknown>;
}

/** env 로 executor 선택. AI_EXECUTOR=stub|claude-code (기본 stub — 키/로그인 0으로 동작). */
export function createExecutor(kind: string = process.env["AI_EXECUTOR"] ?? "stub"): AiExecutor {
  switch (kind) {
    case "stub":
      return stubExecutor();
    case "claude-code":
      throw new Error("claude-code executor 는 W2(#34)에서 구현 — 정액제 구독 세션+서브에이전트");
    default:
      throw new Error(`알 수 없는 AI_EXECUTOR: ${kind}`);
  }
}
