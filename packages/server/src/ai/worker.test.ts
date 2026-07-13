import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJobQueue } from "./queue.js";
import { ResultCache } from "./cache.js";
import { AiWorker } from "./worker.js";
import type { AiExecutor } from "./executor.js";
import type { AiJob } from "./protocol.js";
import { coachContext } from "../pipeline.js";
import { makeTacticalInput } from "@hmb/engine";
import { TacticalInput } from "@hmb/shared";

// 워커 재시도 계약(블루프린트 테스트 5): 검증 실패 → feedback 포함 1회 재시도 → 2차 성공/실패.
describe("AiWorker — 검증 실패 재시도", () => {
  let q: FileJobQueue;
  let cache: ResultCache;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "aiw2-"));
    q = new FileJobQueue(join(dir, "queue"));
    cache = new ResultCache(join(dir, "cache"));
  });

  async function enqueue(): Promise<AiJob> {
    const ctx = coachContext("공격적", "42");
    const job: AiJob = { id: "1111111111111111", kind: "coach", context: ctx, enqueuedAt: "t" };
    await q.enqueue(job);
    return job;
  }

  it("1차 검증 실패(10명) → feedback 전달 재호출 → 2차 11명 성공", async () => {
    const calls: Array<{ feedback?: string }> = [];
    const bad = makeTacticalInput("H", "42");
    bad.players.pop(); // 10명 → 게이트 실패
    const good = makeTacticalInput("H", "42");
    const executor: AiExecutor = {
      name: "fake",
      execute: (_job, attempt) => {
        calls.push({ feedback: attempt?.feedback });
        return Promise.resolve(calls.length === 1 ? bad : good);
      },
    };
    await enqueue();
    await new AiWorker(q, cache, executor).drain();

    expect(calls).toHaveLength(2); // 정확히 1회 재시도
    expect(calls[0]!.feedback).toBeUndefined();
    expect(calls[1]!.feedback).toMatch(/11명/); // 실패 사유가 피드백으로
    const res = await q.result("1111111111111111");
    expect(res?.ok).toBe(true);
    expect(TacticalInput.parse(res!.output).players).toHaveLength(11);
  });

  it("2연속 검증 실패 → failed (VALIDATE 접두어)", async () => {
    const bad = makeTacticalInput("H", "42");
    bad.players.pop();
    const executor: AiExecutor = { name: "fake", execute: () => Promise.resolve(bad) };
    await enqueue();
    await new AiWorker(q, cache, executor).drain();
    const res = await q.result("1111111111111111");
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/^VALIDATE:/);
  });

  it("executor 자체 실패(TIMEOUT)는 재시도 없이 접두어 유지", async () => {
    let n = 0;
    const executor: AiExecutor = {
      name: "fake",
      execute: () => {
        n++;
        return Promise.reject(new Error("TIMEOUT: 초과"));
      },
    };
    await enqueue();
    await new AiWorker(q, cache, executor).drain();
    expect(n).toBe(1); // 재시도 안 함
    const res = await q.result("1111111111111111");
    expect(res?.error).toMatch(/^TIMEOUT:/);
  });
});
