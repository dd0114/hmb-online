import type { MatchLog, TeamSide } from "@hmb/shared";

/**
 * match-stats — MatchLog 를 후처리해 검증용 매치 스탯을 산출한다(결정론, 순수함수).
 * 벤치마크 대조용: 슛/골/패스성공률/코너/스로인/골킥, 팀 평균 width·length spread(m),
 * 선수 평균 주행거리 근사(km).
 *
 * width/length spread: 매 틱, 팀별 아웃필드(비-GK) 선수들의 좌표 바운딩박스(max-min).
 *  - width  = y 축(가로, 폭) 범위(m)
 *  - length = x 축(세로, 길이 방향) 범위(m)
 * 주행거리: 선수별 틱간 변위 합(m) → km, 아웃필드 평균.
 */

export interface TeamStats {
  shots: number; // 슛 시도(세이브 이벤트 제외)
  goals: number;
  onTarget: number; // 유효슛(세이브 + 골)
  passAttempts: number;
  passCompleted: number;
  passSuccessPct: number; // 0..100
  interceptionsConceded: number; // 이 팀 패스가 끊긴 수
  corners: number;
  throwIns: number;
  goalKicks: number;
  avgWidthM: number;
  avgLengthM: number;
  avgDistanceKm: number; // 아웃필드 평균 주행거리
}

