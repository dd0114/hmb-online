import type { JobQueue } from "./queue.js";
import type { ResultCache } from "./cache.js";
import { promptHash, type AiJobKind, type AiJobResult } from "./protocol.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 게임서버 쪽 진입점: 캐시 확인 → 미스면 enqueue. AI 구현은 전혀 모른다(큐 프로토콜만). */
export class AiService {
  constructor(
    private readonly queue: JobQueue,
    private readonly cache: ResultCache,
  ) {}

  /** AI 판단 요청. 결과캐시 히트면 즉시 반환(AI 스킵), 아니면 잡 enqueue. */
  async request(
    kind: AiJobKind,
    context: unknown,
  ): Promise<{ status: "cached"; id: string; output: unknown } | { status: "queued"; id: string }> {
    const id = promptHash(kind, context);
    const hit = await this.cache.get(id);
    if (hit !== null) return { status: "cached", id, output: hit };
    // done 결과가 있으면 캐시 백필 후 반환(캐시 유실 대비).
    const prev = await this.queue.result(id);
    if (prev?.ok && prev.output !== undefined) {
      await this.cache.put(id, prev.output);
      return { status: "cached", id, output: prev.output };
    }
    await this.queue.enqueue({ id, kind, context, enqueuedAt: new Date().toISOString() });
    return { status: "queued", id };
  }

  /** 결과 long-poll. timeout 시 null(호출자가 202 처리). */
  async awaitResult(id: string, timeoutMs: number, pollMs = 150): Promise<AiJobResult | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.queue.result(id);
      if (res) return res;
      if (Date.now() >= deadline) return null;
      await sleep(pollMs);
    }
  }
}
