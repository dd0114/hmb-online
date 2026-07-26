import type { DerivedTeam } from "./harness";

/**
 * realism/bench — 실제 축구 벤치마크 밴드의 **단일 출처**(research/football-stats.md).
 *
 * 왜 분리했나: 밴드가 `gap-report.test.ts`(리포트)와 밸런스 스윕 도구 양쪽에 복붙돼 있으면,
 * 한쪽만 고쳐져 **"리포트는 OK 인데 스윕은 이탈"** 같은 드리프트가 생긴다. 밴드는 튜닝 판단의
 * 기준이므로 하나만 있어야 한다.
 *
 * 밴드를 고칠 땐 근거(벤치 문서 갱신)를 같이 남긴다 — 여기 숫자를 넓히는 것은 "지표를 맞췄다"가
 * 아니라 "기준을 바꿨다"이므로 리뷰 대상이다.
 */

export interface Bench {
  key: keyof DerivedTeam | "goalsPerMatch";
  label: string;
  lo: number;
  hi: number;
  unit?: string;
  note?: string;
}

/** 벤치마크(팀-경기 기준). goalsPerMatch 는 양팀 합. */
export const BENCH: Bench[] = [
  { key: "passSuccessPct", label: "패스 성공률", lo: 78, hi: 85, unit: "%" },
  { key: "longShareOfAttempts", label: "의도적 롱패스 시도 비율", lo: 12, hi: 15, unit: "%", note: "E2, detail=long" },
  { key: "longPassPct", label: "롱볼 이동(>=30m, 재구성)", lo: 12, hi: 15, unit: "%", note: "노이즈 포함(참고)" },
  { key: "possessionPct", label: "점유율", lo: 30, hi: 65, unit: "%", note: "대칭→평균~50" },
  { key: "shots", label: "슛(시도)", lo: 12, hi: 14 },
  { key: "onTarget", label: "유효슛", lo: 4.5, hi: 5.5 },
  { key: "onTargetPct", label: "유효슛 비율", lo: 45, hi: 50, unit: "%" },
  { key: "goals", label: "골", lo: 1.4, hi: 1.65 },
  { key: "shotConvPct", label: "슛→골 전환", lo: 10, hi: 12, unit: "%" },
  { key: "xgPerShot", label: "슛당 xG", lo: 0.1, hi: 0.12 },
  { key: "corners", label: "코너", lo: 4, hi: 6 },
  { key: "throwIns", label: "스로인", lo: 17, hi: 19 },
  { key: "fouls", label: "파울", lo: 11, hi: 12 },
  { key: "offsides", label: "오프사이드", lo: 1, hi: 3 },
  { key: "yellowCards", label: "옐로카드", lo: 1.8, hi: 2.0 },
  { key: "avgWidthM", label: "팀 width", lo: 40, hi: 50, unit: "m" },
  { key: "avgLengthM", label: "팀 length", lo: 25, hi: 40, unit: "m" },
  { key: "avgDistanceKm", label: "주행거리", lo: 10, hi: 12, unit: "km" },
];

/** 밴드 판정 문자열. */
export function benchVerdict(v: number, b: Bench): string {
  if (v < b.lo) return `LOW (▼ ${(b.lo - v).toFixed(2)})`;
  if (v > b.hi) return `HIGH (▲ ${(v - b.hi).toFixed(2)})`;
  return "OK";
}

/** 밴드 안인가. */
export function inBench(v: number, b: Bench): boolean {
  return v >= b.lo && v <= b.hi;
}
