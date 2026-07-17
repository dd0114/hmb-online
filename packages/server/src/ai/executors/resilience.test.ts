import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRetry, withFallback, isTransient } from "./resilience.js";
import { stubExecutor } from "./stub.js";
import type { AiExecutor } from "../executor.js";
import type { AiJob } from "../protocol.js";
import { FileJobQueue } from "../queue.js";
import { ResultCache } from "../cache.js";
import { AiWorker } from "../worker.js";
import { coachContext } from "../../pipeline.js";
import { TacticalInput } from "@hmb/shared";

const JOB: AiJob = {
  id: "abcd1234abcd1234",
  kind: "coach",
  context: coachContext("풀백 오버랩·와이드", "4815162342"),
  enqueuedAt: "t",
};

/** 지정 시퀀스대로 throw/return 하는 합성 executor. 호출 횟수 기록. */
function scriptedExecutor(name: string, steps: Array<() => unknown>): AiExecutor & { calls: number } {
  const ex = {
    name,
    calls: 0,
    execute(_job: AiJob, _attempt?: { feedback: string }): Promise<unknown> {
      const step = steps[Math.min(ex.calls, steps.length - 1)]!;
      ex.calls += 1;
      try {
        return Promise.resolve(step());
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
  return ex;
}

const cap = (): never => {
  throw new Error("CAP: usage limit reached");
};
const auth = (): never => {
  throw new Error("AUTH: please log in");
};

describe("회복력 데코레이터 (W3 AC4)", () => {
  it("isTransient: CAP/TIMEOUT 만 재시도 대상", () => {
    expect(isTransient(new Error("CAP: x"))).toBe(true);
    expect(isTransient(new Error("TIMEOUT: x"))).toBe(true);
    expect(isTransient(new Error("AUTH: x"))).toBe(false);
    expect(isTransient(new Error("OUTPUT: x"))).toBe(false);
    expect(isTransient(new Error("VALIDATE: x"))).toBe(false);
  });

  it("withRetry: CAP 2회 후 성공 → 총 3회 시도 + 지수 백오프 대기", async () => {
    const delays: number[] = [];
    const inner = scriptedExecutor("primary", [cap, cap, () => ({ ok: true })]);
    const ex = withRetry(inner, { retries: 3, baseDelayMs: 500, sleep: (ms) => (delays.push(ms), Promise.resolve()) });
    const out = await ex.execute(JOB);
    expect(out).toEqual({ ok: true });
    expect(inner.calls).toBe(3);
    expect(delays).toEqual([500, 1000]); // 2번 백오프(500→1000), 3번째 성공
  });

  it("withRetry: AUTH(영구)는 재시도 없이 즉시 전파(1회)", async () => {
    const inner = scriptedExecutor("primary", [auth]);
    const ex = withRetry(inner, { retries: 3, sleep: () => Promise.resolve() });
    await expect(ex.execute(JOB)).rejects.toThrow(/^AUTH:/);
    expect(inner.calls).toBe(1);
  });

  it("withRetry: 재시도 소진 시 마지막 오류 throw(총 retries+1회)", async () => {
    const inner = scriptedExecutor("primary", [cap]);
    const ex = withRetry(inner, { retries: 2, sleep: () => Promise.resolve() });
    await expect(ex.execute(JOB)).rejects.toThrow(/^CAP:/);
    expect(inner.calls).toBe(3); // 1 + 2 재시도
  });

  it("withFallback: primary CAP → fallback(stub) 이 유효 출력 서빙", async () => {
    const primary = scriptedExecutor("claude-code", [cap]);
    let fellBack = false;
    const ex = withFallback(primary, stubExecutor(), () => (fellBack = true));
    const out = await ex.execute(JOB);
    expect(fellBack).toBe(true);
    expect(TacticalInput.parse(out).players).toHaveLength(11); // stub 이 유효 인풋 생성
    expect(ex.name).toContain("→stub");
  });

  it("withFallback: AUTH(영구)는 폴백 안 하고 전파", async () => {
    const primary = scriptedExecutor("claude-code", [auth]);
    const fb = scriptedExecutor("fallback", [() => ({ ok: true })]);
    const ex = withFallback(primary, fb);
    await expect(ex.execute(JOB)).rejects.toThrow(/^AUTH:/);
    expect(fb.calls).toBe(0); // 폴백 미호출
  });
});

describe("무중단 executor 스위치 — 워커 통합 (W3 AC4)", () => {
  let q: FileJobQueue;
  let cache: ResultCache;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "resil-"));
    q = new FileJobQueue(join(dir, "queue"));
    cache = new ResultCache(join(dir, "cache"));
  });

  it("primary 가 CAP 로 죽어도 fallback 으로 잡이 완주(큐 무중단)", async () => {
    await q.enqueue({ id: JOB.id, kind: "coach", context: JOB.context, enqueuedAt: "t" });
    // 운영자가 캡 대응으로 primary→fallback(stub) 스위치 = 큐를 안 건드리고 executor 만 교체.
    const primary = scriptedExecutor("claude-code:sonnet", [cap]);
    const resilient = withRetry(withFallback(primary, stubExecutor()), { retries: 1, sleep: () => Promise.resolve() });
    const worker = new AiWorker(q, cache, resilient);

    expect(await worker.drain()).toBe(1);
    const res = await q.result(JOB.id);
    expect(res?.ok).toBe(true);
    expect(TacticalInput.parse(res!.output).players).toHaveLength(11);
    expect(res?.meta?.executor).toContain("→stub"); // fallback 이 서빙했음이 결과 meta 에 기록
  });
});
