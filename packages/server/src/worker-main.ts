import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FileJobQueue } from "./ai/queue.js";
import { ResultCache } from "./ai/cache.js";
import { AiWorker } from "./ai/worker.js";
import { createResilientExecutor } from "./ai/executor.js";
import { claudeCodeAuthSelfCheck } from "./ai/executors/claude-code.js";
import { CacheMetrics } from "./ai/metrics.js";

/**
 * 헤드리스 AI 워커 엔트리(상주 프로세스) — `npm run worker -w @hmb/server`.
 * env: AI_DATA_DIR(서버와 같은 곳을 봐야 함) · AI_EXECUTOR(stub|claude-code) · AI_POLL_MS(1000)
 * W2(#34): AI_EXECUTOR=claude-code — 정액제 구독 세션 + sonnet 서브에이전트(AI_MODEL 스왑).
 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env["AI_DATA_DIR"] ?? join(PKG_ROOT, ".data");
const POLL_MS = Number(process.env["AI_POLL_MS"] ?? 1000);

if ((process.env["AI_EXECUTOR"] ?? "stub") === "claude-code") claudeCodeAuthSelfCheck();

const queue = new FileJobQueue(join(DATA_DIR, "ai-queue"));
const cache = new ResultCache(join(DATA_DIR, "ai-cache"));
const metrics = new CacheMetrics(); // W3 AC1: L2 프롬프트캐시 계측(종료 시 리포트)
const worker = new AiWorker(queue, cache, createResilientExecutor({ onUsage: (u) => metrics.recordUsage(u) }));

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

void worker.runLoop(POLL_MS, abort.signal).then(() => {
  console.log("[ai-worker] 종료 · " + metrics.format());
});
