import type { AiExecutor } from "../executor.js";
import type { ExecutorJob } from "../kinds.js";

/**
 * 회복력 데코레이터(구 #32 W3 AC4 자산 이관) — 구독 캡·일시장애 대응.
 * executor 추상화 위에 얹어 "AI 가 도는 방식" 을 무중단으로 지킨다:
 *  - withRetry: CAP/TIMEOUT(일시적) 은 지수 백오프로 N 회 재시도. AUTH/OUTPUT(영구) 는 즉시 전파.
 *  - withFallback: primary 가 CAP/TIMEOUT 로 죽으면 fallback executor 로 넘긴다(메터드/stub).
 * Java 잡 큐(lease/재배포) 덕에 잡은 큐에 남아, executor 만 바꿔도 무중단으로 소진된다.
 */

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 일시적(재시도/폴백 가치 있음) 실패 = CAP(캡·레이트리밋) · TIMEOUT. AUTH/OUTPUT/VALIDATE 는 영구. */
export function isTransient(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /^(CAP|TIMEOUT):/.test(m);
}

export interface RetryOptions {
  retries?: number; // 추가 시도 횟수(총 시도 = retries+1). 기본 2.
  baseDelayMs?: number; // 첫 백오프. 기본 500. 이후 2배씩(500→1000→2000…).
  maxDelayMs?: number; // 백오프 상한. 기본 30000.
  sleep?: (ms: number) => Promise<void>; // 주입(테스트 = 즉시). 기본 실제 대기.
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/** CAP/TIMEOUT 에 지수 백오프 재시도. 영구 실패·마지막 시도 실패는 그대로 throw. */
export function withRetry(inner: AiExecutor, opts: RetryOptions = {}): AiExecutor {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? sleepReal;

  return {
    name: `retry(${inner.name})`,
    async execute(job: ExecutorJob, attempt?: { feedback: string }): Promise<unknown> {
      let lastErr: unknown;
      for (let i = 0; i <= retries; i++) {
        try {
          return await inner.execute(job, attempt);
        } catch (e) {
          lastErr = e;
          if (!isTransient(e) || i === retries) throw e; // 영구 실패 or 마지막 시도 → 전파
          const delay = Math.min(baseDelayMs * 2 ** i, maxDelayMs);
          opts.onRetry?.(i + 1, delay, e);
          await sleep(delay);
        }
      }
      throw lastErr; // 도달 불가(루프가 항상 return/throw)
    },
  };
}

/**
 * primary 가 일시적(CAP/TIMEOUT)으로 실패하면 fallback executor 로 스위치.
 * 운영자가 구독 캡을 만났을 때 메터드 API 나 stub 으로 무중단 전환하는 지점(구 #32 §리스크).
 */
export function withFallback(
  primary: AiExecutor,
  fallback: AiExecutor,
  onFallback?: (error: unknown, job: ExecutorJob) => void,
): AiExecutor {
  return {
    name: `${primary.name}→${fallback.name}`,
    async execute(job: ExecutorJob, attempt?: { feedback: string }): Promise<unknown> {
      try {
        return await primary.execute(job, attempt);
      } catch (e) {
        if (!isTransient(e)) throw e; // 영구 실패는 폴백해도 소용없음
        onFallback?.(e, job);
        return await fallback.execute(job, attempt);
      }
    },
  };
}
