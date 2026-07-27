/**
 * #193 W2a 라운드1 — measure-delta-patch2.ts 의 사본 확장 (계측 전용, 프로덕션 무접촉).
 *
 * 추가점:
 *  - B1 파급 체크리스트를 프롬프트에 추가(불완전/자기모순 델타 억제).
 *  - `--scenario default|c1|c2|c3` : default = 수비 전환 + FW 침투(원 C6 시나리오),
 *    c1 = "아무것도 하지 마." · c2 = "전원 무조건 앞으로 뛰쳐나가." ·
 *    c3 = "상대 10번만 막아. 나머지는 신경 쓰지 마." (c1~c3 는 팀 지시 변경만, 개인 지시 추가 없음)
 *
 * 실행: npx tsx packages/server/scripts/measure-delta-patch3.ts \
 *         --base <envelope.json> --n 3 --model sonnet --effort low --scenario default --dump <dir>
 * (구독 세션 사용: ANTHROPIC_API_KEY unset 강제)
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { TacticalInput, TacticalPatch, applyPatch, clampTacticalInput } from "@hmb/shared";
import {
  PATCH_SYSTEM,
  PATCH_FIELD_GLOSSARY,
  tacticalPatchJsonSchema,
  assertRosterConsistency,
} from "../src/prompt/coach.js";
import { makeTeamInputContext } from "../src/executor/test-fixtures.js";

interface Envelope {
  is_error?: boolean;
  subtype?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: Record<string, number>;
  result?: string;
  structured_output?: unknown;
}

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : dflt;
};
const N = Number(arg("n", "1"));
const MODEL = arg("model", "sonnet");
const EFFORT = arg("effort", "");
const DUMP = arg("dump", "");
const BASE_PATH = arg("base", "");
const SCENARIO = arg("scenario", "default"); // default | c1 | c2 | c3
if (!BASE_PATH) throw new Error("--base <envelope.json> 필수 (AI 생성 베이스)");

/** 정액제 가드 — 키가 있으면 종량 과금으로 샌다. */
if (process.env["ANTHROPIC_API_KEY"]) {
  console.warn("[measure-delta3] ANTHROPIC_API_KEY unset 강제(구독 세션 유지)");
  delete process.env["ANTHROPIC_API_KEY"];
}

function loadAiBase(path: string): TacticalInput {
  const env = JSON.parse(readFileSync(path, "utf8")) as Envelope;
  if (env.is_error) throw new Error(`base envelope is_error=true: ${path}`);
  return TacticalInput.parse(env.structured_output);
}

/** 수정 전 지시(= test-fixtures/measure-ai-latency fullContext 의 팀 지시). */
const OLD_TEAM_PROMPT =
  "전방압박을 강하게 유지하되 뒤 공간이 열리면 라인을 내려라. 측면 전환 빠르게, 박스 안에서는 슛보다 확실한 각을 만들어라.";

/** 시나리오별 [이후] 팀 지시. */
const NEW_TEAM_PROMPTS: Record<string, string> = {
  default: "이제 수비적으로 전환한다. 라인을 내리고 콤팩트하게, 역습 시에만 측면 빠르게.",
  c1: "아무것도 하지 마.",
  c2: "전원 무조건 앞으로 뛰쳐나가.",
  c3: "상대 10번만 막아. 나머지는 신경 쓰지 마.",
};
/** default 시나리오에만 추가되는 개인 지시(FW 1명). */
const NEW_PLAYER_PROMPT = "상대 CB 뒤 공간만 노려라. 수비 가담 최소화.";

/** B1 — 파급 체크리스트(불완전 델타·자기모순 억제). */
const RIPPLE_CHECKLIST = [
  "변경이 다음 축에 파급되는지 각각 점검 후 필요한 것만 포함: 수비라인·콤팩트·압박 강도/트리거·템포·폭·오프사이드트랩·관련 선수 behavior/duty.",
  "결과에 자기모순(예: 낮은 라인 + 높은 압박 트리거)이 없는지 최종 확인.",
].join(" ");

