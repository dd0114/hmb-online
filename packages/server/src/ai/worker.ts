import type { JobQueue } from "./queue.js";
import type { ResultCache } from "./cache.js";
import type { AiExecutor } from "./executor.js";
import type { AiJobResult } from "./protocol.js";
import { KINDS } from "./kinds.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
      const raw = await this.executor.execute(job); // AI 실행(추상화)
      const output = spec.validate(raw, job.context); // 검증 게이트(가드레일) — executor 무관
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
        error: e instanceof Error ? e.message : String(e),
        meta: { executor: this.executor.name, elapsedMs: Date.now() - started },
      };
    }
    await this.queue.complete(result);
    return true;
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
