/**
 * 캐시/토큰 계측(구 #32 W3 AC1 자산 이관): "캐시 최대 활용" 을 수치로 증빙.
 * 2층 — L1 결과캐시(Java 가 promptHash 멱등으로 잡 자체를 스킵, LLD-server-java §5.2) ·
 * L2 프롬프트 캐시(하네스 자동, cacheRead 토큰 — claude-code 봉투에서 파싱).
 * 인메모리 카운터(프로세스 수명). usage 는 complete body 로 Java 에도 전달된다(openapi AiJobUsage).
 */

/** 잡 1건의 토큰 usage(claude-code executor 봉투에서 파싱). 필드명 = openapi `AiJobUsage` 와 일치. */
export interface JobUsage {
  inputTokens: number; // 캐시 미적용 신규 입력
  outputTokens: number;
  cacheReadTokens: number; // 프롬프트 캐시에서 읽음(= 절약)
  cacheCreateTokens: number; // 프롬프트 캐시에 씀
  costUSD: number;
}

export interface CacheReport {
  /** L1 결과캐시: request 가 AI 를 스킵한 비율. */
  l1: { hits: number; misses: number; total: number; hitRate: number };
  /** L2 프롬프트 캐시: 실제 AI 호출된 잡들의 토큰 집계. */
  l2: {
    jobs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    /** 프롬프트 입력 중 캐시에서 온 비율 = cacheRead / (input + cacheRead + cacheCreate). */
    promptCacheHitRate: number;
    costUSD: number;
  };
}

const rate = (num: number, den: number): number => (den === 0 ? 0 : num / den);

export class CacheMetrics {
  private l1Hits = 0;
  private l1Misses = 0;
  private jobs = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheCreateTokens = 0;
  private costUSD = 0;

  /** L1 기록: cached = 히트(AI 스킵), 그 외 = 미스(잡 실행). (Java 멱등 스킵 계측 훅) */
  recordRequest(status: "cached" | "queued"): void {
    if (status === "cached") this.l1Hits += 1;
    else this.l1Misses += 1;
  }

  /** 실제 AI 호출된 잡의 토큰 usage 누적(L2). */
  recordUsage(u: JobUsage): void {
    this.jobs += 1;
    this.inputTokens += u.inputTokens;
    this.outputTokens += u.outputTokens;
    this.cacheReadTokens += u.cacheReadTokens;
    this.cacheCreateTokens += u.cacheCreateTokens;
    this.costUSD += u.costUSD;
  }

  report(): CacheReport {
    const l1Total = this.l1Hits + this.l1Misses;
    const promptTotal = this.inputTokens + this.cacheReadTokens + this.cacheCreateTokens;
    return {
      l1: {
        hits: this.l1Hits,
        misses: this.l1Misses,
        total: l1Total,
        hitRate: rate(this.l1Hits, l1Total),
      },
      l2: {
        jobs: this.jobs,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        cacheReadTokens: this.cacheReadTokens,
        cacheCreateTokens: this.cacheCreateTokens,
        promptCacheHitRate: rate(this.cacheReadTokens, promptTotal),
        costUSD: this.costUSD,
      },
    };
  }

  /** 사람이 읽는 한 줄 요약(운영 로그·리포트용). */
  format(): string {
    const r = this.report();
    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
    return (
      `[cache] L1 결과캐시 hit ${pct(r.l1.hitRate)} (${r.l1.hits}/${r.l1.total}) · ` +
      `L2 프롬프트캐시 hit ${pct(r.l2.promptCacheHitRate)} ` +
      `(cacheRead ${r.l2.cacheReadTokens} / in ${r.l2.inputTokens} / create ${r.l2.cacheCreateTokens}) · ` +
      `jobs ${r.l2.jobs} · costUSD ${r.l2.costUSD.toFixed(4)}`
    );
  }
}

/** claude-code 봉투(env)의 usage 를 JobUsage 로 파싱(없으면 null). */
export function parseUsage(env: Record<string, unknown>): JobUsage | null {
  const u = env["usage"] as Record<string, unknown> | undefined;
  if (!u) return null;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u["input_tokens"]),
    outputTokens: n(u["output_tokens"]),
    cacheReadTokens: n(u["cache_read_input_tokens"]),
    cacheCreateTokens: n(u["cache_creation_input_tokens"]),
    costUSD: n(env["total_cost_usd"]),
  };
}
