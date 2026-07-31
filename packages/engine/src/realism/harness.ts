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

/**
 * 회귀 가드용 확장 시드(60 = REALISM_SEEDS ×3). (#182 / gameqa 표준 — bug176 과 통일)
 *
 * 쓰는 이유는 **사다리 단조성** 때문이다. 팀당 슛의 팀-경기 표본표준편차 SD ≈ 4.2–5.1 이라
 *   SE(Δ) = √(SD²+SD²)/√(2n) ≈ 0.66 (n=20) · 0.47 (n=60 → 팀-경기 120)
 * 인데, **폭 0.04 짜리 rung**(구 사다리의 0.30↔0.34)의 참효과는 그와 같은 자릿수여서 부호가
 * 표본마다 뒤집힌다. 독립 QA 가 REALISM_SEEDS 를 6개 독립 배치로 쪼개 재현했을 때
 * Δ = +0.92 / +0.37 / +0.85 / +0.30 / **−0.43** / **−0.80** 로 **6개 중 2개가 역전**했다.
 * → 사다리 rung 간격을 ≥0.08 로 벌리고(폭 0.11 rung 의 참효과는 +1.6 수준) 표본을 60 으로 올린다.
 *
 * ⚠️ 사실관계 두 가지(스테일 주석 방지):
 *  1) **밴드(12–14)는 n=20 에서도 통과한다.** 이 상향은 밴드 회피가 아니라 사다리 플래키니스 제거다.
 *  2) 위 역전 실측은 **#182 재보정(foul.base 0.0178) 이전** 트리 값이다. 재보정 후 같은 rung 을
 *     다시 재면 n=20 Δ=+0.78 · n=60 Δ=+1.07 로 **지금은 여유가 있다**. 그래도 사다리를 되돌리지
 *     않는 이유는, 그 여유가 이 config 지점의 우연이지 rung 폭 0.04 가 안전해졌다는 뜻이 아니기
 *     때문이다(튜닝이 조금만 움직이면 다시 노이즈 바닥으로 내려간다).
 * 밴드·단조성 **기준 자체는 하나도 바꾸지 않았고**, 측정 표본만 늘려 SE 를 줄인다(검정력↑).
 */
