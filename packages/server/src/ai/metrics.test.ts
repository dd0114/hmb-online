import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheMetrics, parseUsage } from "./metrics.js";
import { claudeCodeExecutor, type ClaudeRunner } from "./executors/claude-code.js";
import { makeTacticalInput } from "@hmb/engine";
import { FileJobQueue } from "./queue.js";
import { ResultCache } from "./cache.js";
import { AiService } from "./service.js";
import { AiWorker } from "./worker.js";
import { createExecutor } from "./executor.js";
import { coachContext } from "../pipeline.js";
import type { AiJob } from "./protocol.js";

/**
 * W3 AC1 — 캐시 계측: L1 결과캐시 히트율 + L2 프롬프트 캐시(cacheRead) 집계를 수치로 증빙.
 */
describe("캐시 계측 (W3 AC1)", () => {
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
    const job: AiJob = {
      id: "abcd1234abcd1234",
      kind: "coach",
      context: { directive: "d", rosterContext: "H0 GK", seed: "42", prefix: "H" },
      enqueuedAt: "t",
    };
    await claudeCodeExecutor({ runner, model: "haiku", onUsage: (u) => m.recordUsage(u) }).execute(job);
    const r = m.report();
    expect(r.l2.jobs).toBe(1);
    expect(r.l2.cacheReadTokens).toBe(500);
    expect(r.l2.cacheCreateTokens).toBe(100);
    expect(r.l2.costUSD).toBeCloseTo(0.05, 5);
  });

  it("AiService L1 계측(오프라인 stub): miss → drain → 같은 지시 hit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-"));
    const q = new FileJobQueue(join(dir, "queue"));
    const cache = new ResultCache(join(dir, "cache"));
    const m = new CacheMetrics();
    const svc = new AiService(q, cache, m);
    const worker = new AiWorker(q, cache, createExecutor("stub"));
    const ctx = coachContext("풀백 오버랩·와이드", "4815162342");

    const r1 = await svc.request("coach", ctx);
    expect(r1.status).toBe("queued"); // L1 miss
    await worker.drain();
    const r2 = await svc.request("coach", ctx);
    expect(r2.status).toBe("cached"); // L1 hit

    const rep = m.report();
    expect(rep.l1).toMatchObject({ hits: 1, misses: 1, total: 2 });
    expect(rep.l1.hitRate).toBeCloseTo(0.5, 5);
  });
});
