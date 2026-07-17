import { pathToFileURL } from "node:url";
import { JavaClient } from "./java-client.js";
import { KINDS, type AiJobKind, type ExecutorJob, type KindSpec } from "./kinds.js";
import { createResilientExecutor, type AiExecutor } from "./executor.js";
import { claudeCodeAuthSelfCheck } from "./executors/claude-code.js";
import { CacheMetrics, type JobUsage } from "./metrics.js";

/**
 * AI실행기(서번트②) 엔트리 — Java `/internal/ai-jobs` 폴링 루프 (LLD-ts-servants §3).
 * env: JAVA_URL(http://localhost:8080) · SERVANT_TOKEN · AI_EXECUTOR(stub|claude-code) · AI_MODEL ·
 *      AI_FALLBACK_EXECUTOR · AI_MAX_RETRIES · AI_POLL_WAIT_MS(25000) · AI_WORKER_ID
 * 종료: SIGTERM/SIGINT → 진행 중 잡은 완료 후 종료(대기 중 long-poll 은 즉시 abort — lease 가 재배포 보장).
 * 파일 큐(구 W1)는 퇴역 — 큐·상태·멱등(L1)은 전부 Java 소유.
 */

/** 결과 error 접두어 정규화(구 #32 §5). executor 는 이미 접두 → 게이트/기타 실패는 VALIDATE. */
function classifyError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /^(AUTH|CAP|OUTPUT|TIMEOUT|VALIDATE):/.test(m) ? m : `VALIDATE: ${m}`;
}

export interface ExecutorLoopOptions {
  /** complete body 에 실을 잡별 usage 조회(claude-code onUsage 로 적재). 없으면 usage 생략. */
  takeUsage?: (jobId: string) => JobUsage | undefined;
  /** long-poll waitMs. 기본 25000(openapi 상한). */
  pollWaitMs?: number;
  log?: (msg: string) => void;
}

/**
 * 폴링 루프 본체 — client/executor 주입으로 오프라인 테스트 가능(AC-T2).
 * 잡 실행 = context 검증 → 프롬프트 빌드/실행(executor) → 검증 게이트(실패 시 feedback 1회 재시도,
 * 구 워커 의미론 유지) → complete(ok:true output+usage | ok:false error).
 */
export class ExecutorLoop {
  private readonly takeUsage: (jobId: string) => JobUsage | undefined;
  private readonly pollWaitMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly client: JavaClient,
    private readonly executor: AiExecutor,
    opts: ExecutorLoopOptions = {},
  ) {
    this.takeUsage = opts.takeUsage ?? (() => undefined);
    this.pollWaitMs = opts.pollWaitMs ?? 25_000;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** 잡 하나 폴링·처리. 처리했으면 true, 빈 큐(204)면 false. */
  async processOnce(pollSignal?: AbortSignal): Promise<boolean> {
    const polled = await this.client.poll(this.pollWaitMs, pollSignal);
    if (!polled) return false;

    const kind = this.kindOf(polled.context);
    if (!kind) {
      await this.client.complete(polled.id, { ok: false, error: "VALIDATE: 알 수 없는 잡 kind(context.kind)" });
      return true;
    }
    const job: ExecutorJob = { id: polled.id, kind, context: polled.context };
    const spec = KINDS[kind];

    try {
      spec.contextSchema.parse(job.context); // 컨텍스트 형태 검증
      const output = await this.executeWithGate(job, spec);
      await this.client.complete(job.id, { ok: true, output, usage: this.takeUsage(job.id) });
      this.log(`[ai-executor] job=${job.id.slice(0, 8)} 완료 (executor=${this.executor.name})`);
    } catch (e) {
      const error = classifyError(e);
      await this.client.complete(job.id, { ok: false, error });
      this.log(`[ai-executor] job=${job.id.slice(0, 8)} 실패: ${error}`);
    }
    return true;
  }

  /** context.kind → 레지스트리 kind (미지원이면 null). */
  private kindOf(context: unknown): AiJobKind | null {
    const k =
      context !== null && typeof context === "object"
        ? (context as Record<string, unknown>)["kind"]
        : undefined;
    return typeof k === "string" && k in KINDS ? (k as AiJobKind) : null;
  }

  /**
   * executor 실행 → 검증 게이트. 게이트 실패 시 실패 사유를 피드백으로 넣어 **정확히 1회** 재시도.
   * 두 번째도 게이트 실패면 VALIDATE 로 throw. executor 자체 실패(AUTH/CAP/OUTPUT/TIMEOUT)는 재시도 안 함
   * (그건 resilience 데코레이터·Java attempts 몫).
   */
  private async executeWithGate(job: ExecutorJob, spec: KindSpec): Promise<unknown> {
    const raw = await this.executor.execute(job);
    try {
      return spec.validate(raw, job.context);
    } catch (ve) {
      const feedback = ve instanceof Error ? ve.message : String(ve);
      const raw2 = await this.executor.execute(job, { feedback });
      try {
        return spec.validate(raw2, job.context);
      } catch (ve2) {
        throw new Error(`VALIDATE: ${ve2 instanceof Error ? ve2.message : String(ve2)}`);
      }
    }
  }

  /**
   * 상주 루프. stop.abort() → 대기 중 long-poll 은 즉시 끊고, 진행 중 잡은 완료 후 반환(SIGTERM 계약).
   * poll 오류(Java 다운 등)는 로그 후 idleMs 대기하고 재시도.
   */
  async run(stop: AbortSignal, idleMs = 1_000): Promise<void> {
    this.log(`[ai-executor] executor=${this.executor.name} 폴링 시작 (waitMs=${this.pollWaitMs})`);
    while (!stop.aborted) {
      try {
        await this.processOnce(stop);
      } catch (e) {
        if (stop.aborted) break; // long-poll abort = 정상 종료 경로
        console.error(`[ai-executor] 폴링/처리 오류(재시도):`, e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, idleMs));
      }
    }
    this.log("[ai-executor] 종료 (진행 중 잡 없음)");
  }
}

