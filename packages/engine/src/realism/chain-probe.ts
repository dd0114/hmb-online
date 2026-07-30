import type { EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { GENERATORS, newChainProbe, setChainProbe, type ChainProbe } from "../action";

/**
 * realism/chain-probe — **생성기별 생성/채택 분포 리포트**(#279 S2).
 *
 * 왜 이게 필요한가: W2 실험의 실제 교훈은 "탐색기를 고급화했는데 지표가 안 움직였다 → **왜인지
 * 추측했다**" 였다(로드맵 §8). 생성기가 늘어나는 S5 에서 같은 상황이 오면 물어야 할 질문은
 * 딱 두 개다 — **생성이 0인가, 채택이 0인가.** 앞은 게이팅/기하 문제고 뒤는 평가함수 문제라
 * 고칠 곳이 완전히 다르다. 계측이 없으면 그 갈림길에서 또 추측한다.
 *
 * 결정론: probe 는 **쓰기 전용 카운터**다. 시뮬 로직이 읽지 않으므로 켜고 끄는 것이 결과를
 * 바꾸지 않는다(그 성질 자체를 `chain-search.test.ts` 가 계약으로 박제한다).
 * 이 파일은 순수 분석 유틸(엔진 프로덕션 빌드 `index.ts` 에 export 되지 않음).
 */

export interface GenRow {
  gen: string;
  generated: number;
  /** 결정당 평균 생성 수. */
  perDecision: number;
  picked: number;
  /** 채택률 = picked / decisions (그 생성기가 실제로 실행된 비율). */
  pickPct: number;
}

export interface ChainProbeReport {
  decisions: number;
  rows: GenRow[];
  /** 결정당 평균 EV 평가 노드 수. */
  nodesPerDecision: number;
  /** 한 결정의 후보 수 최댓값 — `chain.search.beamTop` 기본값의 근거. */
  maxCandidates: number;
  beamClipped: number;
  recurseClipped: number;
  budgetHit: number;
  raw: ChainProbe;
}

/** 시드 목록으로 chain 모드 경기를 돌려 생성기 계측을 모은다. */
export function collectChainProbe(config: EngineConfig, seeds: string[]): ChainProbeReport {
  const probe = newChainProbe();
  const select = makeSelectData();
  setChainProbe(probe);
  try {
    for (const seed of seeds) {
      runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    }
  } finally {
    // 예외가 나도 반드시 끈다 — 켜진 채 남으면 다른 테스트의 카운터가 오염된다.
    setChainProbe(null);
  }
  const d = probe.decisions || 1;
  return {
    decisions: probe.decisions,
    rows: GENERATORS.map((g) => ({
      gen: g,
      generated: probe.generated[g],
      perDecision: probe.generated[g] / d,
      picked: probe.picked[g],
      pickPct: (100 * probe.picked[g]) / d,
    })),
    nodesPerDecision: probe.evalNodes / d,
    maxCandidates: probe.maxCandidates,
    beamClipped: probe.beamClipped,
    recurseClipped: probe.recurseClipped,
    budgetHit: probe.budgetHit,
    raw: probe,
  };
}

/** 마크다운 표로 렌더(리포트용). */
export function renderChainProbe(r: ChainProbeReport): string {
  const f = (v: number, d = 2): string => (Math.round(v * 10 ** d) / 10 ** d).toString();
  const L: string[] = [];
  L.push(`| 생성기 | 생성(총) | 결정당 생성 | 채택(총) | 채택률 |`);
  L.push(`|---|---|---|---|---|`);
  for (const row of r.rows) {
    L.push(`| ${row.gen} | ${row.generated} | ${f(row.perDecision)} | ${row.picked} | ${f(row.pickPct)}% |`);
  }
  L.push("");
  L.push(
    `- 결정 ${r.decisions} · 결정당 평가노드 **${f(r.nodesPerDecision, 1)}** · 후보 최대 **${r.maxCandidates}**`,
  );
  L.push(
    `- 예산 구속: beamClipped ${r.beamClipped} · recurseClipped ${r.recurseClipped} · budgetHit ${r.budgetHit}`,
  );
  return L.join("\n");
}