function buildDeltaPrompt(): {
  prompt: string;
  base: TacticalInput;
  ctx: ReturnType<typeof makeTeamInputContext>;
  fwId: string;
} {
  const ctx = makeTeamInputContext();
  const base = loadAiBase(BASE_PATH);
  const roster = [...ctx.roster].sort((a, b) => a.slotIndex - b.slotIndex);

  const isFw = (pos: string): boolean => /(FW|ST|CF|LW|RW|SS)/i.test(pos);
  const h9 = roster.find((p) => p.playerId === "H9");
  const fw = h9 && isFw(h9.position) ? h9 : (roster.find((p) => isFw(p.position)) ?? roster[roster.length - 1]!);

  const newTeamPrompt = NEW_TEAM_PROMPTS[SCENARIO];
  if (!newTeamPrompt) throw new Error(`unknown --scenario ${SCENARIO}`);

  const t = base.team; // AI 베이스의 실제 팀 스칼라
  const prompt = [
    PATCH_SYSTEM,
    "",
    PATCH_FIELD_GLOSSARY,
    "",
    `포메이션: ${t.formation} (home 팀, 전반)`,
    "현재 팀 전술 베이스(A — 지시가 없는 축은 이 값 유지, 패치에 다시 쓰지 말 것):",
    `- defensiveLineHeight ${t.defensiveLineHeight} · compactness ${t.compactness} · tempo ${t.tempo} · width ${t.width}` +
      ` · pressIntensity ${t.pressingScheme.intensity} · pressTriggerLine ${t.pressingScheme.triggerLine} · offsideTrap ${t.offsideTrap}`,
    "선수 성향 베이스는 이미 A 에 계산돼 있다(여기 재나열 안 함) — 변경이 닿는 선수/그룹만 패치하라.",
    "",
    "로스터(선발 11명 — byPlayer/markTargets 키 해석용, id·포지션):",
    ...roster.map((p) => `- slot${p.slotIndex} ${p.playerId} ${p.name} (${p.position})`),
    "",
    "다음 지시가 변경되었다:",
    `[이전 팀 지시] ${OLD_TEAM_PROMPT}`,
    `[이후 팀 지시] ${newTeamPrompt}`,
    ...(SCENARIO === "default"
      ? [
          "",
          "그리고 선수 개인 지시 1건이 새로 추가되었다:",
          `- ${fw.playerId} (${fw.position}): ${NEW_PLAYER_PROMPT}`,
        ]
      : []),
    "",
    "**이 변경이 유발하는 변화만** TacticalPatch 로 출력하라. 변경과 무관한 축·선수는 절대 포함하지 마라.",
    "단 변경이 다른 선수에 파급되면(예: 마킹·커버 재배치) 그 파급분은 포함하라.",
    RIPPLE_CHECKLIST,
    "",
    "제공된 JSON 스키마에 맞는 TacticalPatch JSON 을 정확히 한 번 제출한다. 패치만 — 다른 설명·사고과정 금지.",
  ].join("\n");
  return { prompt, base, ctx, fwId: fw.playerId };
}

function runClaude(args: string[], prompt: string, timeoutMs = 180_000): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
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

async function main(): Promise<void> {
  const { prompt, base, ctx, fwId } = buildDeltaPrompt();
  console.log(
    `[measure-delta3] model=${MODEL} n=${N} effort=${EFFORT || "(session default)"} scenario=${SCENARIO} promptChars=${prompt.length} fw=${fwId} base=${BASE_PATH}`,
  );
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    MODEL,
    ...(EFFORT ? ["--effort", EFFORT] : []),
    "--json-schema",
    JSON.stringify(tacticalPatchJsonSchema()),
  ];

  const samples: unknown[] = [];
  for (let i = 1; i <= N; i++) {
    const t0 = performance.now();
    const res = await runClaude(args, prompt);
    const wallMs = Math.round(performance.now() - t0);
    let env: Envelope | null = null;
    try {
      env = JSON.parse(res.stdout.trim()) as Envelope;
    } catch {
      /* parse-fail */
    }
    const u = env?.usage ?? {};

    // 산출 패치 → applyPatch(AI 베이스) 정적 머지 → clamp → 로스터 정합.
    let mergeOk = false;
    let mergeNote = "";
    let finalChars = 0;
    let patchKeys = "";
    try {
      const patch = TacticalPatch.parse(env?.structured_output);
      patchKeys = Object.keys(env?.structured_output as Record<string, unknown>).join(",") || "(empty)";
      const merged = clampTacticalInput(applyPatch(base, patch, { seed: ctx.seed }));
      assertRosterConsistency(merged, ctx.roster);
      mergeOk = true;
      finalChars = JSON.stringify(merged).length;
      if (DUMP) writeFileSync(`${DUMP}/delta-patch-${i}.final.json`, JSON.stringify(merged, null, 2));
    } catch (e) {
      mergeNote = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
    if (DUMP) {
      writeFileSync(`${DUMP}/delta-patch-${i}.prompt.txt`, prompt);
      writeFileSync(`${DUMP}/delta-patch-${i}.envelope.json`, JSON.stringify(env, null, 2));
    }
    const s = {
      kind: `delta-patch3-${SCENARIO}`,
      iter: i,
      promptChars: prompt.length,
      wallMs,
      durationMs: env?.duration_ms ?? null,
      apiMs: env?.duration_api_ms ?? null,
      inputTokens: u["input_tokens"] ?? 0,
      cacheReadTokens: u["cache_read_input_tokens"] ?? 0,
      cacheCreateTokens: u["cache_creation_input_tokens"] ?? 0,
      outputTokens: u["output_tokens"] ?? 0,
      ok: env !== null && env.is_error !== true,
      mergeOk,
      mergeNote: mergeNote || undefined,
      patchKeys,
      finalChars,
      note: env === null ? `parse-fail: ${(res.stderr || res.stdout || "").slice(0, 200)}` : undefined,
    };
    samples.push(s);
    console.log(
      `delta-patch3(${SCENARIO}) #${i} wall=${(wallMs / 1000).toFixed(1)}s api=${s.apiMs === null ? "?" : ((s.apiMs as number) / 1000).toFixed(1) + "s"} ` +
        `out=${s.outputTokens} mergeOk=${mergeOk} keys=${patchKeys}${mergeNote ? ` (${mergeNote})` : ""}`,
    );
  }
  console.log("\n--- JSON ---");
  console.log(JSON.stringify(samples, null, 2));
}

void main();
