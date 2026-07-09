import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJobQueue } from "./queue.js";
import { ResultCache } from "./cache.js";
import { AiService } from "./service.js";
import { AiWorker } from "./worker.js";
import { createExecutor } from "./executor.js";
import { coachContext, runMatchWithHomeInput } from "../pipeline.js";
import { TacticalInput } from "@hmb/shared";

// W1 end-to-end (키/네트워크/로그인 0): 서버 request → 큐 → stub 워커 → 검증 게이트 → 결과/캐시 → runMatch.
describe("AI 워커 end-to-end (stub executor)", () => {
  let q: FileJobQueue;
  let cache: ResultCache;
  let svc: AiService;
  let worker: AiWorker;
  const SEED = "4815162342";

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "aiw-"));
    q = new FileJobQueue(join(dir, "queue"));
    cache = new ResultCache(join(dir, "cache"));
    svc = new AiService(q, cache);
    worker = new AiWorker(q, cache, createExecutor("stub"));
  });

  it("request(queued) → 워커 drain → 검증 통과 output → 두 번째 request 는 cached(AI 스킵)", async () => {
    const ctx = coachContext("풀백 오버랩·와이드·하이라인 공격적", SEED);
    const r1 = await svc.request("coach", ctx);
    expect(r1.status).toBe("queued");

    expect(await worker.drain()).toBe(1);

    const res = await svc.awaitResult(r1.id, 1000);
    expect(res?.ok).toBe(true);
    const input = TacticalInput.parse(res!.output); // 검증 게이트 통과물
    expect(input.players).toHaveLength(11);
    expect(input.players.every((p) => p.playerId.startsWith("H"))).toBe(true);

    // 결과캐시 히트 — 같은 지시는 AI 호출 스킵.
    const r2 = await svc.request("coach", ctx);
    expect(r2.status).toBe("cached");
    expect(r2.id).toBe(r1.id);
  });

  it("공격 vs 수비 directive → 다른 잡(id) + stub 산출의 방향 차이 + 결정론 매치 실행", async () => {
    const cA = coachContext("풀백 오버랩·와이드·하이라인 공격적", SEED);
    const cB = coachContext("콤팩트 로우블록·back four 고정 수비적", SEED);
    const rA = await svc.request("coach", cA);
    const rB = await svc.request("coach", cB);
    expect(rA.id).not.toBe(rB.id);
    await worker.drain();

    const outA = TacticalInput.parse((await svc.awaitResult(rA.id, 1000))!.output);
    const outB = TacticalInput.parse((await svc.awaitResult(rB.id, 1000))!.output);
    expect(outA.team.width).toBeGreaterThan(outB.team.width);

    // 결정론 경계: 같은 seed+같은 input → 같은 MatchLog 해시(리플레이 재현).
    const log1 = runMatchWithHomeInput(outA, SEED);
    const log2 = runMatchWithHomeInput(outA, SEED);
    expect(log1.tickSnapshots.at(-1)!.hash).toBe(log2.tickSnapshots.at(-1)!.hash);
  });

  it("검증 게이트: 컨텍스트가 깨진 잡은 failed 로 (ok:false + error)", async () => {
    await q.enqueue({ id: "deadbeefdeadbeef", kind: "coach", context: { nope: 1 }, enqueuedAt: "t" });
    await worker.drain();
    const res = await q.result("deadbeefdeadbeef");
    expect(res?.ok).toBe(false);
    expect(res?.error).toBeTruthy();
  });
});
