import { spawn } from "node:child_process";
import type { AiExecutor } from "../executor.js";
import type { AiJob } from "../protocol.js";
import { KINDS } from "../kinds.js";
import { parseUsage, type JobUsage } from "../metrics.js";

/**
 * claude-code executor — 정액제(구독) 헤드리스 실행 (에픽 #32 옵션 D, hero 승인 2026-07-11).
 * 잡 1건 = `claude -p --output-format json --model <AI_MODEL> --json-schema <스키마>` subprocess 1회.
 * 인증: `ANTHROPIC_API_KEY` 없으면 로컬 `claude` 로그인(구독)으로 과금 — 키 있으면 메터드로 샘.
 * Agent SDK 미사용(zod v4 peer 충돌 회피, 프리즈 shared 무변경).
 */

/** claude CLI 실행 결과. */
export interface ClaudeRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 주입 가능한 러너(테스트 = 로그인 0). 기본은 실제 `claude` subprocess. */
export type ClaudeRunner = (args: string[], prompt: string, timeoutMs: number) => Promise<ClaudeRunResult>;

export interface ClaudeCodeOptions {
  /** 서브에이전트 모델(별칭 sonnet|haiku|opus 또는 풀ID). 기본 env AI_MODEL → "sonnet". */
  model?: string;
  /** 잡당 강제 타임아웃(ms). 기본 env AI_JOB_TIMEOUT_MS → 120000. */
  timeoutMs?: number;
  /** 러너 주입(테스트/모의). 미지정 시 실제 claude subprocess. */
  runner?: ClaudeRunner;
  /** W3 AC1: 잡당 토큰 usage 콜백(CacheMetrics.recordUsage 연결). 미지정 시 로그만. */
  onUsage?: (usage: JobUsage, jobId: string, model: string) => void;
}

const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MS = 120_000;

/** 실제 `claude` subprocess 러너 — 프롬프트는 stdin, 결과는 stdout(JSON 봉투). */
function spawnRunner(): ClaudeRunner {
  return (args, prompt, timeoutMs) =>
    new Promise<ClaudeRunResult>((resolve) => {
      const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: `${stderr}${String(e)}`, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr, timedOut });
      });
      child.stdin.on("error", () => {
        /* 자식 조기 종료 시 EPIPE 무시 */
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
}

/** 실패 분류(에픽 §5) — 폴백 스위치 판단 근거. */
function classify(text: string): "AUTH" | "CAP" | "OUTPUT" {
  if (/unauthor|authentication|not logged|log ?in|credential|api[_ ]?key|invalid[_ ]?key|401|403|forbidden/i.test(text)) {
    return "AUTH";
  }
  if (/rate[_ ]?limit|overloaded|quota|usage limit|too many requests|429|529|capacity|resource[_ ]?exhausted/i.test(text)) {
    return "CAP";
  }
  return "OUTPUT";
}

/** result 텍스트에서 JSON 블록 추출(구조화 출력 폴백). */
function extractJson(text: string): unknown | null {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

/** usage 계측(W3 AC1) — 봉투에 있으면 잡당 로그 + onUsage 콜백(리포트 집계 원천). 없으면 생략. */
function reportUsage(
  jobId: string,
  model: string,
  env: Record<string, unknown>,
  onUsage?: (usage: JobUsage, jobId: string, model: string) => void,
): void {
  const usage = parseUsage(env);
  if (usage === null) return;
  console.log(
    `[claude-code] job=${jobId.slice(0, 8)} model=${model} in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadTokens} cacheCreate=${usage.cacheCreateTokens} costUSD=${usage.costUSD}`,
  );
  onUsage?.(usage, jobId, model);
}

export function claudeCodeExecutor(opts: ClaudeCodeOptions = {}): AiExecutor {
  const model = opts.model ?? process.env["AI_MODEL"] ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? Number(process.env["AI_JOB_TIMEOUT_MS"] ?? DEFAULT_TIMEOUT_MS);
  const runner = opts.runner ?? spawnRunner();
  const onUsage = opts.onUsage;

  return {
    name: `claude-code:${model}`,
    async execute(job: AiJob, attempt?: { feedback: string }): Promise<unknown> {
      const spec = KINDS[job.kind];
      const prompt = spec.buildPrompt(job.context, attempt?.feedback);
      const args = [
        "-p",
        "--output-format",
        "json",
        "--model",
        model,
        "--json-schema",
        JSON.stringify(spec.jsonSchema()),
      ];

      const res = await runner(args, prompt, timeoutMs);
      if (res.timedOut) {
        throw new Error(`TIMEOUT: claude 응답 ${timeoutMs}ms 초과 (model=${model})`);
      }

      let env: Record<string, unknown> | null = null;
      try {
        env = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
      } catch {
        const text = res.stderr || res.stdout || `exit ${res.code}`;
        throw new Error(`${classify(text)}: claude 출력 파싱 실패 — ${text.slice(0, 300)}`);
      }

      if (env["is_error"] === true || (env["subtype"] !== undefined && env["subtype"] !== "success")) {
        const text = String(env["result"] ?? env["api_error_status"] ?? env["subtype"] ?? "unknown");
        throw new Error(`${classify(text)}: claude 오류 — ${text.slice(0, 300)}`);
      }

      reportUsage(job.id, model, env, onUsage);

      // 구조화 출력 우선 → result 문자열 파싱 → JSON 블록 추출 순.
      const structured = env["structured_output"];
      if (structured !== null && typeof structured === "object") {
        return structured;
      }
      const resultStr = typeof env["result"] === "string" ? (env["result"] as string) : "";
      try {
        return JSON.parse(resultStr);
      } catch {
        /* 폴백 추출 */
      }
      const extracted = extractJson(resultStr);
      if (extracted !== null) return extracted;
      throw new Error(`OUTPUT: 구조화 출력 없음 + result JSON 파싱 실패 — ${resultStr.slice(0, 200)}`);
    },
  };
}

/** 워커 기동 시 인증 self-check(AC2) — claude-code executor 일 때만 호출. */
export function claudeCodeAuthSelfCheck(): void {
  if (process.env["ANTHROPIC_API_KEY"]) {
    console.warn(
      "[claude-code] ⚠️ ANTHROPIC_API_KEY 설정됨 — 메터드 과금 경로로 샐 수 있음. 정액제(구독) 의도면 unset 하세요.",
    );
  } else {
    console.log("[claude-code] ANTHROPIC_API_KEY 미설정 → 구독 로그인(정액제)으로 동작 (사전 `claude` 로그인 필요).");
  }
}
