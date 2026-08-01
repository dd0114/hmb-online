import type { EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { setFatigueObserver } from "../action";

/**
 * realism/fatigue — **피로 곡선 계측**(#346).
 *
 * `fatigue` 는 스냅샷·이벤트 어디에도 안 나온다. 그래서 "경기의 79.4% 가 전원 fatigue = 1.0"
 * 이라는 사실이 로그 어디에서도 안 보였고, 그게 이 결함이 오래 안 잡힌 이유다.
 * `action.setFatigueObserver`(옵트인·쓰기 전용)로 매 틱 곡선을 읽는다 — 재계산하지 않는다.
 *
 * 순수 분석 유틸(프로덕션 `index.ts` 에 export 되지 않는다).
 */

export interface FatigueBreakdown {
  matches: number;
  ticks: number;
  /** 전 아웃필더가 **정확히 1.0** 인 틱 비율(%) — 구 모델의 지문(79.4%). */
  allSaturatedPct: number;
  /** 아웃필더 평균 피로. */
  meanOutfield: number;
  /** 아웃필더 피로의 **선수 간 산포**(같은 틱 max−min)의 경기 평균 — 구 모델은 포화 구간에서 0. */
  meanSpread: number;
  /** 경기 마지막 틱의 아웃필더 max−min. 0 이면 "전원 동일"이다. */
  endSpread: number;
  /** 피로가 **내려간** 틱의 비율(%) — 회복 항이 실제로 작동하는가. 구 모델은 0(단조 증가). */
  recoveredTickPct: number;
  /** 하프타임 직후 평균 − 하프 마지막 평균(음수여야 회복). null = 하프 경계를 못 봤다. */
  halfTimeDrop: number | null;
  /** 아웃필더 개인 최고 피로의 평균(얼마나 힘든 경기였나). */
  meanPeak: number;
}

/** 다시드 피로 곡선 수집. config 를 바꿔 호출하면 그대로 대조군이 된다(변이체 킬). */
export function collectFatigue(config: EngineConfig, seeds: string[]): FatigueBreakdown {
  const select = makeSelectData();
  const total = Math.round((config.matchMinutes * 60 * 1000) / config.msPerTick);
  const half = Math.floor(total / 2);

  let ticks = 0;
  let saturatedTicks = 0;
  let sumMean = 0;
  let sumSpread = 0;
  let endSpreadSum = 0;
  let recoveredTicks = 0;
  let halfDropSum = 0;
  let halfDropN = 0;
  let peakSum = 0;
  let peakN = 0;

  for (const seed of seeds) {
    let prev: Map<string, number> | null = null;
    let lastHalfMean: number | null = null;
    let firstSecondHalfMean: number | null = null;
    let endSpread = 0;
    const peak = new Map<string, number>();

    setFatigueObserver((tick, samples) => {
      const out = samples.filter((s) => !s.isGK);
      if (out.length === 0) return;
      ticks += 1;
      let mn = Infinity;
      let mx = -Infinity;
      let sum = 0;
      let dropped = false;
      const cur = new Map<string, number>();
      for (const s of out) {
        const key = `${s.side}:${s.id}`;
        cur.set(key, s.fatigue);
        sum += s.fatigue;
        if (s.fatigue < mn) mn = s.fatigue;
        if (s.fatigue > mx) mx = s.fatigue;
        peak.set(key, Math.max(peak.get(key) ?? 0, s.fatigue));
        const before = prev?.get(key);
        if (before !== undefined && s.fatigue < before - 1e-12) dropped = true;
      }
      if (mn >= 1) saturatedTicks += 1;
      if (dropped) recoveredTicks += 1;
      const mean = sum / out.length;
      sumMean += mean;
      sumSpread += mx - mn;
      // 하프 경계: 전반 마지막 틱과 후반 첫 틱의 평균을 비교한다.
      if (tick === half - 1) lastHalfMean = mean;
      else if (tick === half && lastHalfMean !== null && firstSecondHalfMean === null) firstSecondHalfMean = mean;
      if (tick === total - 1) endSpread = mx - mn;
      prev = cur;
    });

    runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    setFatigueObserver(null);

    endSpreadSum += endSpread;
    if (lastHalfMean !== null && firstSecondHalfMean !== null) {
      halfDropSum += firstSecondHalfMean - lastHalfMean;
      halfDropN += 1;
    }
    for (const v of peak.values()) {
      peakSum += v;
      peakN += 1;
    }
  }

  const n = Math.max(1, ticks);
  return {
    matches: seeds.length,
    ticks,
    allSaturatedPct: (saturatedTicks / n) * 100,
    meanOutfield: sumMean / n,
    meanSpread: sumSpread / n,
    endSpread: endSpreadSum / Math.max(1, seeds.length),
    recoveredTickPct: (recoveredTicks / n) * 100,
    halfTimeDrop: halfDropN > 0 ? halfDropSum / halfDropN : null,
    meanPeak: peakN > 0 ? peakSum / peakN : 0,
  };
}

/** 사람이 읽는 리포트(진단 출력·증거용). */
export function formatFatigue(label: string, f: FatigueBreakdown): string {
  return [
    `=== ${label} (${f.matches} 경기 · ${f.ticks} 틱) ===`,
    `  전원 포화(모든 아웃필더 = 1.0) ${f.allSaturatedPct.toFixed(1)}%  · 평균 피로 ${f.meanOutfield.toFixed(3)} · 개인 최고 평균 ${f.meanPeak.toFixed(3)}`,
    `  선수 간 산포(같은 틱 max−min) 평균 ${f.meanSpread.toFixed(3)} · 경기 종료 시점 ${f.endSpread.toFixed(3)}`,
    `  피로가 내려간 틱 ${f.recoveredTickPct.toFixed(1)}% · 하프타임 변화 ${f.halfTimeDrop === null ? "n/a" : f.halfTimeDrop.toFixed(3)}`,
  ].join("\n");
}
