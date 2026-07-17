import { describe, it, expect } from "vitest";
import { runComparison, DIRECTIVE_SET } from "./compare.js";
import { stubExecutor } from "./executors/stub.js";
import type { AiExecutor } from "./executor.js";
import type { AiJob } from "./protocol.js";
import { makeTacticalInput } from "@hmb/engine";

/**
 * W3 AC2 — 모델 비교 하네스. 오프라인(stub 2모델)으로 리포트 구조·지표 산식을 박제.
 * 라이브 sonnet vs haiku 실측은 compare-main(구독 로그인)에서.
 */
describe("모델 비교 하네스 (W3 AC2)", () => {
  // 결정론 now(호출마다 +10ms) — Date.now 없이 지연 지표 검증.
  const fakeNow = (): (() => number) => {
    let t = 0;
    return () => (t += 10);
  };

  it("directive 세트는 3차원 × (high,low) = 6개", () => {
    expect(DIRECTIVE_SET).toHaveLength(6);
    expect(new Set(DIRECTIVE_SET.map((p) => p.dim))).toEqual(new Set(["width", "line", "press"]));
  });

  it("stub 2모델 비교: 통과율 100% + 방향정합 산출 + 리포트 구조", async () => {
    const report = await runComparison(
      [
        { label: "stub-A", executor: stubExecutor() },
        { label: "stub-B", executor: stubExecutor() },
      ],
      "4815162342",
      { now: fakeNow(), timestamp: "2026-07-13T00:00:00Z" },
    );

    expect(report.models).toHaveLength(2);
    for (const m of report.models) {
      expect(m.probes).toHaveLength(6);
      expect(m.validationPassRate).toBe(1); // stub 은 항상 유효 인풋
      expect(m.directionAccuracy).toBeGreaterThanOrEqual(0);
      expect(m.directionAccuracy).toBeLessThanOrEqual(1);
      expect(m.avgLatencyMs).toBeGreaterThan(0);
    }
    expect(report.recommended).not.toBeNull();
    expect(report.seed).toBe("4815162342");
    expect(report.generatedAt).toBe("2026-07-13T00:00:00Z");
  });

  it("검증 실패 모델은 통과율에 반영(폴백/게이트 거부 가시화)", async () => {
    // 항상 깨진 출력 → 게이트 전부 실패.
    const brokenExecutor: AiExecutor = {
      name: "broken",
      execute: (_job: AiJob) => Promise.resolve({ nope: true }),
    };
    const report = await runComparison(
      [
        { label: "good", executor: stubExecutor() },
        { label: "broken", executor: brokenExecutor },
      ],
      "4815162342",
      { now: fakeNow() },
    );
    const broken = report.models.find((m) => m.label === "broken")!;
    expect(broken.validationPassRate).toBe(0);
    expect(broken.probes.every((p) => !p.ok && p.error)).toBe(true);
    // 통과율 높은 good 이 추천되어야 함.
    expect(report.recommended).toBe("good");
  });

  it("방향정합: high 지시가 low 지시보다 큰 값이면 정확도↑ (합성 executor)", async () => {
    // dim/polarity 를 job.id 로 읽어 방향 정합하게 값을 조립하는 합성 executor.
    const directional: AiExecutor = {
      name: "directional",
      execute: (job: AiJob) => {
        const high = job.id.includes("-high");
        const base = makeTacticalInput("H", "42");
        const v = high ? 0.9 : 0.1;
        base.team.width = v;
        base.team.defensiveLineHeight = v;
        base.team.pressingScheme.intensity = v;
        return Promise.resolve(base);
      },
    };
    const report = await runComparison([{ label: "dir", executor: directional }], "42", { now: fakeNow() });
    expect(report.models[0]!.directionAccuracy).toBe(1); // 3/3 차원 정합
    expect(report.models[0]!.avgContrast).toBeCloseTo(0.8, 5); // 0.9 - 0.1
  });
});