export interface MatchStats {
  home: TeamStats;
  away: TeamStats;
  inPlayTicks: number;
  totalTicks: number;
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

export function computeMatchStats(log: MatchLog, gkIds: Set<string>): MatchStats {
  const sides: TeamSide[] = ["home", "away"];
  const ev = log.events;

  function count(pred: (e: (typeof ev)[number]) => boolean): number {
    let n = 0;
    for (const e of ev) if (pred(e)) n++;
    return n;
  }

  const stat = (side: TeamSide): TeamStats => {
    // 슛 시도 = 슛 킥 이벤트(detail 없음). saved/off_target 는 별도 결과 이벤트라 제외.
    const shots = count((e) => e.type === "shot" && e.team === side && e.detail == null);
    const goals = count((e) => e.type === "goal" && e.team === side);
    const saved = count((e) => e.type === "shot" && e.team === side && e.detail === "saved");
    // 유효슛 = 골 + 세이브(빗맞음 off_target 제외).
    const onTarget = goals + saved;
    const passCompleted = count((e) => e.type === "pass" && e.team === side);
    // 이 팀 패스가 상대에게 끊긴 수 = 상대 팀 interception 이벤트.
    const opp: TeamSide = side === "home" ? "away" : "home";
    const interceptionsConceded = count((e) => e.type === "interception" && e.team === opp);
    const throwIns = count(
      (e) => e.type === "kickoff" && e.team === side && e.detail === "throw_in",
    );
    const corners = count((e) => e.type === "kickoff" && e.team === side && e.detail === "corner");
    const goalKicks = count(
      (e) => e.type === "kickoff" && e.team === side && e.detail === "goal_kick",
    );
    // 패스 시도 ≈ 성공 + 상대 인터셉트 + 사이드라인 아웃(스로인)으로 흘린 패스.
    // 스로인은 전부 패스 fail_out(사이드라인)에서 발생 → 상대에게 주어짐(team=opp).
    // (골라인 아웃=골킥은 슛 빗맞음과 섞이므로 성공률 분모에서 제외 — 소수라 무시.)
    const throwInConceded = count(
      (e) => e.type === "kickoff" && e.team === opp && e.detail === "throw_in",
    );
    const passAttempts = passCompleted + interceptionsConceded + throwInConceded;
    const passSuccessPct =
      passAttempts > 0 ? Math.round((passCompleted / passAttempts) * 1000) / 10 : 0;
    return {
      shots,
      goals,
      onTarget,
      passAttempts,
      passCompleted,
      passSuccessPct,
      interceptionsConceded,
      corners,
      throwIns,
      goalKicks,
      avgWidthM: 0,
      avgLengthM: 0,
      avgDistanceKm: 0,
    };
  };

  const home = stat("home");
  const away = stat("away");

  // --- spread + 주행거리(스냅샷 순회) ---
  const acc: Record<TeamSide, { wSum: number; lSum: number; n: number }> = {
    home: { wSum: 0, lSum: 0, n: 0 },
    away: { wSum: 0, lSum: 0, n: 0 },
  };
  const distByPlayer = new Map<string, number>();
  const lastPos = new Map<string, { x: number; y: number }>();

  for (const snap of log.tickSnapshots) {
    const xs: Record<TeamSide, number[]> = { home: [], away: [] };
    const ys: Record<TeamSide, number[]> = { home: [], away: [] };
    for (const p of snap.players) {
      // 주행거리(모든 선수).
      const prev = lastPos.get(p.playerId);
      if (prev) {
        const dx = p.pos.x - prev.x;
        const dy = p.pos.y - prev.y;
        distByPlayer.set(
          p.playerId,
          (distByPlayer.get(p.playerId) ?? 0) + Math.sqrt(dx * dx + dy * dy),
        );
      }
      lastPos.set(p.playerId, { x: p.pos.x, y: p.pos.y });
      // spread(아웃필드만).
      if (gkIds.has(p.playerId)) continue;
      xs[p.team].push(p.pos.x);
      ys[p.team].push(p.pos.y);
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

  // 아웃필드 평균 주행거리.
  const avgDist = (side: TeamSide): number => {
    let sum = 0;
    let n = 0;
    for (const [id, d] of distByPlayer) {
      if (gkIds.has(id)) continue;
      if (side === "home" && !id.startsWith("H")) continue;
      if (side === "away" && !id.startsWith("A")) continue;
      sum += d;
      n += 1;
    }
    return n > 0 ? Math.round((sum / n / 1000) * 100) / 100 : 0;
  };
  home.avgDistanceKm = avgDist("home");
  away.avgDistanceKm = avgDist("away");

  return {
    home,
    away,
    inPlayTicks: log.tickSnapshots.length,
    totalTicks: log.tickSnapshots.length,
  };
}

/** 벤치마크 대조 표(텍스트). AC-stats-v2.log 로 저장할 본문. */
export function formatStatsReport(stats: MatchStats, meta: Record<string, unknown>): string {
  const { home, away } = stats;
  const avg = (a: number, b: number): number => Math.round(((a + b) / 2) * 10) / 10;
  const lines: string[] = [];
  lines.push("=== HMB S1 엔진 재튜닝 — 매치 스탯 (v2) ===");
  lines.push(`meta: ${JSON.stringify(meta)}`);
  lines.push("");
  const col = (s: string, w: number): string => s.padEnd(w);
  lines.push(
    col("지표", 22) + col("home", 10) + col("away", 10) + col("합/평균", 12) + "벤치마크(팀)",
  );
  const row = (
    label: string,
    h: number | string,
    a: number | string,
    agg: number | string,
    bench: string,
  ): void => {
    lines.push(col(label, 22) + col(String(h), 10) + col(String(a), 10) + col(String(agg), 12) + bench);
  };
  row("슛(시도)", home.shots, away.shots, avg(home.shots, away.shots), "12-16");
  row("유효슛", home.onTarget, away.onTarget, avg(home.onTarget, away.onTarget), "4.5-5.5");
  row("골", home.goals, away.goals, avg(home.goals, away.goals), "1.4-1.65");
  row("패스 시도", home.passAttempts, away.passAttempts, avg(home.passAttempts, away.passAttempts), "350-650");
  row("패스 성공", home.passCompleted, away.passCompleted, "-", "-");
  row(
    "패스 성공률(%)",
    home.passSuccessPct,
    away.passSuccessPct,
    avg(home.passSuccessPct, away.passSuccessPct),
    "78-85",
  );
  row("코너", home.corners, away.corners, home.corners + away.corners, "~5 (양팀~10)");
  row("스로인", home.throwIns, away.throwIns, home.throwIns + away.throwIns, "~17-19");
  row("골킥", home.goalKicks, away.goalKicks, home.goalKicks + away.goalKicks, "-");
  row("팀 width(m)", home.avgWidthM, away.avgWidthM, avg(home.avgWidthM, away.avgWidthM), "40-50");
  row("팀 length(m)", home.avgLengthM, away.avgLengthM, avg(home.avgLengthM, away.avgLengthM), "25-40");
  row(
    "주행거리(km/선수)",
    home.avgDistanceKm,
    away.avgDistanceKm,
    avg(home.avgDistanceKm, away.avgDistanceKm),
    "10-12",
  );
  lines.push("");
  lines.push(`inPlayTicks=${stats.inPlayTicks} totalTicks=${stats.totalTicks}`);
  return lines.join("\n");
}
