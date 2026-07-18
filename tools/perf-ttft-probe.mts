// AC-P1 심화 — TTFT(스폰~첫토큰) vs 생성시간 분리 계측. 상주프로세스(#7) 승급 판정용.
// 실제 잡 context 를 프로덕션과 동일한 프롬프트/스키마로 claude 에 태우되 stream-json 으로 이벤트 타임스탬프.
// 사용: npx tsx tools/perf-ttft-probe.mts <ctx.json> <model> [label]
// 출력: spawn→init(오버헤드), init→first-token(TTFT), first→last(생성), total, duration_api_ms, out_tok, cost.
// 라이브 claude 콜 1회 소비. ANTHROPIC_API_KEY unset(구독) 상태에서 실행.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildTeamInputPrompt, tacticalJsonSchema } from "../packages/server/src/prompt/coach.ts";
import { TeamInputJobContext } from "@hmb/shared";

const [ctxPath, model = "sonnet", label = model] = process.argv.slice(2);
if (!ctxPath) throw new Error("usage: perf-ttft-probe.mts <ctx.json> <model> [label]");

const ctx = TeamInputJobContext.parse(JSON.parse(readFileSync(ctxPath, "utf8").trim()));
const prompt = buildTeamInputPrompt(ctx);
const args = [
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model", model,
  "--json-schema", JSON.stringify(tacticalJsonSchema()),
];

if (process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY set — unset for subscription");

const t0 = process.hrtime.bigint();
let tInit = 0n, tFirst = 0n, tLast = 0n;
let outTok = 0, durationMs = 0, durationApiMs = 0, costUSD = 0;
let buf = "";

function ms(a: bigint, b: bigint): number { return Number(b - a) / 1e6; }

const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (d: Buffer) => {
  buf += d.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const now = process.hrtime.bigint();
    if (ev.type === "system" && ev.subtype === "init" && tInit === 0n) tInit = now;
    // 첫 실제 콘텐츠 토큰: stream_event content_block_delta 또는 assistant 메시지
    if (tFirst === 0n && (
      (ev.type === "stream_event" && ev.event?.type === "content_block_delta") ||
      ev.type === "assistant"
    )) tFirst = now;
    if (ev.type === "result") {
      tLast = now;
      durationMs = ev.duration_ms ?? 0;
      durationApiMs = ev.duration_api_ms ?? 0;
      costUSD = ev.total_cost_usd ?? 0;
      outTok = ev.usage?.output_tokens ?? 0;
    }
  }
});
let stderr = "";
child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
child.stdin.write(prompt);
child.stdin.end();

child.on("close", (code) => {
  if (tLast === 0n) tLast = process.hrtime.bigint();
  if (tFirst === 0n) tFirst = tLast;
  if (tInit === 0n) tInit = t0;
  const spawnOverhead = ms(t0, tInit);
  const ttft = ms(tInit, tFirst);
  const gen = ms(tFirst, tLast);
  const total = ms(t0, tLast);
  console.log(JSON.stringify({
    label, model, code,
    spawn_to_init_ms: Math.round(spawnOverhead),
    ttft_ms: Math.round(ttft),
    generation_ms: Math.round(gen),
    total_ms: Math.round(total),
    duration_ms: durationMs,
    duration_api_ms: durationApiMs,
    output_tokens: outTok,
    gen_tok_per_s: outTok && gen ? +(outTok / (gen / 1000)).toFixed(1) : null,
    costUSD: +costUSD.toFixed(4),
  }));
  if (code !== 0) console.error("stderr:", stderr.slice(0, 400));
});
