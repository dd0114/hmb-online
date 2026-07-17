import { describe, it, expect } from "vitest";
import { CacheMetrics, parseUsage } from "./metrics.js";
import { claudeCodeExecutor, type ClaudeRunner } from "./executors/claude-code.js";
import { makeTacticalInput } from "@hmb/engine";
import type { ExecutorJob } from "./kinds.js";
import { makeTeamInputContext } from "./test-fixtures.js";

/**
 * 캐시/토큰 계측(구 #32 W3 AC1 스위트 이관 — 파일큐 AiService 통합 파트 제외, L1 멱등은 Java 소유).
 */
describe("캐시 계측 (W3 AC1 이관)", () => {
  it("L1 히트율: recordRequest cached/queued 집계", () => {
    const m = new CacheMetrics();
    m.recordRequest("queued"); // miss
    m.recordRequest("cached"); // hit
    m.recordRequest("cached"); // hit
    m.recordRequest("cached"); // hit
    const r = m.report();
    expect(r.l1).toMatchObject({ hits: 3, misses: 1, total: 4 });
    expect(r.l1.hitRate).toBeCloseTo(0.75, 5);
  });

  it("L2 집계: 잡별 usage 누적 + promptCacheHitRate = cacheRead/(input+cacheRead+cacheCreate)", () => {
    const m = new CacheMetrics();
    m.recordUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreateTokens: 0, costUSD: 0.01 });
    m.recordUsage({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 900, cacheCreateTokens: 0, costUSD: 0.02 });
    const r = m.report();
    expect(r.l2.jobs).toBe(2);
    expect(r.l2.cacheReadTokens).toBe(1800);
    expect(r.l2.inputTokens).toBe(200);
    expect(r.l2.outputTokens).toBe(50);
    expect(r.l2.costUSD).toBeCloseTo(0.03, 5);
    // 1800 / (200 + 1800 + 0) = 0.9
    expect(r.l2.promptCacheHitRate).toBeCloseTo(0.9, 5);
  });

  it("빈 계측은 0 (0으로 나눔 안전)", () => {
    const r = new CacheMetrics().report();
    expect(r.l1.hitRate).toBe(0);
    expect(r.l2.promptCacheHitRate).toBe(0);
  });

  it("format(): 사람이 읽는 한 줄 요약", () => {
    const m = new CacheMetrics();
    m.recordRequest("cached");
    m.recordUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheCreateTokens: 0, costUSD: 0.01 });
    const s = m.format();
    expect(s).toContain("L1 결과캐시 hit 100.0%");
    expect(s).toContain("L2 프롬프트캐시 hit 90.0%");
  });

  it("parseUsage: claude-code 봉투 → JobUsage(없으면 null)", () => {
    expect(parseUsage({})).toBeNull();
    const u = parseUsage({
      usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 123, cache_creation_input_tokens: 456 },
      total_cost_usd: 0.02,
    });
    expect(u).toEqual({ inputTokens: 5, outputTokens: 9, cacheReadTokens: 123, cacheCreateTokens: 456, costUSD: 0.02 });
  });

  it("executor onUsage 콜백: 잡 실행 시 usage 를 CacheMetrics 로 전달(러너 주입, 로그인 0)", async () => {
    const m = new CacheMetrics();
    const runner: ClaudeRunner = () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: makeTacticalInput("H", "42"),
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
          total_cost_usd: 0.05,
        }),
        stderr: "",
        timedOut: false,
      });
    const job: ExecutorJob = { id: "abcd1234abcd1234", kind: "team-input", context: makeTeamInputContext() };
    await claudeCodeExecutor({ runner, model: "haiku", onUsage: (u) => m.recordUsage(u) }).execute(job);
    const r = m.report();
    expect(r.l2.jobs).toBe(1);
    expect(r.l2.cacheReadTokens).toBe(500);
    expect(r.l2.cacheCreateTokens).toBe(100);
    expect(r.l2.costUSD).toBeCloseTo(0.05, 5);
  });
});
