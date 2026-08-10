import { z } from "zod";
import type { JobUsage } from "./metrics.js";

/**
 * java-client — Java 게임서버 `/internal/ai-jobs` 큐 프로토콜 클라이언트 (LLD-server-java §6, openapi.yaml).
 * 인증: 고정 shared secret `X-Servant-Token` (env SERVANT_TOKEN, AC-Q3).
 * poll = long-poll(waitMs≤25000): 200 → 잡 1개 lease 됨 / 204 → 빈 큐(재폴).
 * complete = `{ok:true, output(TacticalInput), usage}` 또는 `{ok:false, error}`.
 */

/** poll 응답에서 실행기가 쓰는 최소 형태(id + context). Java 의 나머지 필드(status 등)는 무시. */
export const PolledAiJob = z
  .object({
    id: z.string().min(1),
    context: z.unknown(),
  })
  .passthrough();
export type PolledAiJob = z.infer<typeof PolledAiJob>;

/** complete 요청 바디(openapi `AiJobCompleteRequest`). usage 필드명 = `AiJobUsage`(camelCase). */
export interface CompleteBody {
  ok: boolean;
  output?: unknown;
  error?: string;
  usage?: JobUsage;
}

export interface JavaClientOptions {
  /** Java 베이스 URL. 예: http://localhost:8080 */
  baseUrl: string;
  /** X-Servant-Token 값. */
  token: string;
  /** poll body 의 workerId. */
  workerId: string;
  /** fetch 주입(테스트). 기본 global fetch. */
  fetchImpl?: typeof fetch;
}

export class JavaClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly workerId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JavaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.workerId = opts.workerId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", "X-Servant-Token": this.token };
  }

  /**
   * 잡 1개 long-poll lease. 204(빈 큐) → null. 401 등 비정상 → throw(루프가 로그 후 재시도).
   * signal: SIGTERM 시 대기 중 long-poll 을 즉시 끊기 위한 AbortSignal.
   */
  async poll(waitMs = 25_000, signal?: AbortSignal): Promise<PolledAiJob | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/internal/ai-jobs/poll`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ workerId: this.workerId, waitMs }),
      signal: signal ?? null,
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      throw new Error(`poll 실패: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return PolledAiJob.parse(await res.json());
  }

  /** 잡 완료 보고. 비정상 응답은 throw(호출부가 로그 — 잡은 lease 만료로 Java 가 재배포). */
  async complete(jobId: string, body: CompleteBody): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/internal/ai-jobs/${encodeURIComponent(jobId)}/complete`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`complete 실패(job=${jobId}): HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  /**
   * 실효 AI 모드 자기신고(#471 AC3) — 기동 직후 1회 + 주기 하트비트.
   * **던지지 않는다**: 신고 실패는 안내 배너 하나가 늦는 일이고, 그걸로 실행기가 죽으면 게임이 죽는다.
   * 성공 여부만 돌려주고 로그는 호출부가 한다.
   */
  async reportAiMode(body: AiModeReport): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/internal/ai-mode`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ...body, workerId: this.workerId }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** `/internal/ai-mode` 요청 바디. 사유 어휘 = executor 의 `AI_MODE_REASONS` 단일 출처. */
export interface AiModeReport {
  /** "live" | "stub" — 서버는 이 값을 그대로 `/api/config` 로 노출한다(executor kind 이름을 모른다). */
  mode: string;
  reason: string;
  wanted: string;
  effective: string;
}
