/**
 * #193 W2a 라운드1 변형 계측 — measure-ai-latency.ts 의 사본 확장 (계측 전용, 프로덕션 무접촉).
 *
 * 추가점:
 *  - `--suffix a1` : team-input 프롬프트 뒤에 A1 필수 확인 서픽스(마킹 매핑·개인 지시 반영·역할 존중).
 *  - kind=slices  : SLICES 를 보강판(SLICES2)으로 교체 — 각 슬라이스에 역할 존중·모순 금지 힌트,
 *                   players 슬라이스에 마킹→markTarget 정확 매핑 필수.
 *
 * 실행 예:
 *   npx tsx packages/server/scripts/measure-r1-latency.ts --kind team-input --model sonnet --effort low --n 1 --suffix a1 --dump <dir>
 *   npx tsx packages/server/scripts/measure-r1-latency.ts --kind slices --model sonnet --effort low --dump <dir>
 * (구독 세션 사용: ANTHROPIC_API_KEY unset 강제)
 */
import { spawn } from "node:child_process";
import { KINDS, type AiJobKind } from "../src/executor/kinds.js";
import {
  makeConditions,
  makeManualTactics,
  makeOpponentRoster,
  makeRelations,
  makeTeamInputContext,
  makeTeamInputPatchContext,
  homeRosterIds,
} from "../src/executor/test-fixtures.js";

interface Envelope {
  is_error?: boolean;
  subtype?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Record<string, number>;
  result?: string;
  structured_output?: unknown;
}

interface Sample {
  kind: string;
  iter: number;
  promptChars: number;
  wallMs: number;
  durationMs: number | null;
  apiMs: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  outputTokens: number;
  costUSD: number;
  ok: boolean;
  note?: string;
}

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : dflt;
};

const N = Number(arg("n", "1"));
const MODEL = arg("model", "sonnet");
const WHICH = arg("kind", "team-input"); // team-input | team-input-patch | slices
const DUMP = arg("dump", "");
const EFFORT = arg("effort", "");
const SUFFIX = arg("suffix", ""); // "a1" = A1 필수 확인 서픽스

/** 정액제 가드 — 키가 있으면 종량으로 샌다. */
if (process.env["ANTHROPIC_API_KEY"]) {
  console.warn("[measure-r1] ANTHROPIC_API_KEY unset 강제(구독 세션 유지)");
  delete process.env["ANTHROPIC_API_KEY"];
}

