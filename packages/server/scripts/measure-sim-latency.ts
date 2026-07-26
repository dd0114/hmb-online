/**
 * 엔진 시뮬 + 러너 RPC 지연 계측 (#193 W1) — 대기의 "시뮬 성분".
 *
 * 두 층을 따로 잰다:
 *   ① pure   = simulate() 인프로세스 호출(엔진 순수 계산 + JSON 직렬화 없음)
 *   ② rpc    = 실제 러너 HTTP(/simulate) 왕복 = Java 가 겪는 시간(JSON 직렬화·전송 포함)
 * half=1(통짜 전반) 과 half=2(resumeState 승계) 를 각각, 다시드로 잰다.
 *
 * 실행: npx tsx packages/server/scripts/measure-sim-latency.ts [--n 5] [--port 8795]
 *      (계측 전용 포트 — 데모 8790 / 배포 18790 무접촉)
 */
import { makeSelectData, makeTacticalInput, defaultEngineConfig } from "@hmb/engine";
import type { SimulateRequest } from "@hmb/shared";
import { simulate } from "../src/runner/simulate.js";
import { createRunnerServer } from "../src/runner/runner-main.js";

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : dflt;
};
const N = Number(arg("n", "5"));
const PORT = Number(arg("port", "8795"));

const selectData = makeSelectData();

function reqH1(seed: string): SimulateRequest {
  return {
    seed,
    selectData,
    homeInput: makeTacticalInput("H", seed),
    awayInput: makeTacticalInput("A", seed),
    half: 1,
  } as SimulateRequest;
}

interface Row {
  layer: "pure" | "rpc";
  half: 1 | 2;
  seed: string;
  ms: number;
  ticks: number;
  logBytes: number;
}

const rows: Row[] = [];
const seeds = Array.from({ length: N }, (_, i) => `measure-seed-${i + 1}`);

// ── ① pure(인프로세스) ────────────────────────────────────────────────────
const carriedResume: Record<string, unknown> = {};
for (const seed of seeds) {
  const t0 = performance.now();
  const res = simulate(reqH1(seed));
  const ms = performance.now() - t0;
  const bytes = JSON.stringify(res.matchLog).length;
  rows.push({ layer: "pure", half: 1, seed, ms, ticks: res.matchLog.tickSnapshots.length, logBytes: bytes });
  carriedResume[seed] = res.resumeState;

  const t1 = performance.now();
  const res2 = simulate({ ...reqH1(seed), half: 2, resumeState: res.resumeState } as SimulateRequest);
  const ms2 = performance.now() - t1;
  rows.push({
    layer: "pure",
    half: 2,
    seed,
    ms: ms2,
    ticks: res2.matchLog.tickSnapshots.length,
    logBytes: JSON.stringify(res2.matchLog).length,
  });
}

// ── ② rpc(실제 러너 HTTP) ─────────────────────────────────────────────────
const server = createRunnerServer();
await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", () => resolve()));

async function rpc(body: SimulateRequest): Promise<{ ms: number; ticks: number; bytes: number }> {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`rpc ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { matchLog: { tickSnapshots: unknown[] } };
  return { ms, ticks: parsed.matchLog.tickSnapshots.length, bytes: text.length };
}

for (const seed of seeds) {
  const r1 = await rpc(reqH1(seed));
  rows.push({ layer: "rpc", half: 1, seed, ms: r1.ms, ticks: r1.ticks, logBytes: r1.bytes });
  const r2 = await rpc({ ...reqH1(seed), half: 2, resumeState: carriedResume[seed] } as SimulateRequest);
  rows.push({ layer: "rpc", half: 2, seed, ms: r2.ms, ticks: r2.ticks, logBytes: r2.bytes });
}

server.close();

// ── 리포트 ────────────────────────────────────────────────────────────────
const fmt = (xs: number[]): string => {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return `n=${s.length} min=${s[0]?.toFixed(0)} p50=${p(0.5).toFixed(0)} p90=${p(0.9).toFixed(0)} max=${s[s.length - 1]?.toFixed(0)} avg=${avg.toFixed(0)} (ms)`;
};

console.log(`[measure-sim] engine=${defaultEngineConfig.version} matchMinutes=${defaultEngineConfig.matchMinutes} n=${N}`);
for (const layer of ["pure", "rpc"] as const) {
  for (const half of [1, 2] as const) {
    const sel = rows.filter((r) => r.layer === layer && r.half === half);
    console.log(
      `${layer.padEnd(5)} half=${half}  ${fmt(sel.map((r) => r.ms))}  ticks=${sel[0]?.ticks} logKB=${Math.round((sel[0]?.logBytes ?? 0) / 1024)}`,
    );
  }
}
console.log("\n--- JSON ---");
console.log(JSON.stringify(rows.map((r) => ({ ...r, ms: Math.round(r.ms) })), null, 2));
