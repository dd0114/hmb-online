import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TacticalInput } from "@hmb/shared";
import { ExecutorLoop, prepareExecutorEnv, parsePollWaitMs, parseConcurrency } from "./executor-main.js";
import { JavaClient } from "./java-client.js";
import { stubExecutor } from "./executors/stub.js";
import { claudeCodeExecutor, type ClaudeRunner } from "./executors/claude-code.js";
import { CacheMetrics, type JobUsage } from "./metrics.js";
import type { AiExecutor } from "./executor.js";
import { makeTeamInputContext, makeTeamInputPatchContext } from "./test-fixtures.js";
import { makeBaseTacticalInput, makeOpponentRoster } from "./test-fixtures.js";

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

  it("concurrency=2: 두 잡을 동시 처리(병렬) — 둘 다 in-flight 후에야 진행(①)", async () => {
    java.queue.push({ id: "job-a", context: makeTeamInputContext() });
    java.queue.push({ id: "job-b", context: makeTeamInputContext() });
    java.delay204Ms = 30; // 빈 큐 재폴 hot-spin 방지

    let inflight = 0;
    let maxInflight = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const gated: AiExecutor = {
      name: "gated",
      execute: async (job, attempt) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        if (inflight >= 2) release(); // 둘 다 진입해야 barrier 해제 → concurrency=1 이면 영영 안 열림
        await barrier;
        const out = await stubExecutor().execute(job, attempt);
        inflight -= 1;
        return out;
      },
    };

    const stop = new AbortController();
    const loop = new ExecutorLoop(client(java), gated, { concurrency: 2, log: () => {} });
    const done = loop.run(stop.signal);
    await vi.waitFor(() => expect(java.completes).toHaveLength(2), { timeout: 3_000 });
    stop.abort();
    await done;

    expect(maxInflight).toBe(2); // 동시 2개 in-flight = 병렬 증명
    expect(java.completes.every((c) => c.body.ok)).toBe(true);
  });

  it("concurrency 기본=1: 순차 처리(기존 동작 불변)", async () => {
    java.queue.push({ id: "seq-1", context: makeTeamInputContext() });
    java.queue.push({ id: "seq-2", context: makeTeamInputContext() });
    let inflight = 0;
    let maxInflight = 0;
    const tracked: AiExecutor = {
      name: "tracked",
      execute: async (job, attempt) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 20));
        const out = await stubExecutor().execute(job, attempt);
        inflight -= 1;
        return out;
      },
    };
    const loop = new ExecutorLoop(client(java), tracked, { log: () => {} }); // concurrency 미지정 → 1
    expect(await loop.processOnce()).toBe(true);
    expect(await loop.processOnce()).toBe(true);
    expect(maxInflight).toBe(1); // 한 번에 하나
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

  it("run(stop): 잡 실행 도중 abort → 진행 중 잡의 complete 가 착지한 뒤 종료(SIGTERM 계약)", async () => {
    java.queue.push({ id: "job-sig", context: makeTeamInputContext() });
    const stop = new AbortController();
    const slow: AiExecutor = {
      name: "slow-stub",
      execute: async (job, attempt) => {
        stop.abort(); // 실행 중간에 SIGTERM 도착
        await new Promise((r) => setTimeout(r, 100)); // 잡이 아직 진행 중
        return stubExecutor().execute(job, attempt);
      },
    };
    const loop = new ExecutorLoop(client(java), slow, { log: () => {} });
    await loop.run(stop.signal); // resolve 시점 = 루프 종료

    // 종료 전에 진행 중이던 잡이 완주해 complete 가 이미 착지해 있어야 한다.
    expect(java.completes).toHaveLength(1);
    expect(java.completes[0]!.id).toBe("job-sig");
    expect(java.completes[0]!.body.ok).toBe(true);
    expect(TacticalInput.parse(java.completes[0]!.body.output).players).toHaveLength(11);
  });
});