function runClaude(
  args: string[],
  prompt: string,
  timeoutMs = Number(process.env["MEASURE_TIMEOUT_MS"] ?? 180_000),
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
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
      resolve({ stdout, stderr: `${stderr}${String(e)}`, code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** measure-ai-latency.ts fullContext 와 동일 소재(비교 가능성 유지). */
function fullContext(kind: AiJobKind): unknown {
  const ids = homeRosterIds();
  const playerPrompts: Record<string, string> = {};
  ids.slice(0, 5).forEach((id, i) => {
    playerPrompts[id] = [
      "상대 풀백 뒤 공간을 계속 노려라. 볼 없을 때 하프스페이스로 침투하고, 뒤에서 커버가 늦으면 바로 뒤로 달려라.",
      "빌드업에서는 낮게 내려와 받아주고, 전환 순간에는 한 번에 전진 패스를 시도해라.",
      "상대 10번을 계속 따라다녀라. 볼을 뺏으면 곧바로 전방으로 붙여라.",
      "측면을 넓게 벌려 크로스 각을 만들고, 반대 윙이 들어오는 타이밍에 맞춰라.",
      "박스 안에서 기다리지 말고 니어포스트로 먼저 움직여 수비를 끌어라.",
    ][i] as string;
  });
  const common = {
    teamPrompt:
      "전방압박을 강하게 유지하되 뒤 공간이 열리면 라인을 내려라. 측면 전환 빠르게, 박스 안에서는 슛보다 확실한 각을 만들어라.",
    playerPrompts,
    manualTactics: makeManualTactics(),
    conditions: makeConditions(),
    teamMorale: { morale: 62, streak: 2 },
    relations: makeRelations(),
    opponentRoster: makeOpponentRoster(),
  };
  return kind === "team-input"
    ? makeTeamInputContext(common)
    : makeTeamInputPatchContext(common);
}

/** A1 — 베이스 생성(effort low)의 품질 손실 회복용 필수 확인 서픽스. */
const A1_SUFFIX = [
  "",
  "── 필수 확인 ──",
  "마킹/맨마킹 지시가 있으면 해당 선수의 markTarget 에 상대 playerId 를 반드시 설정(상대 로스터에서 정확히 매칭).",
  "개인 지시가 있는 선수는 해당 축을 반드시 반영.",
  "GK 에게는 공격 침투 성향을 주지 않는다(역할 존중).",
].join("\n");

/** 공통 슬라이스 힌트(A3) — 역할 존중·모순 금지. */
const SLICE_COMMON_HINT = [
  "역할을 존중하라(예: GK 에게 공격 침투 성향을 주지 않는다).",
  "다른 슬라이스와 합쳐졌을 때 자기모순이 없도록 일관된 방향으로 판단하라(예: 낮은 라인 + 높은 압박 트리거 금지).",
].join(" ");

/** A3 — 슬라이스 보강판: 프롬프트 컨텍스트는 그대로, 출력 범위만 쪼개되 정합성 힌트 추가. */
const SLICES2: Record<string, string> = {
  team: [
    "",
    "── 이번 응답 범위 ──",
    "위 지시 전체를 근거로 판단하되, **이번에는 `team` 축만** 출력한다(byPosition/byPlayer/markTargets 생략).",
    SLICE_COMMON_HINT,
    "설명·산문 없이 구조화 출력만.",
  ].join("\n"),
  groups: [
    "",
    "── 이번 응답 범위 ──",
    "위 지시 전체를 근거로 판단하되, **이번에는 `byPosition`(포지션 그룹) 만** 출력한다(team/byPlayer/markTargets 생략).",
    SLICE_COMMON_HINT,
    "설명·산문 없이 구조화 출력만.",
  ].join("\n"),
  players: [
    "",
    "── 이번 응답 범위 ──",
    "위 지시 전체를 근거로 판단하되, **이번에는 `byPlayer` 와 `markTargets` 만** 출력한다(team/byPosition 생략).",
    "개인 지시가 있는 선수는 빠뜨리지 말 것.",
    "마킹/맨마킹 지시가 있으면 해당 선수의 markTarget(markTargets)에 상대 playerId 를 **반드시 정확히 매핑**한다(상대 로스터에서 매칭).",
    SLICE_COMMON_HINT,
    "설명·산문 없이 구조화 출력만.",
  ].join("\n"),
};

async function sampleKind(kind: AiJobKind, iter: number, slice?: string): Promise<Sample> {
  const spec = KINDS[kind];
  const ctx = fullContext(kind);
  const prompt =
    spec.buildPrompt(ctx) +
    (SUFFIX === "a1" ? A1_SUFFIX : "") +
    (slice ? (SLICES2[slice] ?? "") : "");
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    MODEL,
    ...(EFFORT ? ["--effort", EFFORT] : []),
    "--json-schema",
    JSON.stringify(spec.jsonSchema()),
  ];

  const t0 = performance.now();
  const res = await runClaude(args, prompt);
  const wallMs = performance.now() - t0;

  let env: Envelope | null = null;
  try {
    env = JSON.parse(res.stdout.trim()) as Envelope;
  } catch {
    /* 파싱 실패 */
  }
  const u = env?.usage ?? {};
  if (DUMP) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${DUMP}/${kind}-${iter}.prompt.txt`, prompt);
    writeFileSync(`${DUMP}/${kind}-${iter}.envelope.json`, JSON.stringify(env, null, 2));
  }
  return {
    kind: slice ? `patch/${slice}` : SUFFIX ? `${kind}+${SUFFIX}` : kind,
    iter,
    promptChars: prompt.length,
    wallMs: Math.round(wallMs),
    durationMs: env?.duration_ms ?? null,
    apiMs: env?.duration_api_ms ?? null,
    inputTokens: u["input_tokens"] ?? 0,
    cacheReadTokens: u["cache_read_input_tokens"] ?? 0,
    cacheCreateTokens: u["cache_creation_input_tokens"] ?? 0,
    outputTokens: u["output_tokens"] ?? 0,
    costUSD: env?.total_cost_usd ?? 0,
    ok: env !== null && env.is_error !== true,
    note: env === null ? `parse-fail: ${(res.stderr || res.stdout || "").slice(0, 200)}` : undefined,
  };
}

function row(s: Sample): string {
  const spawnOv = s.durationMs === null ? "?" : String(s.wallMs - s.durationMs);
  const cliOv = s.durationMs === null || s.apiMs === null ? "?" : String(s.durationMs - s.apiMs);
  return [
    s.kind.padEnd(18),
    `#${s.iter}`,
    `wall=${(s.wallMs / 1000).toFixed(1)}s`,
    `api=${s.apiMs === null ? "?" : (s.apiMs / 1000).toFixed(1) + "s"}`,
    `cli=${cliOv}ms`,
    `spawn=${spawnOv}ms`,
    `in=${s.inputTokens}`,
    `cacheR=${s.cacheReadTokens}`,
    `cacheW=${s.cacheCreateTokens}`,
    `out=${s.outputTokens}`,
    `chars=${s.promptChars}`,
    s.ok ? "" : `FAIL ${s.note ?? ""}`,
  ].join(" ");
}

async function main(): Promise<void> {
  const samples: Sample[] = [];
  console.log(
    `[measure-r1] model=${MODEL} n=${N} kind=${WHICH} effort=${EFFORT || "(session default)"} suffix=${SUFFIX || "(none)"}`,
  );

  if (WHICH === "slices") {
    // 3슬라이스 동시(병렬 예외 허용 범위) — 벽시계 = max(슬라이스).
    const names = Object.keys(SLICES2);
    const t0 = performance.now();
    const batch = await Promise.all(names.map((s, i) => sampleKind("team-input-patch", i + 1, s)));
    const batchWall = Math.round(performance.now() - t0);
    batch.forEach((s) => {
      samples.push(s);
      console.log(row(s));
    });
    console.log(
      `SLICES2 parallel=${names.length} batchWall=${(batchWall / 1000).toFixed(1)}s ` +
        `(max=${(Math.max(...batch.map((b) => b.wallMs)) / 1000).toFixed(1)}s · sum=${(batch.reduce((a, b) => a + b.wallMs, 0) / 1000).toFixed(1)}s · ` +
        `outTokens=${batch.map((b) => b.outputTokens).join("+")})`,
    );
  } else {
    for (let i = 1; i <= N; i++) {
      const s = await sampleKind(WHICH as AiJobKind, i);
      samples.push(s);
      console.log(row(s));
    }
  }

  console.log("\n--- JSON ---");
  console.log(JSON.stringify(samples, null, 2));
}

void main();
