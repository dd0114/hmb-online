/**
 * 지연 스텁 실행기 (#193 W1 계측 전용) — 실 AI 지연을 결정론으로 재현해 **큐 순서·오케스트레이션**
 * 효과를 AI 비용 0으로 측정한다. 프로덕션 배선(ExecutorLoop + Java 잡 프로토콜)은 그대로 쓰고
 * executor 만 "stub + 고정 지연" 으로 감싼다.
 *
 * env: JAVA_URL · SERVANT_TOKEN · AI_CONCURRENCY(기본 1 = 배포 현행) ·
 *      MEASURE_DELAY_FULL_MS(기본 150000 = 실측 team-input p50 근사) ·
 *      MEASURE_DELAY_PATCH_MS(기본 12000 = 실측 team-input-patch 근사)
 * 잡 픽업/완료 시각을 stderr 에 한 줄씩 찍어 큐 순서를 관찰한다.
 */
import { JavaClient } from "../src/executor/java-client.js";
import { ExecutorLoop } from "../src/executor/executor-main.js";
import { stubExecutor } from "../src/executor/executors/stub.js";
import type { AiExecutor } from "../src/executor/executor.js";
import type { ExecutorJob } from "../src/executor/kinds.js";

const FULL_MS = Number(process.env["MEASURE_DELAY_FULL_MS"] ?? 150_000);
const PATCH_MS = Number(process.env["MEASURE_DELAY_PATCH_MS"] ?? 12_000);
const t0 = Date.now();
const stamp = (): string => `${String(Date.now() - t0).padStart(7)}ms`;

const stub = stubExecutor();
const delayed: AiExecutor = {
  name: `delay-stub(full=${FULL_MS}ms,patch=${PATCH_MS}ms)`,
  async execute(job: ExecutorJob, attempt?: { feedback: string }): Promise<unknown> {
    const ms = job.kind === "team-input-patch" ? PATCH_MS : FULL_MS;
    const ctx = job.context as { matchId?: string; side?: string; half?: number };
    console.error(
      `[${stamp()}] START  job=${job.id.slice(0, 8)} kind=${job.kind} match=${String(ctx.matchId).slice(0, 10)} side=${ctx.side ?? "-"} half=${ctx.half ?? "-"} delay=${ms}ms`,
    );
    await new Promise((r) => setTimeout(r, ms));
    const out = await stub.execute(job, attempt);
    console.error(`[${stamp()}] DONE   job=${job.id.slice(0, 8)} kind=${job.kind}`);
    return out;
  },
};

const client = new JavaClient({
  baseUrl: process.env["JAVA_URL"] ?? "http://127.0.0.1:8082",
  token: process.env["SERVANT_TOKEN"] ?? "",
  workerId: process.env["AI_WORKER_ID"] ?? `measure-slow-${process.pid}`,
});
const loop = new ExecutorLoop(client, delayed, {
  concurrency: Number(process.env["AI_CONCURRENCY"] ?? 1),
  pollWaitMs: 25_000,
});
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());
console.error(`[${stamp()}] delay-stub 기동 concurrency=${process.env["AI_CONCURRENCY"] ?? 1}`);
void loop.run(stop.signal);
