import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TacticalInput } from "@hmb/shared";
import { ExecutorLoop } from "./executor-main.js";
import { JavaClient } from "./java-client.js";
import { stubExecutor } from "./executors/stub.js";
import { claudeCodeExecutor, type ClaudeRunner } from "./executors/claude-code.js";
import { CacheMetrics, type JobUsage } from "./metrics.js";
import type { AiExecutor } from "./executor.js";
import { makeTeamInputContext } from "./test-fixtures.js";

/**
 * AC-T2 (오프라인): 가짜 Java 서버(node:http, openapi `/internal/ai-jobs` poll/complete)로
 * 폴링 루프를 end-to-end 검증 — stub executor 가 유효 TacticalInput 으로 complete, 토큰 헤더,
 * 204 재폴 경로, 실패 시 ok:false, usage 계측/전달. 실 Java·claude CLI·네트워크 외부 의존 0.
 */

const TOKEN = "test-servant-token";

interface RecordedPoll {
  headers: IncomingMessage["headers"];
  body: { workerId?: string; waitMs?: number };
}
interface RecordedComplete {
  id: string;
  headers: IncomingMessage["headers"];
  body: { ok: boolean; output?: unknown; error?: string; usage?: JobUsage };
}

/** openapi poll/complete 를 구현하는 가짜 Java. delay204Ms 로 빈 큐 long-poll 흉내. */
class FakeJava {
  server: Server;
  queue: Array<{ id: string; context: unknown }> = [];
  polls: RecordedPoll[] = [];
  completes: RecordedComplete[] = [];
  delay204Ms = 0;
  base = "";

  constructor() {
    this.server = createServer((req, res) => {
      void this.route(req, res);
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const url = req.url ?? "/";

    if (req.headers["x-servant-token"] !== TOKEN) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "UNAUTHORIZED" }));
      return;
    }

    if (req.method === "POST" && url === "/internal/ai-jobs/poll") {
      this.polls.push({ headers: req.headers, body: body as RecordedPoll["body"] });
      const job = this.queue.shift();
      if (!job) {
        if (this.delay204Ms > 0) await new Promise((r) => setTimeout(r, this.delay204Ms));
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: job.id, status: "leased", context: job.context, attempts: 1 }));
      return;
    }

    const m = /^\/internal\/ai-jobs\/([^/]+)\/complete$/.exec(url);
    if (req.method === "POST" && m) {
      this.completes.push({ id: m[1]!, headers: req.headers, body: body as RecordedComplete["body"] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: m[1], status: (body["ok"] as boolean) ? "done" : "failed", context: {} }));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((e) => (e ? reject(e) : resolve())));
  }
}

function client(java: FakeJava, token = TOKEN): JavaClient {
  return new JavaClient({ baseUrl: java.base, token, workerId: "test-worker-1" });
}

