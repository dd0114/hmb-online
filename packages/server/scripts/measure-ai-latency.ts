/**
 * AI 잡 지연 계측 (#193 W1) — "게임시작 후 대기"의 AI 성분을 분해한다.
 *
 * 프로덕션 경로와 동일한 인자로 `claude` CLI 를 직접 띄우고(executors/claude-code.ts 와 같은 args),
 * 봉투의 `duration_ms`/`duration_api_ms`/`usage` 를 그대로 받아 **CLI 부팅 vs API 시간 vs 캐시**를 분리한다.
 *
 *   wall            = 프로세스 spawn ~ 종료 (유저가 기다리는 실제 시간)
 *   duration_ms     = claude 프로세스가 스스로 측정한 총 시간
 *   duration_api_ms = 모델 API 왕복
 *   spawn overhead  = wall − duration_ms  (node/CLI 부팅)
 *   cli overhead    = duration_ms − duration_api_ms (CLI 내부 준비)
 *
 * 실행: npx tsx packages/server/scripts/measure-ai-latency.ts --n 3 --kind both
 *      (계측만 — 서버/데모 스택 무접촉. 구독 세션 사용: ANTHROPIC_API_KEY unset 강제)
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

const N = Number(arg("n", "3"));
const MODEL = arg("model", process.env["AI_MODEL"] ?? "sonnet");
const WHICH = arg("kind", "both"); // team-input | team-input-patch | both | baseline
/** >1 이면 그 수만큼 동시 실행(프로덕션 home/away 병렬 재현). */
const PARALLEL = Number(arg("parallel", "1"));
/** 디렉토리를 주면 프롬프트·응답 봉투를 덤프(출력 토큰 구성 진단). */
const DUMP = arg("dump", "");
/** kind=lean 또는 --lean 이면 출력 제약 변형(team-input-patch+lean)을 먼저 측정. */
const LEAN = WHICH === "lean" || argv.includes("--lean");
/**
 * `claude --effort <low|medium|high|xhigh|max>` — 사고(thinking) 예산. 프로덕션 executor 는 이 인자를
 * 넘기지 않아 세션 기본값을 쓴다. 실측상 출력 토큰의 99%가 답이 아니라 사고라서 지연의 주 노브.
 */
const EFFORT = arg("effort", "");

/** 정액제 가드(LLD §5 함정) — 키가 있으면 종량으로 샌다. */
if (process.env["ANTHROPIC_API_KEY"]) {
  console.warn("[measure] ANTHROPIC_API_KEY unset 강제(구독 세션 유지)");
  delete process.env["ANTHROPIC_API_KEY"];
}

/** 프로덕션 spawnRunner 와 동일 형태 — 단, 봉투 원문을 그대로 돌려준다. */
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

/**
 * 실전에 가까운 컨텍스트 — Java PromptContextBuilder.buildUserContext 가 싣는 블록 전부
 * (manualTactics·conditions·teamMorale·relations·opponentRoster·playerPrompts)를 채운다.
 * 프롬프트 길이가 곧 입력 토큰이라, 블록을 비우면 지연이 과소 측정된다.
 */
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

/**
 * 출력 축소 후보(#193 R5 검증용) — 프로덕션 프롬프트 뒤에 **출력 제약**만 덧붙인다.
 * 지연이 출력 토큰에 선형(99tok/s)이므로, "지시가 닿는 것만 쓰라"를 강제했을 때 실제로
 * 출력이 줄고 그만큼 빨라지는지를 본다(프로덕션 코드는 건드리지 않는다).
 */
const LEAN_SUFFIX = [
  "",
  "── 출력 제약(반드시 지킬 것) ──",
  "- 위 지시가 **명시적으로 언급한** 팀 축·포지션 그룹·선수만 패치한다. 언급 없는 것은 필드 자체를 생략한다.",
  "- byPlayer 는 **최대 3명**. 그룹으로 표현 가능하면 byPosition 을 쓰고 byPlayer 를 쓰지 않는다.",
  "- 한 대상에 대해 지시와 무관한 축을 채우지 않는다(추측 금지).",
  "- 설명·주석·산문을 출력하지 않는다. 구조화 출력만 낸다.",
].join("\n");

/**
 * 슬라이스 변형(#193 R6′ 검증용) — **프롬프트 컨텍스트는 그대로 전부 주고**(자유도 불변)
 * "이번에는 이 부분만 써라"로 출력 범위만 쪼갠다. 여러 슬라이스를 병렬로 돌려 벽시계 = max(슬라이스)
 * 가 되는지, 슬라이스당 사고 토큰이 실제로 줄는지 본다. 병합은 결정론(applyPatch) 몫.
 */
const SLICES: Record<string, string> = {
  team: [
    "",
    "── 이번 응답 범위 ──",
    "위 지시 전체를 근거로 판단하되, **이번에는 `team` 축만** 출력한다(byPosition/byPlayer/markTargets 생략).",
    "설명·산문 없이 구조화 출력만.",
  ].join("\n"),
  groups: [
    "",
    "── 이번 응답 범위 ──",
    "위 지시 전체를 근거로 판단하되, **이번에는 `byPosition`(포지션 그룹) 만** 출력한다(team/byPlayer/markTargets 생략).",
    "설명·산문 없이 구조화 출력만.",
  ].join("\n"),
  players: [
    "",
    "── 이번 응답 범위 ──",
    "위 지시 전체를 근거로 판단하되, **이번에는 `byPlayer` 와 `markTargets` 만** 출력한다(team/byPosition 생략).",
    "개인 지시가 있는 선수는 빠뜨리지 말 것. 설명·산문 없이 구조화 출력만.",
  ].join("\n"),
};

