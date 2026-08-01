import type { MatchLog, MatchEvent, TeamSide, TickSnapshot, PlayerSnapshot } from "@hmb/shared";

/**
 * match-stats — MatchLog 를 후처리해 검증용 매치 스탯을 산출한다(결정론, 순수함수).
 * 벤치마크 대조용 + 변주(다이나믹) 지표: 슛/골/유효슛/세이브/off_target/1대1,
 * 슛→코너·골킥 전환, 패스성공률, 세트피스, 팀 shape,
 * 그리고 "단조로움" 정량화 지표(드리블 체인 길이·수비 오버랩 수·선수 위치 분산).
 *
 * width/length spread: 매 틱, 팀별 아웃필드(비-GK) 선수들의 좌표 바운딩박스(max-min).
 * 드리블 체인: 같은 소유자가 연속 틱 동안 공을 이동시킨 구간 길이(틱).
 * 수비 오버랩: 수비수(defenderIds)가 자기 공격 파이널서드로 진입한 횟수(rising-edge)·체류 틱.
 * 위치 분산: 선수별 위치의 평균으로부터 RMS 편차(m), 아웃필드 평균.
 */

export interface TeamStats {
  shots: number; // 슛 시도(결과마커 saved/off_target 제외)
  goals: number;
  onTarget: number; // 유효슛(세이브 + 골)
  savedShots: number; // 세이브된 유효슛
  offTargetShots: number; // 빗맞음
  oneOnOne: number; // 1대1(단독) 찬스 슛(하이라이트)
  shotToCorner: number; // 슛 결과가 코너로 전환된 수
  shotToGoalKick: number; // 슛 결과가 골킥으로 전환된 수
  passAttempts: number;
  passCompleted: number;
  passSuccessPct: number; // 0..100
  interceptionsConceded: number; // 이 팀 패스가 끊긴 수
  corners: number;
  throwIns: number;
  goalKicks: number;
  // --- 규칙(파울/오프사이드/카드/페널티/세이브) ---
  fouls: number; // 이 팀이 범한 파울
  offsides: number; // 이 팀이 걸린 오프사이드
  yellowCards: number;
  redCards: number;
  penaltiesFor: number; // 이 팀이 얻은 페널티
  saves: number; // 이 팀 GK 의 선방
  avgWidthM: number;
  avgLengthM: number;
  avgDistanceKm: number; // 아웃필드 평균 주행거리
  // --- 변주(다이나믹) 지표 ---
  avgDribbleChain: number; // 평균 드리블 연속 길이(틱)
  maxDribbleChain: number; // 최대 드리블 연속 길이(틱)
  dribbleChains: number; // 드리블 체인 개수
  defenderOverlaps: number; // 수비 오버랩 진입 횟수
  defenderOverlapTicks: number; // 수비 오버랩 체류 player-틱
  posSpreadM: number; // 선수 위치 분산(평균 RMS 편차, m)
}

export interface MatchStats {
  home: TeamStats;
  away: TeamStats;
  inPlayTicks: number;
  totalTicks: number;
}

export interface StatsOptions {
  /** 수비수(오버랩 계측 대상) playerId 집합. */
  defenderIds?: Set<string>;
  /** 피치 길이(m). 기본 105. */
  pitchWidthM?: number;
  /** 파이널서드 경계(공격 방향 정규화 x, 0..1). 기본 0.66. */
  finalThirdLine?: number;
}

