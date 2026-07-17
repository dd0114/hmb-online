import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runComparison, type ModelReport } from "./ai/compare.js";
import { stubExecutor } from "./ai/executors/stub.js";
import { claudeCodeExecutor, claudeCodeAuthSelfCheck } from "./ai/executors/claude-code.js";
import type { AiExecutor } from "./ai/executor.js";

/**
 * 모델 비교 실행(에픽 #32 · W3 AC2) — `npm run compare -w @hmb/server`.
 * env: AI_COMPARE_MODELS(기본 "sonnet,haiku") · AI_SEED(기본 4815162342) · AI_DATA_DIR.
 * 모델 토큰: "stub"=오프라인 구조검증 / "sonnet"|"haiku"|"opus"|풀ID=claude-code 라이브(구독 로그인).
 * 리포트 → <AI_DATA_DIR>/compare-report.json (대시보드 GET /compare-report 가 서빙).
 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env["AI_DATA_DIR"] ?? join(PKG_ROOT, ".data");
const SEED = process.env["AI_SEED"] ?? "4815162342";
const MODELS = (process.env["AI_COMPARE_MODELS"] ?? "sonnet,haiku").split(",").map((s) => s.trim()).filter(Boolean);

function executorFor(token: string): AiExecutor {
  if (token === "stub" || token.startsWith("stub-")) return stubExecutor();
  return claudeCodeExecutor({ model: token });
}

async function main(): Promise<void> {
  const live = MODELS.some((m) => m !== "stub" && !m.startsWith("stub-"));
  if (live) claudeCodeAuthSelfCheck();
  console.log(`[compare] models=${MODELS.join(" vs ")} seed=${SEED} (${live ? "라이브 구독" : "오프라인 stub"})`);

  const models = MODELS.map((token, i) => ({ label: MODELS.filter((x) => x === token).length > 1 ? `${token}#${i}` : token, executor: executorFor(token) }));
  const report = await runComparison(models, SEED, { timestamp: new Date().toISOString() });

  mkdirSync(DATA_DIR, { recursive: true });
  const out = join(DATA_DIR, "compare-report.json");
  writeFileSync(out, JSON.stringify(report, null, 2));

  // 콘솔 표
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  console.log("\n모델            검증통과   방향정합   대비폭   지연(ms)");
  for (const m of report.models as ModelReport[]) {
    console.log(
      `${m.label.padEnd(14)} ${pct(m.validationPassRate).padStart(6)} ${pct(m.directionAccuracy).padStart(9)} ${m.avgContrast.toFixed(2).padStart(8)} ${Math.round(m.avgLatencyMs).toString().padStart(9)}`,
    );
  }
  console.log(`\n추천 모델: ${report.recommended ?? "(없음)"}`);
  console.log(`리포트: ${out}`);
}

void main().catch((e) => {
  console.error("[compare] 실패:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