async function sampleKind(kind: AiJobKind, iter: number, lean = false, slice?: string): Promise<Sample> {
  const spec = KINDS[kind];
  const ctx = fullContext(kind);
  const prompt =
    spec.buildPrompt(ctx) + (lean ? LEAN_SUFFIX : "") + (slice ? (SLICES[slice] ?? "") : "");
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
    // 출력 토큰이 어디로 갔는지(구조화 출력 크기 vs 산문) 진단용 — 프롬프트·봉투를 파일로 남긴다.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${DUMP}/${kind}-${iter}.prompt.txt`, prompt);
    writeFileSync(`${DUMP}/${kind}-${iter}.envelope.json`, JSON.stringify(env, null, 2));
  }
  return {
    kind: slice ? `patch/${slice}` : lean ? `${kind}+lean` : kind,
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

/** CLI 부팅 하한 — 최소 프롬프트로 spawn~응답까지(생성 시간 제외분 추정용). */
async function sampleBaseline(iter: number): Promise<Sample> {
  const args = ["-p", "--output-format", "json", "--model", MODEL];
  const t0 = performance.now();
  const res = await runClaude(args, "Reply with the single word: ok");
  const wallMs = performance.now() - t0;
  let env: Envelope | null = null;
  try {
    env = JSON.parse(res.stdout.trim()) as Envelope;
  } catch {
    /* ignore */
  }
  const u = env?.usage ?? {};
  return {
    kind: "baseline(hello)",
    iter,
    promptChars: 30,
    wallMs: Math.round(wallMs),
    durationMs: env?.duration_ms ?? null,
    apiMs: env?.duration_api_ms ?? null,
    inputTokens: u["input_tokens"] ?? 0,
    cacheReadTokens: u["cache_read_input_tokens"] ?? 0,
    cacheCreateTokens: u["cache_creation_input_tokens"] ?? 0,
    outputTokens: u["output_tokens"] ?? 0,
    costUSD: env?.total_cost_usd ?? 0,
    ok: env !== null && env.is_error !== true,
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
  console.log(`[measure] model=${MODEL} n=${N} kind=${WHICH} effort=${EFFORT || "(session default)"} lean=${LEAN}`);

  if (WHICH === "baseline" || WHICH === "both") {
    for (let i = 1; i <= Math.min(2, N); i++) {
      const s = await sampleBaseline(i);
      samples.push(s);
      console.log(row(s));
    }
  }
  if (WHICH === "slices") {
    // 3슬라이스를 **동시에** 돌린다 = 프로덕션에서 executor concurrency 로 병렬 처리할 때의 벽시계.
    const names = Object.keys(SLICES);
    const t0 = performance.now();
    const batch = await Promise.all(names.map((s, i) => sampleKind("team-input-patch", i + 1, false, s)));
    const batchWall = Math.round(performance.now() - t0);
    batch.forEach((s) => {
      samples.push(s);
      console.log(row(s));
    });
    console.log(
      `SLICES parallel=${names.length} batchWall=${(batchWall / 1000).toFixed(1)}s ` +
        `(max=${(Math.max(...batch.map((b) => b.wallMs)) / 1000).toFixed(1)}s · sum=${(batch.reduce((a, b) => a + b.wallMs, 0) / 1000).toFixed(1)}s · ` +
        `outTokens=${batch.map((b) => b.outputTokens).join("+")})`,
    );
  }
  if (LEAN) {
    for (let i = 1; i <= N; i++) {
      const s = await sampleKind("team-input-patch", i, true);
      samples.push(s);
      console.log(row(s));
    }
  }
  const kinds: AiJobKind[] =
    WHICH === "both"
      ? ["team-input", "team-input-patch"]
      : WHICH === "baseline" || WHICH === "lean" || WHICH === "slices"
        ? []
        : [WHICH as AiJobKind];
  for (const kind of kinds) {
    if (PARALLEL > 1) {
      // 동시 실행(프로덕션 AI_CONCURRENCY=2 = home/away 병렬)의 벽시계 = max(개별), sum 이 아님을 확인.
      const t0 = performance.now();
      const batch = await Promise.all(Array.from({ length: PARALLEL }, (_, i) => sampleKind(kind, i + 1)));
      const batchWall = Math.round(performance.now() - t0);
      batch.forEach((s) => {
        samples.push(s);
        console.log(row(s));
      });
      console.log(`${kind} parallel=${PARALLEL} batchWall=${(batchWall / 1000).toFixed(1)}s (sum=${(batch.reduce((a, b) => a + b.wallMs, 0) / 1000).toFixed(1)}s)`);
      continue;
    }
    for (let i = 1; i <= N; i++) {
      const s = await sampleKind(kind, i);
      samples.push(s);
      console.log(row(s));
    }
  }

  console.log("\n--- JSON ---");
  console.log(JSON.stringify(samples, null, 2));
}

void main();
