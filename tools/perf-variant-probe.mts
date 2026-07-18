// AC-P1/P4 — 아키텍처 버전별 "게임 시작까지 시간" 실측. 임의 프롬프트+스키마를 claude 에 태우고
// TTFT/생성/total + 출력토큰 + 구조화출력(저장) 계측. 출력토큰 축소가 latency에 미치는 실제 바닥을 찾는다.
// 사용: npx tsx tools/perf-variant-probe.mts <promptFile> <schemaFile> <label> [model] [outFile]
// 라이브 claude 콜 1회(구독). ANTHROPIC_API_KEY unset.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [promptPath, schemaPath, label = "variant", model = "sonnet", outFile] = process.argv.slice(2);
if (!promptPath || !schemaPath) throw new Error("usage: <promptFile> <schemaFile> <label> [model] [outFile]");
if (process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY set — unset for subscription");

const prompt = readFileSync(promptPath, "utf8");
const schema = readFileSync(schemaPath, "utf8"); // JSON schema text
const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  "--model", model, "--json-schema", schema];

const t0 = process.hrtime.bigint();
let tInit = 0n, tFirst = 0n, tLast = 0n;
let outTok = 0, durationApiMs = 0, costUSD = 0, structured: unknown = null;
let buf = "";
const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;

const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (d: Buffer) => {
  buf += d.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    const now = process.hrtime.bigint();
    if (ev.type === "system" && ev.subtype === "init" && tInit === 0n) tInit = now;
    if (tFirst === 0n && ((ev.type === "stream_event" && ev.event?.type === "content_block_delta") || ev.type === "assistant")) tFirst = now;
    if (ev.type === "result") {
      tLast = now; durationApiMs = ev.duration_api_ms ?? 0; costUSD = ev.total_cost_usd ?? 0;
      outTok = ev.usage?.output_tokens ?? 0;
      structured = ev.structured_output ?? null;
      if (structured == null && typeof ev.result === "string") { try { structured = JSON.parse(ev.result); } catch {} }
    }
  }
});
let stderr = ""; child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
child.stdin.write(prompt); child.stdin.end();
child.on("close", (code) => {
  if (tLast === 0n) tLast = process.hrtime.bigint();
  if (tFirst === 0n) tFirst = tLast; if (tInit === 0n) tInit = t0;
  if (outFile && structured != null) writeFileSync(outFile, JSON.stringify(structured, null, 2));
  console.log(JSON.stringify({
    label, model, code,
    ttft_ms: Math.round(ms(tInit, tFirst)),
    generation_ms: Math.round(ms(tFirst, tLast)),
    total_ms: Math.round(ms(t0, tLast)),
    duration_api_ms: durationApiMs,
    output_tokens: outTok,
    gen_tok_per_s: outTok ? +(outTok / (ms(tFirst, tLast) / 1000)).toFixed(1) : null,
    costUSD: +costUSD.toFixed(4),
    savedOutput: outFile && structured != null ? outFile : null,
  }));
  if (code !== 0) console.error("stderr:", stderr.slice(0, 400));
});
