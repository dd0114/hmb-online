import type { MatchLog, TeamSide } from "@hmb/shared";
import type { EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { computeMatchStats, type MatchStats, type TeamStats } from "../../dev-viewer/match-stats";

/**
 * realism/harness — 리얼 config(또는 임의 config) 다수 시드 시뮬을 돌려 매치 스탯을
 * 벤치마크(research/football-stats.md)와 대조 가능한 팀-경기 평균으로 집계한다(E3 갭 분석).
 *
 * computeMatchStats(뷰어 스탯) 를 재사용하되, 벤치 대조에 필요하지만 거기 없는 지표
 * (점유율%, 패스 길이 분포, 롱패스 비율)는 스냅샷/이벤트에서 직접 재구성한다.
 *
 * 이 파일은 순수 분석 유틸(엔진 프로덕션 빌드 index.ts 에 export 되지 않음).
 */

/** E3/튜닝 측정용 고정 시드 20개(분산 완화, 재현). */
export const REALISM_SEEDS: string[] = [
  "4815162342", "9999999999", "1234567890", "2718281828", "1414213562",
  "1618033988", "31415926", "27182818", "16180339", "14142135",
  "1730123456", "8675309000", "1122334455", "9081726354", "5566778899",
  "1010101010", "2020202020", "3141592653", "6283185307", "1123581321",
];

const GK_IDS = new Set(["H0", "A0"]);
/** back four(base x<=0.25): 슬롯 1..4 = LB/LCB/RCB/RB. */
const DEFENDER_IDS = new Set(["H1", "H2", "H3", "H4", "A1", "A2", "A3", "A4"]);

export interface PassLenBuckets {
  /** 완결 패스(동팀 소유 이전)의 비행 거리 표본(m). */
  samples: number[];
  short: number; // <15m
  medium: number; // 15..30m
  long: number; // >=30m
}

/**
 * 스냅샷 소유권 이전으로 완결 패스의 비행 거리(m) 분포를 재구성한다.
 * 동팀 소유자 A→B 로 바뀌는 지점에서, A 가 마지막 소유한 틱의 공 위치와
 * B 가 처음 소유한 틱의 공 위치 사이 거리 = 패스 길이 근사.
 */
export function reconstructPassLengths(log: MatchLog): PassLenBuckets {
  const samples: number[] = [];
  let prevOwner: string | null = null;
  let prevBall: { x: number; y: number } | null = null;
  let releaseBall: { x: number; y: number } | null = null;
  for (const sn of log.tickSnapshots) {
    const o = sn.ballOwner;
    if (o != null && prevOwner != null && o !== prevOwner) {
      const sameTeam = o[0] === prevOwner[0];
      if (sameTeam && releaseBall) {
        const dx = sn.ball.x - releaseBall.x;
        const dy = sn.ball.y - releaseBall.y;
        samples.push(Math.sqrt(dx * dx + dy * dy));
      }
    }
    // 소유자가 유지되는 동안 마지막 위치를 release 후보로 갱신.
    if (o != null) {
      if (o === prevOwner || prevOwner == null) releaseBall = prevBall ?? { x: sn.ball.x, y: sn.ball.y };
    }
    prevOwner = o;
    prevBall = { x: sn.ball.x, y: sn.ball.y };
  }
  let short = 0, medium = 0, long = 0;
  for (const d of samples) {
    if (d < 15) short++;
    else if (d < 30) medium++;
    else long++;
  }
  return { samples, short, medium, long };
}

/** 점유율%(home 관점): ballOwner 가 있는 틱 중 home 소유 비율. */
export function possessionPct(log: MatchLog): { home: number; away: number } {
  let h = 0, a = 0;
  for (const sn of log.tickSnapshots) {
    if (sn.ballOwner == null) continue;
    if (sn.ballOwner[0] === "H") h++;
    else a++;
  }
  const tot = h + a;
  if (tot === 0) return { home: 0, away: 0 };
  return { home: (h / tot) * 100, away: (a / tot) * 100 };
}

/** 한 팀-경기의 파생 지표(벤치 대조에 필요한 것). */
export interface DerivedTeam {
  shots: number;
  onTarget: number;
  onTargetPct: number; // 유효슛/슛
  goals: number;
  shotConvPct: number; // 골/슛
  passAttempts: number;
  passCompleted: number;
  passSuccessPct: number;
  possessionPct: number;
  corners: number;
  throwIns: number;
  fouls: number;
  offsides: number;
  yellowCards: number;
  saves: number;
  avgWidthM: number;
  avgLengthM: number;
  avgDistanceKm: number;
  longPassPct: number; // 롱패스(>=30m) 비율
  mediumPassPct: number;
  shortPassPct: number;
  xgPerShot: number; // 슛 이벤트 평균 xG
}

/** 팀별 슛 이벤트 평균 xG(shot 킥 이벤트, 결과마커 제외). */
function xgPerShotBySide(log: MatchLog): { home: number; away: number } {
  const acc: Record<TeamSide, { sum: number; n: number }> = {
    home: { sum: 0, n: 0 },
    away: { sum: 0, n: 0 },
  };
  for (const e of log.events) {
    if (e.type !== "shot") continue;
    if (e.detail === "saved" || e.detail === "off_target") continue;
    if (e.team == null || e.xg == null) continue;
    acc[e.team].sum += e.xg;
    acc[e.team].n += 1;
  }
  return {
    home: acc.home.n > 0 ? acc.home.sum / acc.home.n : 0,
    away: acc.away.n > 0 ? acc.away.sum / acc.away.n : 0,
  };
}

function deriveTeam(t: TeamStats, possession: number, longPct: number, medPct: number, shortPct: number, xgPerShot: number): DerivedTeam {
  return {
    shots: t.shots,
    onTarget: t.onTarget,
    onTargetPct: t.shots > 0 ? (t.onTarget / t.shots) * 100 : 0,
    goals: t.goals,
    shotConvPct: t.shots > 0 ? (t.goals / t.shots) * 100 : 0,
    passAttempts: t.passAttempts,
    passCompleted: t.passCompleted,
    passSuccessPct: t.passSuccessPct,
    possessionPct: possession,
    corners: t.corners,
    throwIns: t.throwIns,
    fouls: t.fouls,
    offsides: t.offsides,
    yellowCards: t.yellowCards,
    saves: t.saves,
    avgWidthM: t.avgWidthM,
    avgLengthM: t.avgLengthM,
    avgDistanceKm: t.avgDistanceKm,
    longPassPct: longPct,
    mediumPassPct: medPct,
    shortPassPct: shortPct,
    xgPerShot,
  };
}

export interface AggResult {
  seeds: number;
  teamMatches: number; // = seeds*2
  /** 팀-경기 평균(모든 DerivedTeam 필드). */
  mean: DerivedTeam;
  /** 팀-경기 표준편차. */
  sd: DerivedTeam;
  /** 경기당 골 합(양팀) 평균. */
  goalsPerMatch: number;
  lastHash: string;
}

function mean(vals: number[]): number {
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
function sd(vals: number[], m: number): number {
  return Math.sqrt(vals.reduce((s, v) => s + (v - m) * (v - m), 0) / vals.length);
}

/** 다수 시드 리얼 config 집계. */
export function aggregateRealism(config: EngineConfig, seeds: string[] = REALISM_SEEDS): AggResult {
  const select = makeSelectData();
  const teamRows: DerivedTeam[] = [];
  let goalSum = 0;
  let lastHash = "";
  for (const seed of seeds) {
    const home = makeTacticalInput("H", seed);
    const away = makeTacticalInput("A", seed);
    const log = runMatch(seed, home, away, select, config);
    const stats: MatchStats = computeMatchStats(log, GK_IDS, {
      defenderIds: DEFENDER_IDS,
      pitchWidthM: config.pitch.width,
      finalThirdLine: config.setPiece.finalThirdLine,
    });
    const poss = possessionPct(log);
    const pl = reconstructPassLengths(log);
    const totPl = pl.samples.length || 1;
    const longPct = (pl.long / totPl) * 100;
    const medPct = (pl.medium / totPl) * 100;
    const shortPct = (pl.short / totPl) * 100;
    const xgps = xgPerShotBySide(log);
    teamRows.push(deriveTeam(stats.home, poss.home, longPct, medPct, shortPct, xgps.home));
    teamRows.push(deriveTeam(stats.away, poss.away, longPct, medPct, shortPct, xgps.away));
    goalSum += stats.home.goals + stats.away.goals;
    lastHash = log.tickSnapshots[log.tickSnapshots.length - 1]?.hash ?? lastHash;
  }
  const keys = Object.keys(teamRows[0]!) as (keyof DerivedTeam)[];
  const meanObj = {} as DerivedTeam;
  const sdObj = {} as DerivedTeam;
  for (const k of keys) {
    const vals = teamRows.map((r) => r[k]);
    const m = mean(vals);
    meanObj[k] = Math.round(m * 100) / 100;
    sdObj[k] = Math.round(sd(vals, m) * 100) / 100;
  }
  return {
    seeds: seeds.length,
    teamMatches: teamRows.length,
    mean: meanObj,
    sd: sdObj,
    goalsPerMatch: Math.round((goalSum / seeds.length) * 100) / 100,
    lastHash,
  };
}