function range(vals: number[]): number {
  if (vals.length === 0) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

/**
 * 그 스냅샷에서 공을 가진 팀. `"home" | "away" | null`.
 *
 * ⚠️ 종전 구현은 `id.startsWith("H") ? "home" : "away"` 였다. 엔진 픽스처 id(`H9`/`A3`)에선 맞지만
 * **실경기 id 는 양 팀 다 `P0xx`** 라 항상 "away" 로 떨어진다 — 실덱 픽스처(#374)를 넣자마자
 * 주행거리가 home 0 / away 63km 로 나왔다. `ballOwner` 는 순수 playerId 라 문자열만으로는 팀을
 * 알 수 없고(shared 계약), 같은 id 가 양 팀에 동시에 있을 수도 있다(카탈로그 공유 — #231).
 * 유일하게 옳은 방법은 **그 스냅샷의 `players[].team` 을 보는 것**이다.
 *
 * 브라우저 쪽 쌍둥이 = `packages/viewer-core/src/owner-side.mjs`(#324). 두 구현이 조용히 갈라지지
 * 않게 `match-stats.test.ts` 가 같은 로그에서 같은 답을 내는지 계약으로 박제한다.
 */
export function ownerSideOfSnapshot(snap: TickSnapshot): TeamSide | null {
  const id = snap.ballOwner;
  if (!id) return null;
  let found: PlayerSnapshot | null = null;
  let best = Infinity;
  let count = 0;
  for (const p of snap.players) {
    if (p.playerId !== id) continue;
    count += 1;
    if (count === 1) {
      found = p;
      continue;
    }
    // 중복 id — 공에 더 가까운 쪽이 실제 소유자다.
    if (best === Infinity && found) best = Math.hypot(found.pos.x - snap.ball.x, found.pos.y - snap.ball.y);
    const d = Math.hypot(p.pos.x - snap.ball.x, p.pos.y - snap.ball.y);
    if (d < best) {
      best = d;
      found = p;
    }
  }
  return found ? found.team : null;
}

/**
 * 선수별 누적의 키. **`(team, playerId)`** 여야 한다 — playerId 단독으로 잡으면 같은 선수가
 * 양 팀에 출전한 하프에서 두 인스턴스가 한 버킷에 합쳐져 좌표가 두 사람 사이를 오간다
 * (실측: 주행거리 63km/경기). 엔진이 `simstate.playerKey` 로 같은 결론에 도달한 것과 같은 이유다.
 */
function pkey(p: PlayerSnapshot): string {
  return `${p.team}:${p.playerId}`;
}
function sideOfKey(key: string): TeamSide {
  return key.startsWith("home:") ? "home" : "away";
}
function idOfKey(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

const EMPTY: TeamStats = {
  shots: 0, goals: 0, onTarget: 0, savedShots: 0, offTargetShots: 0, oneOnOne: 0,
  shotToCorner: 0, shotToGoalKick: 0, passAttempts: 0, passCompleted: 0, passSuccessPct: 0,
  interceptionsConceded: 0, corners: 0, throwIns: 0, goalKicks: 0,
  fouls: 0, offsides: 0, yellowCards: 0, redCards: 0, penaltiesFor: 0, saves: 0,
  avgWidthM: 0, avgLengthM: 0, avgDistanceKm: 0,
  avgDribbleChain: 0, maxDribbleChain: 0, dribbleChains: 0,
  defenderOverlaps: 0, defenderOverlapTicks: 0, posSpreadM: 0,
};

/** 슛 시도 이벤트(결과마커 아님) 여부. saved/off_target 은 resolveShot 이 남기는 결과 이벤트. */
function isShotAttempt(e: MatchEvent): boolean {
  return e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target";
}

export function computeMatchStats(log: MatchLog, gkIds: Set<string>, opts: StatsOptions = {}): MatchStats {
  const sides: TeamSide[] = ["home", "away"];
  const ev = log.events;
  const defenderIds = opts.defenderIds ?? new Set<string>();
  const widthM = opts.pitchWidthM ?? 105;
  const finalThird = opts.finalThirdLine ?? 0.66;
  // 공격 파이널서드 경계(실좌표 x): home 은 +x, away 는 -x.
  const homeLineX = widthM * finalThird;
  const awayLineX = widthM * (1 - finalThird);

  function count(pred: (e: MatchEvent) => boolean): number {
    let n = 0;
    for (const e of ev) if (pred(e)) n++;
    return n;
  }

  // 슛 → 코너/골킥 전환: 결과 이벤트(off_target/saved) 뒤에 이어지는 코너/골킥 재시작을 페어링.
  // 0.6.0 부터 슛 아웃은 shot_out 짧은 정지를 거쳐 몇 틱 뒤 세트피스가 시작되므로(코너 순간이동 방지),
  // 같은 틱이 아니라 결과 이벤트 바로 다음 이벤트(정지 동안 이벤트 없음 → 다음 = 그 재시작)로 매칭한다.
  const shotToCorner: Record<TeamSide, number> = { home: 0, away: 0 };
  const shotToGoalKick: Record<TeamSide, number> = { home: 0, away: 0 };
  for (let i = 0; i < ev.length - 1; i++) {
    const e = ev[i]!;
    const n = ev[i + 1]!;
    const isResult = e.type === "shot" && (e.detail === "saved" || e.detail === "off_target");
    if (!isResult || e.team == null) continue;
    if (n.type === "kickoff") {
      if (n.detail === "corner") shotToCorner[e.team] += 1;
      else if (n.detail === "goal_kick") shotToGoalKick[e.team] += 1;
    }
  }

  const stat = (side: TeamSide): TeamStats => {
    const shots = count((e) => isShotAttempt(e) && e.team === side);
    const goals = count((e) => e.type === "goal" && e.team === side);
    const savedShots = count((e) => e.type === "shot" && e.team === side && e.detail === "saved");
    const offTargetShots = count((e) => e.type === "shot" && e.team === side && e.detail === "off_target");
    const oneOnOne = count((e) => e.type === "shot" && e.team === side && e.detail === "one_on_one");
    const onTarget = goals + savedShots;
    const passCompleted = count((e) => e.type === "pass" && e.team === side);
    const opp: TeamSide = side === "home" ? "away" : "home";
    const interceptionsConceded = count((e) => e.type === "interception" && e.team === opp);
    const throwIns = count((e) => e.type === "kickoff" && e.team === side && e.detail === "throw_in");
    const corners = count((e) => e.type === "kickoff" && e.team === side && e.detail === "corner");
    const goalKicks = count((e) => e.type === "kickoff" && e.team === side && e.detail === "goal_kick");
    const throwInConceded = count((e) => e.type === "kickoff" && e.team === opp && e.detail === "throw_in");
    const passAttempts = passCompleted + interceptionsConceded + throwInConceded;
    const passSuccessPct = passAttempts > 0 ? Math.round((passCompleted / passAttempts) * 1000) / 10 : 0;
    // 규칙 이벤트: foul=범한 팀, offside=걸린(공격) 팀, card=선수 팀, penalty=얻은 팀, save=수비 GK 팀.
    const fouls = count((e) => e.type === "foul" && e.team === side);
    const offsides = count((e) => e.type === "offside" && e.team === side);
    const yellowCards = count((e) => e.type === "card" && e.team === side && e.detail === "yellow");
    const redCards = count((e) => e.type === "card" && e.team === side && e.detail === "red");
    const penaltiesFor = count((e) => e.type === "penalty" && e.team === side);
    const saves = count((e) => e.type === "save" && e.team === side);
    return {
      ...EMPTY,
      shots, goals, onTarget, savedShots, offTargetShots, oneOnOne,
      shotToCorner: shotToCorner[side], shotToGoalKick: shotToGoalKick[side],
      passAttempts, passCompleted, passSuccessPct, interceptionsConceded,
      corners, throwIns, goalKicks,
      fouls, offsides, yellowCards, redCards, penaltiesFor, saves,
    };
  };

  const home = stat("home");
  const away = stat("away");

  // --- spread + 주행거리 + 위치 분산(스냅샷 순회) ---
  const acc: Record<TeamSide, { wSum: number; lSum: number; n: number }> = {
    home: { wSum: 0, lSum: 0, n: 0 },
    away: { wSum: 0, lSum: 0, n: 0 },
  };
  const distByPlayer = new Map<string, number>();
  const lastPos = new Map<string, { x: number; y: number }>();
  // 위치 분산: 선수별 Σx, Σy, Σ(x²+y²), n.
  const posAcc = new Map<string, { sx: number; sy: number; sq: number; n: number }>();
  // 수비 오버랩: 선수별 직전 "파이널서드 내부" 여부.
  const overlapIn = new Map<string, boolean>();

  for (const snap of log.tickSnapshots) {
    const xs: Record<TeamSide, number[]> = { home: [], away: [] };
    const ys: Record<TeamSide, number[]> = { home: [], away: [] };
    for (const p of snap.players) {
      const key = pkey(p);
      const prev = lastPos.get(key);
      if (prev) {
        const dx = p.pos.x - prev.x;
        const dy = p.pos.y - prev.y;
        distByPlayer.set(key, (distByPlayer.get(key) ?? 0) + Math.sqrt(dx * dx + dy * dy));
      }
      lastPos.set(key, { x: p.pos.x, y: p.pos.y });
      if (gkIds.has(p.playerId)) continue;
      xs[p.team].push(p.pos.x);
      ys[p.team].push(p.pos.y);
      // 위치 분산 누적.
      const pa = posAcc.get(key) ?? { sx: 0, sy: 0, sq: 0, n: 0 };
      pa.sx += p.pos.x; pa.sy += p.pos.y; pa.sq += p.pos.x * p.pos.x + p.pos.y * p.pos.y; pa.n += 1;
      posAcc.set(key, pa);
      // 수비 오버랩(수비수가 자기 공격 파이널서드 진입).
      if (defenderIds.has(p.playerId)) {
        const inFinal = p.team === "home" ? p.pos.x >= homeLineX : p.pos.x <= awayLineX;
        const was = overlapIn.get(key) ?? false;
        const t = p.team === "home" ? home : away;
        if (inFinal) t.defenderOverlapTicks += 1;
        if (inFinal && !was) t.defenderOverlaps += 1;
        overlapIn.set(key, inFinal);
      }
    }
    for (const s of sides) {
      acc[s].wSum += range(ys[s]);
      acc[s].lSum += range(xs[s]);
      acc[s].n += 1;
    }
  }

  for (const s of sides) {
    const a = acc[s];
    const t = s === "home" ? home : away;
    t.avgWidthM = a.n > 0 ? Math.round((a.wSum / a.n) * 10) / 10 : 0;
    t.avgLengthM = a.n > 0 ? Math.round((a.lSum / a.n) * 10) / 10 : 0;
  }

  // 아웃필드 평균 주행거리 + 위치 분산(RMS 편차).
  const finalizeSide = (side: TeamSide, t: TeamStats): void => {
    let distSum = 0, distN = 0, spreadSum = 0, spreadN = 0;
    for (const [key, d] of distByPlayer) {
      if (gkIds.has(idOfKey(key)) || sideOfKey(key) !== side) continue;
      distSum += d; distN += 1;
    }
    for (const [key, pa] of posAcc) {
      if (sideOfKey(key) !== side || pa.n === 0) continue;
      const mx = pa.sx / pa.n, my = pa.sy / pa.n;
      const variance = pa.sq / pa.n - (mx * mx + my * my); // E[r²]-|E[r]|²
      spreadSum += Math.sqrt(Math.max(0, variance));
      spreadN += 1;
    }
    t.avgDistanceKm = distN > 0 ? Math.round((distSum / distN / 1000) * 100) / 100 : 0;
    t.posSpreadM = spreadN > 0 ? Math.round((spreadSum / spreadN) * 10) / 10 : 0;
  };
  finalizeSide("home", home);
  finalizeSide("away", away);

  // --- 드리블 체인(같은 소유자가 연속 틱 공을 이동) ---
  const chainSum: Record<TeamSide, number> = { home: 0, away: 0 };
  const chainCnt: Record<TeamSide, number> = { home: 0, away: 0 };
  const chainMax: Record<TeamSide, number> = { home: 0, away: 0 };
  const EPS = 0.5; // m/틱 이상 이동 시 캐리(드리블)로 간주(홀드=거의 정지 제외).
  let runLen = 0;
  let runSide: TeamSide | null = null;
  let prevOwner: string | null = null;
  let prevBall: { x: number; y: number } | null = null;
  const flush = (): void => {
    if (runLen > 0 && runSide) {
      chainSum[runSide] += runLen;
      chainCnt[runSide] += 1;
      if (runLen > chainMax[runSide]) chainMax[runSide] = runLen;
    }
    runLen = 0; runSide = null;
  };
  for (const snap of log.tickSnapshots) {
    const owner = snap.ballOwner;
    const ball = snap.ball;
    if (owner != null && prevOwner === owner && prevBall) {
      const dx = ball.x - prevBall.x, dy = ball.y - prevBall.y;
      if (Math.sqrt(dx * dx + dy * dy) > EPS) {
        if (runSide === null) { runSide = ownerSideOfSnapshot(snap); runLen = 1; }
        else runLen += 1;
      } else flush();
    } else flush();
    prevOwner = owner; prevBall = ball;
  }
  flush();
  for (const s of sides) {
    const t = s === "home" ? home : away;
    t.dribbleChains = chainCnt[s];
    t.avgDribbleChain = chainCnt[s] > 0 ? Math.round((chainSum[s] / chainCnt[s]) * 10) / 10 : 0;
    t.maxDribbleChain = chainMax[s];
  }

  return { home, away, inPlayTicks: log.tickSnapshots.length, totalTicks: log.tickSnapshots.length };
}

/** 벤치마크 대조 + 변주 지표 표(텍스트). AC-stats-v2.log 로 저장할 본문. */
export function formatStatsReport(stats: MatchStats, meta: Record<string, unknown>): string {
  const { home, away } = stats;
  const avg = (a: number, b: number): number => Math.round(((a + b) / 2) * 10) / 10;
  const lines: string[] = [];
  lines.push("=== HMB S1 엔진 재튜닝 — 매치 스탯 (v2) ===");
  lines.push(`meta: ${JSON.stringify(meta)}`);
  lines.push("");
  const col = (s: string, w: number): string => s.padEnd(w);
  lines.push(col("지표", 24) + col("home", 10) + col("away", 10) + col("합/평균", 12) + "벤치마크(팀)");
  const row = (label: string, h: number | string, a: number | string, agg: number | string, bench: string): void => {
    lines.push(col(label, 24) + col(String(h), 10) + col(String(a), 10) + col(String(agg), 12) + bench);
  };
  row("슛(시도)", home.shots, away.shots, avg(home.shots, away.shots), "12-16");
  row("유효슛", home.onTarget, away.onTarget, avg(home.onTarget, away.onTarget), "4.5-5.5");
  row("세이브", home.savedShots, away.savedShots, home.savedShots + away.savedShots, "-");
  row("off_target", home.offTargetShots, away.offTargetShots, home.offTargetShots + away.offTargetShots, "-");
  row("1대1 찬스", home.oneOnOne, away.oneOnOne, home.oneOnOne + away.oneOnOne, "~1-3.5");
  row("골", home.goals, away.goals, avg(home.goals, away.goals), "1.4-1.65");
  row("슛→코너 전환", home.shotToCorner, away.shotToCorner, home.shotToCorner + away.shotToCorner, "-");
  row("슛→골킥 전환", home.shotToGoalKick, away.shotToGoalKick, home.shotToGoalKick + away.shotToGoalKick, "-");
  row("패스 시도", home.passAttempts, away.passAttempts, avg(home.passAttempts, away.passAttempts), "350-650");
  row("패스 성공", home.passCompleted, away.passCompleted, "-", "-");
  row("패스 성공률(%)", home.passSuccessPct, away.passSuccessPct, avg(home.passSuccessPct, away.passSuccessPct), "78-85");
  row("코너", home.corners, away.corners, home.corners + away.corners, "~5 (양팀~10)");
  row("스로인", home.throwIns, away.throwIns, home.throwIns + away.throwIns, "~17-19");
  row("골킥", home.goalKicks, away.goalKicks, home.goalKicks + away.goalKicks, "-");
  lines.push("");
  lines.push("--- 규칙(파울/오프사이드/카드/페널티/세이브) ---");
  row("파울(범함)", home.fouls, away.fouls, home.fouls + away.fouls, "~22-24 (팀11-12)");
  row("오프사이드", home.offsides, away.offsides, home.offsides + away.offsides, "팀 ~1-3");
  row("옐로카드", home.yellowCards, away.yellowCards, home.yellowCards + away.yellowCards, "~3.5-4 (팀~2)");
  row("레드카드", home.redCards, away.redCards, home.redCards + away.redCards, "~0.1-0.2");
  row("페널티", home.penaltiesFor, away.penaltiesFor, home.penaltiesFor + away.penaltiesFor, "~0.2-0.3");
  row("세이브(GK)", home.saves, away.saves, home.saves + away.saves, "-");
  row("팀 width(m)", home.avgWidthM, away.avgWidthM, avg(home.avgWidthM, away.avgWidthM), "40-50");
  row("팀 length(m)", home.avgLengthM, away.avgLengthM, avg(home.avgLengthM, away.avgLengthM), "25-40");
  row("주행거리(km/선수)", home.avgDistanceKm, away.avgDistanceKm, avg(home.avgDistanceKm, away.avgDistanceKm), "10-12");
  lines.push("");
  lines.push("--- 변주(다이나믹) 지표 ---");
  row("평균 드리블 체인(틱)", home.avgDribbleChain, away.avgDribbleChain, avg(home.avgDribbleChain, away.avgDribbleChain), "높을수록 롱드리블↑");
  row("최대 드리블 체인(틱)", home.maxDribbleChain, away.maxDribbleChain, Math.max(home.maxDribbleChain, away.maxDribbleChain), "-");
  row("드리블 체인 수", home.dribbleChains, away.dribbleChains, home.dribbleChains + away.dribbleChains, "-");
  row("수비 오버랩(횟수)", home.defenderOverlaps, away.defenderOverlaps, home.defenderOverlaps + away.defenderOverlaps, "돌발성↑");
  row("수비 오버랩(player-틱)", home.defenderOverlapTicks, away.defenderOverlapTicks, home.defenderOverlapTicks + away.defenderOverlapTicks, "-");
  row("위치 분산(RMS m)", home.posSpreadM, away.posSpreadM, avg(home.posSpreadM, away.posSpreadM), "높을수록 로밍↑");
  lines.push("");
  lines.push(`inPlayTicks=${stats.inPlayTicks} totalTicks=${stats.totalTicks}`);
  return lines.join("\n");
}