describe("AI실행기 폴링 루프 — B(team-input-patch) 잡 라우팅 (A+B, W3)", () => {
  let java: FakeJava;
  beforeEach(async () => {
    java = new FakeJava();
    await java.start();
  });
  afterEach(async () => {
    await java.stop();
  });

  it("team-input-patch 잡 → stub 패치 → 게이트가 applyPatch → 최종 TacticalInput 으로 complete(ok:true)", async () => {
    const ctx = makeTeamInputPatchContext({ teamPrompt: "하이라인·와이드 공격" });
    java.queue.push({ id: "patch-1", context: ctx });

    const loop = new ExecutorLoop(client(java), stubExecutor(), { log: () => {} });
    expect(await loop.processOnce()).toBe(true);

    expect(java.completes).toHaveLength(1);
    const c = java.completes[0]!;
    expect(c.body.ok).toBe(true);
    // Java 는 team-input 과 동일하게 완전한 TacticalInput 을 받는다(패치는 실행기 내부 세부).
    const out = TacticalInput.parse(c.body.output);
    expect(out.players).toHaveLength(11);
    expect(out.team.defensiveLineHeight).toBe(0.85); // 공격 지시 반영
    expect(out.seed).toBe(ctx.seed); // halfSeed 주입
  });

  it("team-input(구계약) 잡은 patch 도입 후에도 그대로 동작(하위 호환)", async () => {
    const ctx = makeTeamInputContext({ teamPrompt: "하이라인·와이드 공격" });
    java.queue.push({ id: "legacy-1", context: ctx });
    const loop = new ExecutorLoop(client(java), stubExecutor(), { log: () => {} });
    await loop.processOnce();
    const out = TacticalInput.parse(java.completes[0]!.body.output);
    expect(out.players).toHaveLength(11);
    expect(out.team.defensiveLineHeight).toBeGreaterThan(0.7);
  });

  it("게이트 위반(#193 G1) → throw 메시지가 그대로 1회 재시도 feedback 으로 전달되고, 고친 산출은 ok:true", async () => {
    // 1회차: 낮은 라인 + 오프사이드 트랩(자기모순 패치) → 게이트 throw. 2회차: 트랩을 끄고 재제출.
    const ctx = makeTeamInputPatchContext({ teamPrompt: "라인 내리고 콤팩트하게" });
    java.queue.push({ id: "patch-gate", context: ctx });
    const feedbacks: (string | undefined)[] = [];
    let call = 0;
    const flaky: AiExecutor = {
      name: "flaky",
      execute: (_job, attempt) => {
        feedbacks.push(attempt?.feedback);
        call += 1;
        return Promise.resolve(
          call === 1
            ? { team: { defensiveLineHeight: 0.15, offsideTrap: true } }
            : { team: { defensiveLineHeight: 0.15, offsideTrap: false } },
        );
      },
    };
    const loop = new ExecutorLoop(client(java), flaky, { log: () => {} });
    await loop.processOnce();

    expect(call).toBe(2);
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain("오프사이드트랩"); // 게이트 메시지가 곧 피드백
    const c = java.completes[0]!;
    expect(c.body.ok).toBe(true);
    expect(TacticalInput.parse(c.body.output).team.offsideTrap).toBe(false);
  });

  it("게이트 위반이 2회 연속이면 VALIDATE 로 실패 complete(기존 의미론)", async () => {
    const ctx = makeTeamInputPatchContext({ teamPrompt: "라인 내리고 콤팩트하게" });
    java.queue.push({ id: "patch-gate-fail", context: ctx });
    const stubborn: AiExecutor = {
      name: "stubborn",
      execute: () => Promise.resolve({ team: { defensiveLineHeight: 0.1, offsideTrap: true } }),
    };
    await new ExecutorLoop(client(java), stubborn, { log: () => {} }).processOnce();
    const c = java.completes[0]!;
    expect(c.body.ok).toBe(false);
    expect(c.body.error).toMatch(/^VALIDATE:/);
    expect(c.body.error).toContain("오프사이드트랩");
  });

  it("스텁도 게이트 피드백으로 자기 산출을 고친다 — 1회차 위반 → 2회차 ok:true (#193 검증 M-2)", async () => {
    // 베이스가 이미 자기모순(낮은 라인 + 트랩)이라 무관한 지시의 빈 패치는 그대로 G1 위반이 된다.
    const base = makeBaseTacticalInput();
    const ctx = makeTeamInputPatchContext({
      teamPrompt: "무난하게 운영",
      base: { ...base, team: { ...base.team, offsideTrap: true, defensiveLineHeight: 0.1 } },
    });
    java.queue.push({ id: "patch-stub-retry", context: ctx });

    await new ExecutorLoop(client(java), stubExecutor(), { log: () => {} }).processOnce();

    const c = java.completes[0]!;
    expect(c.body.ok).toBe(true); // 피드백을 무시하면 2연속 실패 → VALIDATE 였다
    expect(TacticalInput.parse(c.body.output).team.offsideTrap).toBe(false);
  });

  it("patch 마킹 잡: 개인 지시 '<상대> 막아' → 최종 markTarget 착지", async () => {
    const ctx = makeTeamInputPatchContext({
      opponentRoster: makeOpponentRoster(),
      playerPrompts: { H2: "A9 막아" },
    });
    java.queue.push({ id: "patch-mark", context: ctx });
    const loop = new ExecutorLoop(client(java), stubExecutor(), { log: () => {} });
    await loop.processOnce();
    const out = TacticalInput.parse(java.completes[0]!.body.output);
    expect(out.players.find((p) => p.playerId === "H2")!.markTarget).toBe("A9");
  });
});

describe("executor-main env 헬퍼", () => {
  it("prepareExecutorEnv: ANTHROPIC_API_KEY 를 강제 unset(정액제 가드)", () => {
    const prev = process.env["ANTHROPIC_API_KEY"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["ANTHROPIC_API_KEY"] = "sk-should-be-removed";
      prepareExecutorEnv("stub");
      expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes("ANTHROPIC_API_KEY"))).toBe(true);
    } finally {
      warn.mockRestore();
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  it("prepareExecutorEnv: 키 미설정이면 아무것도 지우지 않는다(멱등)", () => {
    const prev = process.env["ANTHROPIC_API_KEY"];
    try {
      delete process.env["ANTHROPIC_API_KEY"];
      prepareExecutorEnv("stub");
      expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  it("parsePollWaitMs: [1000, 25000] 클램프 + 비수치 → 기본 25000", () => {
    expect(parsePollWaitMs(undefined)).toBe(25_000);
    expect(parsePollWaitMs("25000")).toBe(25_000);
    expect(parsePollWaitMs("99999")).toBe(25_000); // openapi 상한
    expect(parsePollWaitMs("1")).toBe(1_000); // 하한
    expect(parsePollWaitMs("5000")).toBe(5_000);
    expect(parsePollWaitMs("abc")).toBe(25_000); // NaN → 기본
  });

  it("parseConcurrency: 기본 2, [1, 8] 클램프, 비수치→2 (①)", () => {
    expect(parseConcurrency(undefined)).toBe(2); // 기본 = 2 (home/away 동시)
    expect(parseConcurrency("2")).toBe(2);
    expect(parseConcurrency("1")).toBe(1);
    expect(parseConcurrency("0")).toBe(1); // 하한
    expect(parseConcurrency("99")).toBe(8); // 상한
    expect(parseConcurrency("2.9")).toBe(2); // floor
    expect(parseConcurrency("abc")).toBe(2); // NaN → 기본
  });
});
