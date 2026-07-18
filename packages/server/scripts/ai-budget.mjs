// ai-budget — AC-C5 / P2-D8: 컨텍스트 블록별 프롬프트 예산(입력 토큰 증분) 하네스 CLI.
//
// 목적: coach 프롬프트에 Phase2 컨텍스트 블록(manualTactics/conditions/relations/teamMorale/
//   opponentRoster)과 지시 카탈로그(full)를 온/오프 매트릭스로 얹어, **블록별 입력 토큰 증분**을
//   오프라인 근사(문자수/4)로 계측한다. --live 시 실제 claude 콜로 시간·실입력/출력 토큰을 실측한다.
//
// 사용:
//   npx tsx packages/server/scripts/ai-budget.mjs               # 오프라인 근사 표 + JSON(stdout)
//   npx tsx packages/server/scripts/ai-budget.mjs --out r.json  # JSON 파일로도 저장
//   npx tsx packages/server/scripts/ai-budget.mjs --live [model]# 실제 claude 콜(시간·실토큰). 콜 예산 소비.
//
// 결정론: 오프라인 경로(코어)는 Date/rng 미사용(리포트 수치 재현). 라이브 경로만 process.hrtime(시간) 사용.
// 재사용: #82 perf 자산(tools/perf-variant-probe.mts, perf-ttft-probe.mts)의 claude stream-json spawn
//   패턴을 라이브 계측에 그대로 차용(동일 관측 인프라 — LLD §3 "같은 관측 인프라 권장").
// 계측 코어는 ai-budget-core.ts(순수) — 회귀 가드 테스트와 공유.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { measureBudget, buildVariants } from "./ai-budget-core.ts";
import { tacticalJsonSchema } from "../src/prompt/coach.ts";

// ─────────────────────────── 라이브 계측 (--live) ───────────────────────────
/** #82 perf-variant-probe 패턴 차용: claude stream-json 스폰 → 시간·실입력/출력 토큰 계측. */
function liveProbe(prompt, model) {
  return new Promise((resolve) => {
    if (process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY set — unset for subscription (LLD §5 함정)");
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", model, "--json-schema", JSON.stringify(tacticalJsonSchema())];
    const t0 = process.hrtime.bigint();
    let tFirst = 0n, tLast = 0n, inTok = 0, outTok = 0, durationApiMs = 0, costUSD = 0, buf = "";
    const ms = (a, b) => Number(b - a) / 1e6;
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const now = process.hrtime.bigint();
        if (tFirst === 0n && ((ev.type === "stream_event" && ev.event?.type === "content_block_delta") || ev.type === "assistant")) tFirst = now;
        if (ev.type === "result") {
          tLast = now; durationApiMs = ev.duration_api_ms ?? 0; costUSD = ev.total_cost_usd ?? 0;
          inTok = ev.usage?.input_tokens ?? 0; outTok = ev.usage?.output_tokens ?? 0;
        }
      }
    });
    child.stdin.write(prompt); child.stdin.end();
    child.on("close", (code) => {
      if (tLast === 0n) tLast = process.hrtime.bigint();
      if (tFirst === 0n) tFirst = tLast;
      resolve({ code, ttft_ms: Math.round(ms(t0, tFirst)), total_ms: Math.round(ms(t0, tLast)), duration_api_ms: durationApiMs, input_tokens: inTok, output_tokens: outTok, cost_usd: costUSD });
    });
  });
}

async function runLive(report, model) {
  const variants = buildVariants();
  report.live = { model, mode: "live-claude", variants: {} };
  for (const v of variants) {
    process.stderr.write(`[live] ${v.id} … `);
    const r = await liveProbe(v.prompt, model);
    report.live.variants[v.id] = r;
    process.stderr.write(`in=${r.input_tokens} out=${r.output_tokens} ${r.total_ms}ms\n`);
  }
  return report;
}

// ─────────────────────────── 콘솔 표 ───────────────────────────
function printTable(report) {
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log("\nAI 예산 하네스 — 컨텍스트 블록별 입력 토큰 증분 (오프라인 근사: chars/4)\n");
  console.log(`  base(카탈로그 on): ${report.base.chars} chars ≈ ${report.base.approxTokens} tok  (카탈로그 제외 base ${report.baseSansCatalog.chars} chars ≈ ${report.baseSansCatalog.approxTokens} tok)`);
  console.log(`  ${pad("블록", 20)} ${padL("chars", 8)} ${padL("≈tok", 7)} ${padL("Δchars", 9)} ${padL("Δtok", 7)}`);
  console.log("  " + "-".repeat(54));
  for (const b of report.blocks) {
    console.log(`  ${pad(b.id, 20)} ${padL(b.chars, 8)} ${padL(b.approxTokens, 7)} ${padL("+" + b.deltaChars, 9)} ${padL("+" + b.deltaTokens, 7)}`);
  }
  console.log("  " + "-".repeat(54));
  const a = report.allOn;
  console.log(`  ${pad("전부 on", 20)} ${padL(a.chars, 8)} ${padL(a.approxTokens, 7)} ${padL("+" + a.deltaChars, 9)} ${padL("+" + a.deltaTokens, 7)}`);
  if (report.patch) {
    console.log("\n  [B/team-input-patch 프롬프트 입력] (full-gen 대비 ΔvsFullGen)");
    console.log(`  ${pad("변형", 14)} ${padL("chars", 8)} ${padL("≈tok", 7)} ${padL("ΔvsFullGen", 12)}`);
    for (const b of [report.patch.base, report.patch.allOn]) {
      console.log(`  ${pad(b.id, 14)} ${padL(b.chars, 8)} ${padL(b.approxTokens, 7)} ${padL((b.deltaVsFullGen >= 0 ? "+" : "") + b.deltaVsFullGen, 12)}`);
    }
  }
  if (report.live) {
    console.log("\n  [live] 실측(claude):");
    console.log(`  ${pad("변형", 14)} ${padL("in_tok", 8)} ${padL("out_tok", 8)} ${padL("ttft_ms", 9)} ${padL("total_ms", 9)}`);
    for (const [id, r] of Object.entries(report.live.variants)) {
      console.log(`  ${pad(id, 14)} ${padL(r.input_tokens, 8)} ${padL(r.output_tokens, 8)} ${padL(r.ttft_ms, 9)} ${padL(r.total_ms, 9)}`);
    }
  }
  console.log("");
}

// ─────────────────────────── CLI ───────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
  const liveArg = live ? argv[argv.indexOf("--live") + 1] : null;
  const model = liveArg && !liveArg.startsWith("--") ? liveArg : "sonnet";

  let report = measureBudget();
  if (live) report = await runLive(report, model);
  printTable(report);
  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    writeFileSync(outPath, json);
    process.stderr.write(`[out] ${outPath}\n`);
  } else {
    console.log(json);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
