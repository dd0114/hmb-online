import type { AiJob } from "./protocol.js";
import { stubExecutor } from "./executors/stub.js";
import { claudeCodeExecutor } from "./executors/claude-code.js";
import { withRetry, withFallback } from "./executors/resilience.js";
import type { JobUsage } from "./metrics.js";

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

/** executor 배선 옵션(W3 AC1: L2 usage 콜백을 claude-code 에 연결). */
export interface ExecutorOptions {
  onUsage?: (usage: JobUsage, jobId: string, model: string) => void;
}

/** env 로 executor 선택. AI_EXECUTOR=stub|claude-code (기본 stub — 키/로그인 0으로 동작). */
export function createExecutor(
  kind: string = process.env["AI_EXECUTOR"] ?? "stub",
  opts: ExecutorOptions = {},
): AiExecutor {
  switch (kind) {
    case "stub":
      return stubExecutor();
    case "claude-code":
      return claudeCodeExecutor({ onUsage: opts.onUsage });
    default:
      throw new Error(`알 수 없는 AI_EXECUTOR: ${kind}`);
  }
}

/**
 * 운영용 executor 조립(W3 AC4): primary + (선택) 폴백 + 백오프 재시도.
 * env — AI_EXECUTOR(primary) · AI_FALLBACK_EXECUTOR(캡/장애 시 무중단 스위치, 예: stub) ·
 *       AI_MAX_RETRIES(기본 2, 0=끔) · AI_RETRY_BASE_MS(기본 500).
 * 큐 프로토콜 덕에 잡은 큐에 남아, 이 조립만 바꿔도(재기동) 무중단으로 소진된다.
 */
export function createResilientExecutor(opts: ExecutorOptions = {}): AiExecutor {
  const primaryKind = process.env["AI_EXECUTOR"] ?? "stub";
  const fallbackKind = process.env["AI_FALLBACK_EXECUTOR"];
  const retries = Number(process.env["AI_MAX_RETRIES"] ?? 2);
  const baseDelayMs = Number(process.env["AI_RETRY_BASE_MS"] ?? 500);

  let ex = createExecutor(primaryKind, opts);
  if (fallbackKind && fallbackKind !== primaryKind) {
    const fallback = createExecutor(fallbackKind, opts);
    ex = withFallback(ex, fallback, (e) =>
      console.warn(`[ai-worker] primary 실패 → ${fallbackKind} 폴백:`, e instanceof Error ? e.message : e),
    );
  }
  if (retries > 0) {
    ex = withRetry(ex, {
      retries,
      baseDelayMs,
      onRetry: (attempt, delay, e) =>
        console.warn(`[ai-worker] 일시장애 재시도 ${attempt}/${retries} (${delay}ms 후):`, e instanceof Error ? e.message : e),
    });
  }
  return ex;
}
