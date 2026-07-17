import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJobQueue } from "./ai/queue.js";
import { ResultCache } from "./ai/cache.js";
import { AiService } from "./ai/service.js";
import { AiWorker } from "./ai/worker.js";
import { createExecutor } from "./ai/executor.js";
import { coachContext, runMatchWithHomeInput } from "./pipeline.js";
import { matchFingerprint, fingerprintsEqual, replayFromCache } from "./replay.js";

/**
 * W3 AC5 — 리플레이 계약: L1 결과캐시에 저장된 TacticalInput 을 같은 seed 로 재실행하면
 * 동일 MatchLog 지문이 나온다(리플레이/PvP 재현성). 로그인/키/네트워크 0(stub executor).
 */
describe("리플레이 계약 (W3 AC5)", () => {
  let q: FileJobQueue;
  let cache: ResultCache;
  let svc: AiService;
  let worker: AiWorker;
  const SEED = "4815162342";

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "replay-"));
    q = new FileJobQueue(join(dir, "queue"));
    cache = new ResultCache(join(dir, "cache"));
    svc = new AiService(q, cache);
    worker = new AiWorker(q, cache, createExecutor("stub"));
  });

  it("캐시 저장분 재실행 = 원래 실행과 동일 지문(왕복 재현)", async () => {
    const ctx = coachContext("풀백 오버랩·와이드·하이라인 공격적", SEED);
    const r = await svc.request("coach", ctx);
    await worker.drain();
    const first = await svc.awaitResult(r.id, 1000);
    expect(first?.ok).toBe(true);

    // 원래 실행(방금 받은 output) 지문
    const original = matchFingerprint(runMatchWithHomeInput(first!.output, SEED));
    // L1 캐시에서 다시 꺼내 재현
    const replayed = matchFingerprint(await replayFromCache(cache, r.id, SEED));

    expect(fingerprintsEqual(original, replayed)).toBe(true);
    expect(replayed.lastHash).toBe(original.lastHash);
  });

  it("두 번 재현해도 동일(결정론 안정)", async () => {
    const ctx = coachContext("콤팩트 로우블록·수비적", SEED);
    const r = await svc.request("coach", ctx);
    await worker.drain();
    await svc.awaitResult(r.id, 1000);

    const a = matchFingerprint(await replayFromCache(cache, r.id, SEED));
    const b = matchFingerprint(await replayFromCache(cache, r.id, SEED));
    expect(fingerprintsEqual(a, b)).toBe(true);
  });

  it("다른 seed 는 다른 지문(지문 민감도)", async () => {
    const ctx = coachContext("풀백 오버랩·와이드", SEED);
    const r = await svc.request("coach", ctx);
    await worker.drain();
    await svc.awaitResult(r.id, 1000);

    const base = matchFingerprint(await replayFromCache(cache, r.id, SEED));
    const other = matchFingerprint(await replayFromCache(cache, r.id, "9999999999"));
    expect(base.lastHash).not.toBe(other.lastHash);
  });

  it("캐시 미스는 명시적 throw(재현 번들 부재 신호)", async () => {
    await expect(replayFromCache(cache, "deadbeefdeadbeef", SEED)).rejects.toThrow(/no cached input/);
  });
});
