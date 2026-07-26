import { describe, it, expect, vi } from "vitest";
import { claudeCodeExecutor, type ClaudeRunner, type ClaudeRunResult } from "./claude-code.js";
import { makeTacticalInput } from "@hmb/engine";
import type { ExecutorJob } from "../kinds.js";
import { makeTeamInputContext, makeTeamInputPatchContext } from "../test-fixtures.js";

/** env 를 임시 치환하고 복원(테스트 격리). undefined 값 = 삭제. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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

    // #193: effort 노브 기본 low(사고 토큰 = 지연의 지배 변수) → --effort 가 args 에 포함.
    expect(last.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--json-schema",
      expect.any(String),
    ]);
    expect(JSON.parse(last.args[8]!)).toHaveProperty("type", "object"); // TacticalInput JSON Schema
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

  it("AI_EFFORT env 로 교체 — 빈 문자열이면 플래그 생략(세션 기본 사용)", async () => {
    const { runner, last } = fakeRunner({ stdout: envelope({ structured_output: makeTacticalInput("H", "42") }) });
    await withEnv({ AI_EFFORT: "high" }, async () => {
      await claudeCodeExecutor({ runner }).execute(job);
      expect(last.args).toContain("--effort");
      expect(last.args[last.args.indexOf("--effort") + 1]).toBe("high");
    });
    await withEnv({ AI_EFFORT: "" }, async () => {
      await claudeCodeExecutor({ runner }).execute(job);
      expect(last.args).not.toContain("--effort");
    });
  });

  it("kind 별 오버라이드: AI_EFFORT_FULL(team-input) · AI_EFFORT_PATCH(team-input-patch)", async () => {
    const { runner, last } = fakeRunner({ stdout: envelope({ structured_output: makeTacticalInput("H", "42") }) });
    const patchJob: ExecutorJob = {
      id: "p1",
      kind: "team-input-patch",
      context: makeTeamInputPatchContext(),
    };
    await withEnv({ AI_EFFORT: "low", AI_EFFORT_FULL: "medium", AI_EFFORT_PATCH: "high" }, async () => {
      const ex = claudeCodeExecutor({ runner });
      await ex.execute(job); // team-input → FULL
      expect(last.args[last.args.indexOf("--effort") + 1]).toBe("medium");
      await ex.execute(patchJob); // team-input-patch → PATCH
      expect(last.args[last.args.indexOf("--effort") + 1]).toBe("high");
    });
  });

  it("effort 옵션 주입이 env 보다 우선", async () => {
    const { runner, last } = fakeRunner({ stdout: envelope({ structured_output: makeTacticalInput("H", "42") }) });
    await withEnv({ AI_EFFORT: "high" }, async () => {
      await claudeCodeExecutor({ runner, effort: "low" }).execute(job);
      expect(last.args[last.args.indexOf("--effort") + 1]).toBe("low");
    });
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