describe("AI실행기 폴링 루프 — 가짜 Java 큐 (AC-T2, 오프라인)", () => {
  let java: FakeJava;

  beforeEach(async () => {
    java = new FakeJava();
    await java.start();
  });

  afterEach(async () => {
    await java.stop();
  });

  it("team-input 잡 → stub 실행 → 검증 통과 TacticalInput 으로 complete(ok:true) + 헤더/토큰/workerId", async () => {
    const ctx = makeTeamInputContext({ teamPrompt: "하이라인·와이드 공격" });
    java.queue.push({ id: "job-1", context: ctx });

    const loop = new ExecutorLoop(client(java), stubExecutor(), { pollWaitMs: 1234, log: () => {} });
    expect(await loop.processOnce()).toBe(true);

    // poll 계약: X-Servant-Token + {workerId, waitMs}
    expect(java.polls).toHaveLength(1);
    expect(java.polls[0]!.headers["x-servant-token"]).toBe(TOKEN);
    expect(java.polls[0]!.body).toEqual({ workerId: "test-worker-1", waitMs: 1234 });

    // complete 계약: ok:true + zod TacticalInput 통과 + 로스터 playerId 정합(클램프 완료 산출)
    expect(java.completes).toHaveLength(1);
    const c = java.completes[0]!;
    expect(c.id).toBe("job-1");
    expect(c.headers["x-servant-token"]).toBe(TOKEN);
    expect(c.body.ok).toBe(true);
    const out = TacticalInput.parse(c.body.output);
    expect(out.players).toHaveLength(11);
    const rosterIds = new Set(ctx.roster.map((r) => r.playerId));
    for (const p of out.players) expect(rosterIds.has(p.playerId)).toBe(true);
    // 공격 지시가 stub 의미론대로 반영(하이라인)
    expect(out.team.defensiveLineHeight).toBeGreaterThan(0.7);
  });

  it("빈 큐 → 204 → processOnce false, complete 없음(재폴 경로)", async () => {
    const loop = new ExecutorLoop(client(java), stubExecutor(), { log: () => {} });
    expect(await loop.processOnce()).toBe(false);
    expect(java.polls).toHaveLength(1);
    expect(java.completes).toHaveLength(0);
  });

  it("executor 실패(OUTPUT) → complete(ok:false, error 접두 유지)", async () => {
    java.queue.push({ id: "job-f", context: makeTeamInputContext() });
    const failing: AiExecutor = {
      name: "failing",
      execute: () => Promise.reject(new Error("OUTPUT: 구조화 출력 없음")),
    };
    const loop = new ExecutorLoop(client(java), failing, { log: () => {} });
    expect(await loop.processOnce()).toBe(true);
    expect(java.completes).toHaveLength(1);
    expect(java.completes[0]!.body.ok).toBe(false);
    expect(java.completes[0]!.body.error).toMatch(/^OUTPUT:/);
  });

  it("검증 게이트 실패 → feedback 1회 재시도 → 2연속 실패면 ok:false VALIDATE", async () => {
    const ctx = makeTeamInputContext();
    java.queue.push({ id: "job-v", context: ctx });
    const calls: Array<string | undefined> = [];
    const badExecutor: AiExecutor = {
      name: "bad",
      execute: async (job, attempt) => {
        calls.push(attempt?.feedback);
        const t = (await stubExecutor().execute(job)) as { players: unknown[] };
        t.players.pop(); // 10명 → 게이트 실패
        return t;
      },
    };
    const loop = new ExecutorLoop(client(java), badExecutor, { log: () => {} });
    await loop.processOnce();

    expect(calls).toHaveLength(2); // 정확히 1회 재시도
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toMatch(/11명/); // 실패 사유가 feedback 으로 전달
    expect(java.completes[0]!.body.ok).toBe(false);
    expect(java.completes[0]!.body.error).toMatch(/^VALIDATE:/);
  });

  it("컨텍스트 kind 미지원 → ok:false VALIDATE", async () => {
    java.queue.push({ id: "job-k", context: { kind: "unknown-kind" } });
    const loop = new ExecutorLoop(client(java), stubExecutor(), { log: () => {} });
    await loop.processOnce();
    expect(java.completes[0]!.body.ok).toBe(false);
    expect(java.completes[0]!.body.error).toMatch(/^VALIDATE:/);
  });

  it("usage 계측: claude-code(러너 주입) onUsage → CacheMetrics 기록 + complete body 에 usage 동봉", async () => {
    const ctx = makeTeamInputContext();
    java.queue.push({ id: "job-u", context: ctx });

    // 유효 산출(로스터 id 정합)은 stub 으로 만들어 봉투에 싣는다 — claude-code 경로/usage 만 검증.
    const valid = await stubExecutor().execute({ id: "job-u", kind: "team-input", context: ctx });
    const runner: ClaudeRunner = () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: valid,
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
          total_cost_usd: 0.05,
        }),
        stderr: "",
        timedOut: false,
      });

    const metrics = new CacheMetrics();
    const usageByJob = new Map<string, JobUsage>();
    const executor = claudeCodeExecutor({
      runner,
      model: "haiku",
      onUsage: (u, jobId) => {
        usageByJob.set(jobId, u);
        metrics.recordUsage(u);
      },
    });
    const loop = new ExecutorLoop(client(java), executor, {
      takeUsage: (id) => usageByJob.get(id),
      log: () => {},
    });
    await loop.processOnce();

    expect(metrics.report().l2).toMatchObject({ jobs: 1, cacheReadTokens: 500, cacheCreateTokens: 100 });
    expect(java.completes[0]!.body.ok).toBe(true);
    expect(java.completes[0]!.body.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 500,
      cacheCreateTokens: 100,
      costUSD: 0.05,
    });
  });

  it("틀린 토큰 → 401 → poll throw(루프 run 은 로그 후 재시도 경로)", async () => {
    const loop = new ExecutorLoop(client(java, "wrong-token"), stubExecutor(), { log: () => {} });
    await expect(loop.processOnce()).rejects.toThrow(/401/);
  });

  it("run(stop): 대기 중(빈 큐 long-poll) abort → 진행 중 잡 없이 즉시 종료(SIGTERM 계약)", async () => {
    java.delay204Ms = 3_000; // long-poll 대기 흉내
    const loop = new ExecutorLoop(client(java), stubExecutor(), { log: () => {} });
    const stop = new AbortController();
    const done = loop.run(stop.signal);
    await new Promise((r) => setTimeout(r, 50)); // poll 대기 진입
    stop.abort();
    await expect(done).resolves.toBeUndefined(); // long-poll 이 끊기고 루프 종료
  });
});
