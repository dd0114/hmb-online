import type { JobQueue } from "./queue.js";
import type { ResultCache } from "./cache.js";
import type { AiExecutor } from "./executor.js";
import type { AiJob, AiJobResult } from "./protocol.js";
import { KINDS, type KindSpec } from "./kinds.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 워커 결과 error 접두어 정규화(에픽 §5). executor 는 이미 접두 → 게이트/기타 실패는 VALIDATE. */
function classifyError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /^(AUTH|CAP|OUTPUT|TIMEOUT|VALIDATE):/.test(m) ? m : `VALIDATE: ${m}`;
}

/**
 * 헤드리스 AI 워커 — 큐 폴링 → executor 실행 → 검증 게이트 → 결과/캐시.
 * executor(AI 구현)와 큐 백엔드 모두 인터페이스 뒤라 교체 자유(에픽 #32 §1).
 */
export class AiWorker {
  constructor(
    private readonly queue: JobQueue,
    private readonly cache: ResultCache,
    private readonly executor: AiExecutor,
  ) {}

  /** 잡 하나 처리. 처리했으면 true(없으면 false). */
  async processOne(): Promise<boolean> {
    const job = await this.queue.claim();
    if (!job) return false;
    const started = Date.now();
    let result: AiJobResult;
    try {
      const spec = KINDS[job.kind];
      spec.contextSchema.parse(job.context); // 컨텍스트 형태 검증
      const output = await this.executeWithGate(job, spec); // AI 실행 + 검증 게이트(+1회 재시도)
      await this.cache.put(job.id, output); // L1 결과캐시 + 재현성 저장
      result = {
        id: job.id,
        kind: job.kind,
        ok: true,
        output,
        meta: { executor: this.executor.name, elapsedMs: Date.now() - started },
      };
    } catch (e) {
      result = {
        id: job.id,
        kind: job.kind,
        ok: false,
        error: classifyError(e),
        meta: { executor: this.executor.name, elapsedMs: Date.now() - started },
      };
    }
    await this.queue.complete(result);
    return true;
  }

  /**
   * executor 실행 → 검증 게이트. 게이트 실패 시 실패 사유를 피드백으로 넣어 **정확히 1회** 재시도.
   * 두 번째도 게이트 실패면 VALIDATE 로 throw. executor 자체 실패(AUTH/CAP/OUTPUT/TIMEOUT)는 재시도 안 함.
   */
  private async executeWithGate(job: AiJob, spec: KindSpec): Promise<unknown> {
    const raw = await this.executor.execute(job); // executor 실패는 그대로 전파(재시도 X)
    try {
      return spec.validate(raw, job.context);
    } catch (ve) {
      const feedback = ve instanceof Error ? ve.message : String(ve);
      const raw2 = await this.executor.execute(job, { feedback }); // 피드백 포함 1회 재시도
      try {
        return spec.validate(raw2, job.context);
      } catch (ve2) {
        throw new Error(`VALIDATE: ${ve2 instanceof Error ? ve2.message : String(ve2)}`);
      }
    }
  }

  /** 큐가 빌 때까지 처리(테스트·인라인용). 처리한 잡 수 반환. */
  async drain(): Promise<number> {
    let n = 0;
    while (await this.processOne()) n++;
    return n;
  }

  /** 상주 폴링 루프(요구: 헤드리스 세션이 큐를 폴링). 기동 시 claimed 복구. */
  async runLoop(pollMs = 1000, signal?: AbortSignal): Promise<void> {
    const recovered = await this.queue.recoverClaimed();
    if (recovered > 0) console.log(`[ai-worker] claimed 복구 ${recovered}건 → pending`);
    console.log(`[ai-worker] executor=${this.executor.name} poll=${pollMs}ms 폴링 시작`);
    while (!signal?.aborted) {
      let did = false;
      try {
        did = await this.processOne();
      } catch (e) {
        console.error(`[ai-worker] 처리 오류:`, e);
      }
      if (!did) await sleep(pollMs);
    }
  }
}
