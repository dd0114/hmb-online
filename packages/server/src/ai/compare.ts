import type { AiExecutor } from "./executor.js";
import type { AiJob } from "./protocol.js";
import { coachContext } from "../pipeline.js";
import { validateCoachOutput } from "../coach.js";
import type { TacticalInput } from "@hmb/shared";

/**
 * 모델 비교 하네스(에픽 #32 · W3 AC2) — 같은 directive 세트를 여러 모델(executor)로 돌려
 * 검증 통과율 · 방향 정합(공격/수비 직관 대비) · 파라미터 대비폭을 비교한다 → 기본 모델 확정 근거.
 * executor 무관(stub 2개=오프라인 구조검증 / claude-code sonnet·haiku=라이브 실측).
 */

/** 차원별 공격↔수비 지시 쌍 — high 지시가 low 지시보다 큰 값을 내야 "방향 정합". */
export interface DirectiveProbe {
  dim: "width" | "line" | "press";
  polarity: "high" | "low";
  directive: string;
  /** 검증 통과한 TacticalInput 에서 이 차원의 대표 수치(0..1) 추출. */
  read: (t: TacticalInput) => number;
}

export const DIRECTIVE_SET: DirectiveProbe[] = [
  { dim: "width", polarity: "high", directive: "풀백 오버랩·양 측면 최대한 넓게 벌려 폭을 크게 쓰는 공격", read: (t) => t.team.width },
  { dim: "width", polarity: "low", directive: "좁게 콤팩트하게, 측면 벌리지 말고 중앙에 밀집", read: (t) => t.team.width },
  { dim: "line", polarity: "high", directive: "하이라인 오프사이드 트랩, 수비라인 최대한 전진", read: (t) => t.team.defensiveLineHeight },
  { dim: "line", polarity: "low", directive: "로우블록으로 깊게 내려서 수비, 수비라인 낮게", read: (t) => t.team.defensiveLineHeight },
  { dim: "press", polarity: "high", directive: "전방부터 강하게 즉시 압박, 하이프레스", read: (t) => t.team.pressingScheme.intensity },
  { dim: "press", polarity: "low", directive: "압박 자제하고 진영 지키며 기다리는 수비", read: (t) => t.team.pressingScheme.intensity },
];

export interface ProbeResult {
  dim: string;
  polarity: string;
  directive: string;
  ok: boolean;
  value: number | null; // 검증 통과 시 대표 수치
  error?: string;
  latencyMs: number;
}

export interface ModelReport {
  label: string;
  executor: string;
  probes: ProbeResult[];
  validationPassRate: number; // 통과/전체
  /** 방향 정합: 각 차원에서 high 값 > low 값이면 정합. 정합 차원 / 전체 차원. */
  directionAccuracy: number;
  /** 대비폭: 각 차원 (high - low) 평균. 클수록 지시를 결단력 있게 반영. */
  avgContrast: number;
  avgLatencyMs: number;
}

export interface ComparisonReport {
  seed: string;
  generatedAt: string;
  models: ModelReport[];
  /** validationPassRate·directionAccuracy·avgContrast 우선순위로 추천되는 모델 label. */
  recommended: string | null;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

async function runOneModel(
  label: string,
  executor: AiExecutor,
  seed: string,
  now: () => number,
): Promise<ModelReport> {
  const probes: ProbeResult[] = [];
  for (const p of DIRECTIVE_SET) {
    const job: AiJob = { id: `cmp-${label}-${p.dim}-${p.polarity}`, kind: "coach", context: coachContext(p.directive, seed), enqueuedAt: "cmp" };
    const t0 = now();
    try {
      const raw = await executor.execute(job);
      const input = validateCoachOutput(raw, "H");
      probes.push({ dim: p.dim, polarity: p.polarity, directive: p.directive, ok: true, value: p.read(input), latencyMs: now() - t0 });
    } catch (e) {
      probes.push({ dim: p.dim, polarity: p.polarity, directive: p.directive, ok: false, value: null, error: e instanceof Error ? e.message : String(e), latencyMs: now() - t0 });
    }
  }

  const passed = probes.filter((r) => r.ok);
  // 차원별 high/low 대비 — 둘 다 통과한 차원만 평가.
  const dims = [...new Set(DIRECTIVE_SET.map((p) => p.dim))];
  const contrasts: number[] = [];
  let correct = 0;
  let evaluable = 0;
  for (const d of dims) {
    const hi = probes.find((r) => r.dim === d && r.polarity === "high" && r.ok)?.value;
    const lo = probes.find((r) => r.dim === d && r.polarity === "low" && r.ok)?.value;
    if (hi === undefined || hi === null || lo === undefined || lo === null) continue;
    evaluable += 1;
    contrasts.push(hi - lo);
    if (hi > lo) correct += 1;
  }

  return {
    label,
    executor: executor.name,
    probes,
    validationPassRate: probes.length === 0 ? 0 : passed.length / probes.length,
    directionAccuracy: evaluable === 0 ? 0 : correct / evaluable,
    avgContrast: mean(contrasts),
    avgLatencyMs: mean(probes.map((r) => r.latencyMs)),
  };
}

/** 여러 모델을 같은 directive 세트로 비교. now 주입(테스트=결정론). */
export async function runComparison(
  models: Array<{ label: string; executor: AiExecutor }>,
  seed: string,
  opts: { now?: () => number; timestamp?: string } = {},
): Promise<ComparisonReport> {
  const now = opts.now ?? Date.now;
  const reports: ModelReport[] = [];
  for (const m of models) reports.push(await runOneModel(m.label, m.executor, seed, now));

  // 추천: 통과율 → 방향정확도 → 대비폭 우선.
  const ranked = [...reports].sort(
    (a, b) =>
      b.validationPassRate - a.validationPassRate ||
      b.directionAccuracy - a.directionAccuracy ||
      b.avgContrast - a.avgContrast,
  );
  return {
    seed,
    generatedAt: opts.timestamp ?? "",
    models: reports,
    recommended: ranked[0]?.label ?? null,
  };
}