export const GUARD_SEEDS: string[] = [
  ...REALISM_SEEDS,
  ...REALISM_SEEDS.map((s) => `7${s}`),
  ...REALISM_SEEDS.map((s) => `13${s}`),
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

/** 데드볼 재배치 이벤트 — 이 틱을 건너뛴 소유 이전은 패스가 아니다(스로인/골킥/코너/프리킥/PK/킥오프). */
const RESTART_KINDS = new Set(["corner", "goal_kick", "throw_in", "free_kick", "penalty", "kickoff"]);

/**
 * 스냅샷 소유권 이전으로 완결 패스의 비행 거리(m) 분포를 재구성한다.
 * 동팀 소유자 A→B 로 바뀌는 지점에서, A 가 마지막 소유한 틱의 공 위치와
 * B 가 처음 소유한 틱의 공 위치 사이 거리 = 패스 길이 근사.
 *
 * #181: 데드볼 재배치를 사이에 낀 이전은 **제외**한다. 아웃 → 반대편 스팟 재시작처럼 공이
 * 규칙상 순간이동한 구간까지 "패스 비행"으로 세면 롱볼 비율이 과대(39%)로 부풀었다.
 */
export function reconstructPassLengths(log: MatchLog): PassLenBuckets {
  const samples: number[] = [];
  const restartTicks = new Set<number>();
  for (const e of log.events) {
    const kind = e.type === "kickoff" && e.detail ? e.detail : e.type;
    if (RESTART_KINDS.has(kind) || RESTART_KINDS.has(e.type)) restartTicks.add(e.tick);
  }
  // #181: **마지막으로 공을 가졌던 사람과 그때의 공 위치**를 비행 구간 너머로 기억한다.
  // 구버전은 직전 스냅샷의 ballOwner 만 봐서, 비행이 2틱 이상인 패스는 사이에 owner=null 이 끼어
  // 표본에서 통째로 빠졌다(도착 관용 18m 시절엔 대부분 패스가 1틱이라 드러나지 않았다).
  // 그 결과 긴 패스만 선택적으로 누락돼 길이 분포가 짧은 쪽으로 붕괴했다(측정 아티팩트).
  // release = 그 사람이 공을 **마지막으로 지녔던 틱의 공 위치**(= 찬 지점).
  let lastOwner: string | null = null;
  let releaseBall: { x: number; y: number } | null = null;
  let releaseTick = -1;
  let restartBetween = false;
  for (const sn of log.tickSnapshots) {
    if (restartTicks.has(sn.tick)) restartBetween = true;
    const o = sn.ballOwner;
    if (o == null) continue; // 비행/루즈 구간은 건너뛴다(소유 이전이 아니다).
    if (lastOwner != null && o !== lastOwner && releaseBall && o[0] === lastOwner[0] && !restartBetween) {
      const dx = sn.ball.x - releaseBall.x;
      const dy = sn.ball.y - releaseBall.y;
      samples.push(Math.sqrt(dx * dx + dy * dy));
    }
    lastOwner = o;
    releaseBall = { x: sn.ball.x, y: sn.ball.y };
    releaseTick = sn.tick;
    restartBetween = false;
  }
  void releaseTick;
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
  longPassPct: number; // 롱패스(>=30m) 비율 (재구성, 노이즈 포함)
  mediumPassPct: number;
  shortPassPct: number;
  xgPerShot: number; // 슛 이벤트 평균 xG
  longShareOfAttempts: number; // 의도적 롱패스 시도 비율(detail=long), E2 벤치 12-15%
}

/** 팀별 롱패스 시도 비율 = detail="long" (pass+interception) / 전체 (pass+interception). (E2) */
function longShareBySide(log: MatchLog): { home: number; away: number } {
  const acc: Record<TeamSide, { long: number; all: number }> = {
    home: { long: 0, all: 0 },
    away: { long: 0, all: 0 },
  };
  for (const e of log.events) {
    // 패스 시도 = 완결 pass(passer 팀) + interception(passer=상대팀). passer 팀 기준 집계.
    let passerSide: TeamSide | null = null;
    if (e.type === "pass" && e.team) passerSide = e.team;
    else if (e.type === "interception" && e.team) passerSide = e.team === "home" ? "away" : "home";
    if (!passerSide) continue;
    acc[passerSide].all += 1;
    if (e.detail === "long") acc[passerSide].long += 1;
  }
  return {
    home: acc.home.all > 0 ? (acc.home.long / acc.home.all) * 100 : 0,
    away: acc.away.all > 0 ? (acc.away.long / acc.away.all) * 100 : 0,
  };
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

function deriveTeam(t: TeamStats, possession: number, longPct: number, medPct: number, shortPct: number, xgPerShot: number, longShare: number): DerivedTeam {
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
    longShareOfAttempts: longShare,
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
    const ls = longShareBySide(log);
    teamRows.push(deriveTeam(stats.home, poss.home, longPct, medPct, shortPct, xgps.home, ls.home));
    teamRows.push(deriveTeam(stats.away, poss.away, longPct, medPct, shortPct, xgps.away, ls.away));
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

/**
 * 점표기 경로(`"rules.foul.base"`) → 값 으로 config 를 만든다. 격자 스윕을 문자열 스펙(env JSON)
 * 으로 넘기기 위한 유틸 — `volume-sweep` 과 `foul-sweep` 이 **같은 함수**를 쓴다(두 스윕이
 * 서로 다른 방식으로 config 를 조립하면 같은 점을 재도 값이 갈린다).
 */
export type ConfigPoint = Record<string, number>;

export function pointConfig(base: EngineConfig, p: ConfigPoint): EngineConfig {
  const out = JSON.parse(JSON.stringify(base)) as EngineConfig;
  for (const [path, v] of Object.entries(p)) {
    if (path === "label") continue;
    const seg = path.split(".");
    let node = out as unknown as Record<string, unknown>;
    for (let i = 0; i < seg.length - 1; i++) node = node[seg[i]!] as Record<string, unknown>;
    node[seg[seg.length - 1]!] = v;
  }
  return out;
}