// ---- 프로세스 엔트리 ------------------------------------------------------------------

/**
 * 정액제 가드(LLD §5 함정, 기동 시 1회): ANTHROPIC_API_KEY 가 있으면 claude CLI 가 구독 대신
 * 종량 과금으로 샌다 → **감지 시 unset 강제** + 경고. claude-code 면 인증 self-check 로그도 수행.
 * 엔트리 가드에서 호출(단위테스트 가능하게 export).
 */
export function prepareExecutorEnv(executorKind: string = process.env["AI_EXECUTOR"] ?? "stub"): void {
  if (process.env["ANTHROPIC_API_KEY"]) {
    console.warn("[ai-executor] ⚠️ ANTHROPIC_API_KEY 감지 → unset 강제(정액제 구독 세션 유지).");
    delete process.env["ANTHROPIC_API_KEY"];
  }
  if (executorKind === "claude-code") claudeCodeAuthSelfCheck();
}

/** AI_POLL_WAIT_MS 파싱 — openapi `AiJobPollRequest.waitMs` 상한(25000)·하한(1000) 클램프. */
export function parsePollWaitMs(raw: string | undefined): number {
  const n = Number(raw ?? 25_000);
  if (!Number.isFinite(n)) return 25_000;
  return Math.min(25_000, Math.max(1_000, n));
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const EXECUTOR_KIND = process.env["AI_EXECUTOR"] ?? "stub";
  prepareExecutorEnv(EXECUTOR_KIND);

  const JAVA_URL = process.env["JAVA_URL"] ?? "http://localhost:8080";
  const TOKEN = process.env["SERVANT_TOKEN"] ?? "";
  const WORKER_ID = process.env["AI_WORKER_ID"] ?? `ts-executor-${process.pid}`;
  const POLL_WAIT_MS = parsePollWaitMs(process.env["AI_POLL_WAIT_MS"]);

  if (!TOKEN) console.warn("[ai-executor] ⚠️ SERVANT_TOKEN 미설정 — Java 가 401 을 줄 수 있음.");

  const metrics = new CacheMetrics();
  const usageByJob = new Map<string, JobUsage>();
  const executor = createResilientExecutor({
    onUsage: (u, jobId) => {
      usageByJob.set(jobId, u);
      metrics.recordUsage(u);
    },
  });
  const client = new JavaClient({ baseUrl: JAVA_URL, token: TOKEN, workerId: WORKER_ID });
  const loop = new ExecutorLoop(client, executor, {
    pollWaitMs: POLL_WAIT_MS,
    takeUsage: (id) => {
      const u = usageByJob.get(id);
      usageByJob.delete(id);
      return u;
    },
  });

  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());

  console.log(`[ai-executor] java=${JAVA_URL} workerId=${WORKER_ID} executor=${EXECUTOR_KIND}`);
  void loop.run(stop.signal).then(() => {
    console.log(metrics.format());
  });
}
