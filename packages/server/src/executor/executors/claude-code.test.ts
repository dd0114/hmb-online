import { describe, it, expect, vi } from "vitest";
import { claudeCodeExecutor, type ClaudeRunner, type ClaudeRunResult } from "./claude-code.js";
import { makeTacticalInput } from "@hmb/engine";
import type { ExecutorJob } from "../kinds.js";
import { makeTeamInputContext } from "../test-fixtures.js";

// claude CLI 러너를 주입해 로그인/키 0 으로 executor 를 검증(구 W2 스위트 → team-input 으로 이관).
const job: ExecutorJob = {
  id: "abcd1234abcd1234",
  kind: "team-input",
  context: makeTeamInputContext({ teamPrompt: "풀백 오버랩·와이드" }),
};

/** 봉투를 흉내내는 러너 팩토리. 마지막 호출 args/prompt 를 캡처. */
function fakeRunner(result: Partial<ClaudeRunResult>): { runner: ClaudeRunner; last: { args: string[]; prompt: string } } {
  const last = { args: [] as string[], prompt: "" };
  const runner: ClaudeRunner = (args, prompt) => {
    last.args = args;
    last.prompt = prompt;
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ...result });
  };
  return { runner, last };
}

const envelope = (extra: Record<string, unknown>): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 5, output_tokens: 9 }, total_cost_usd: 0.01, ...extra });

describe("claude-code executor (러너 주입)", () => {
  it("모델 스왑 + json-schema + prompt(팀 지시/로스터) 전달, structured_output 반환", async () => {
    const valid = makeTacticalInput("H", "42");
    const { runner, last } = fakeRunner({ stdout: envelope({ structured_output: valid }) });
    const out = await claudeCodeExecutor({ model: "haiku", runner }).execute(job);

    expect(last.args).toEqual(["-p", "--output-format", "json", "--model", "haiku", "--json-schema", expect.any(String)]);
    expect(JSON.parse(last.args[6]!)).toHaveProperty("type", "object"); // TacticalInput JSON Schema
    expect(last.prompt).toContain("풀백 오버랩·와이드"); // 팀 지시
    expect(last.prompt).toContain("H0"); // 로스터 playerId
    expect((out as { players: unknown[] }).players).toHaveLength(11);
  });

  it("name 에 모델 반영 + 재시도 feedback 이 프롬프트에 포함", async () => {
    const { runner, last } = fakeRunner({ stdout: envelope({ structured_output: makeTacticalInput("H", "42") }) });
    const ex = claudeCodeExecutor({ model: "sonnet", runner });
    expect(ex.name).toBe("claude-code:sonnet");
    await ex.execute(job, { feedback: "선수는 11명이어야 함 (got 10)" });
    expect(last.prompt).toContain("이전 산출 거부됨");
    expect(last.prompt).toContain("11명");
  });

  it("structured_output 없고 result 에 JSON 텍스트 → 폴백 파싱", async () => {
    const valid = makeTacticalInput("H", "42");
    const { runner } = fakeRunner({ stdout: envelope({ result: "여기 결과입니다:\n```json\n" + JSON.stringify(valid) + "\n```" }) });
    const out = await claudeCodeExecutor({ runner }).execute(job);
    expect((out as { players: unknown[] }).players).toHaveLength(11);
  });

  it("구조화 출력도 JSON 도 없음 → OUTPUT throw", async () => {
    const { runner } = fakeRunner({ stdout: envelope({ result: "죄송하지만 못 하겠습니다." }) });
    await expect(claudeCodeExecutor({ runner }).execute(job)).rejects.toThrow(/^OUTPUT:/);
  });

  it("타임아웃 → TIMEOUT throw", async () => {
    const { runner } = fakeRunner({ timedOut: true });
    await expect(claudeCodeExecutor({ runner, timeoutMs: 10 }).execute(job)).rejects.toThrow(/^TIMEOUT:/);
  });

  it("인증 오류 봉투 → AUTH 분류", async () => {
    const { runner } = fakeRunner({ stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Authentication failed: please log in" }) });
    await expect(claudeCodeExecutor({ runner }).execute(job)).rejects.toThrow(/^AUTH:/);
  });

  it("레이트리밋/캡 텍스트(비-JSON stderr) → CAP 분류", async () => {
    const { runner } = fakeRunner({ stdout: "", stderr: "Error: usage limit reached (429)", code: 1 });
    await expect(claudeCodeExecutor({ runner }).execute(job)).rejects.toThrow(/^CAP:/);
  });

  it("usage 계측: 봉투의 cacheRead·cost·model 을 잡당 로그 + onUsage 콜백", async () => {
    const { runner } = fakeRunner({
      stdout: envelope({
        structured_output: makeTacticalInput("H", "42"),
        usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 123, cache_creation_input_tokens: 456 },
        total_cost_usd: 0.02,
      }),
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    const usages: unknown[] = [];
    await claudeCodeExecutor({ runner, model: "haiku", onUsage: (u) => usages.push(u) }).execute(job);
    spy.mockRestore();
    const line = logs.find((l) => l.includes("[claude-code]"));
    expect(line).toBeTruthy();
    expect(line).toContain("model=haiku");
    expect(line).toContain("cacheRead=123");
    expect(line).toContain("cacheCreate=456");
    expect(line).toContain("costUSD=0.02");
    expect(usages).toEqual([
      { inputTokens: 5, outputTokens: 9, cacheReadTokens: 123, cacheCreateTokens: 456, costUSD: 0.02 },
    ]);
  });

  it("모델 스왑: AI_MODEL env 로 교체(기본 sonnet)", async () => {
    const { runner, last } = fakeRunner({ stdout: envelope({ structured_output: makeTacticalInput("H", "42") }) });
    const prev = process.env["AI_MODEL"];
    try {
      process.env["AI_MODEL"] = "opus";
      const ex = claudeCodeExecutor({ runner }); // model 미지정 → env 사용
      expect(ex.name).toBe("claude-code:opus");
      await ex.execute(job);
      expect(last.args).toContain("opus");
    } finally {
      if (prev === undefined) delete process.env["AI_MODEL"];
      else process.env["AI_MODEL"] = prev;
    }
  });
});
