import type { MatchLog, TeamSide } from "@hmb/shared";

/**
 * 경량 매치 스탯(뷰 레이어 A/B diff 용) — MatchLog tickSnapshots + events 에서 파생.
 * 결정론 무관(읽기 전용 집계). "선수별 프롬프트 → 경기 달라짐" 을 수치로 드러내는 게 목적.
 */

export interface PlayerStat {
  playerId: string;
  avgX: number; // 평균 전진도(0=자기 골문 … 105=상대 골문). 공격 성향 프록시.
  avgY: number; // 평균 좌우 위치(0..68).
  distanceKm: number; // 총 이동거리 — forwardRun/로밍 성향 프록시.
  touches: number; // ballOwner 로 잡힌 틱 수.
}

export interface TeamStat {
  side: TeamSide;
  goals: number;
  shots: number;
  passes: number;
  avgLineX: number; // 아웃필드 평균 전진도(라인 높이 프록시).
  widthSpreadM: number; // 아웃필드 y 표준편차(폭 사용 프록시).
  players: PlayerStat[];
}

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

export function teamStat(log: MatchLog, side: TeamSide): TeamStat {
  const snaps = log.tickSnapshots;
  // 선수별 누적.
  const acc = new Map<string, { xs: number[]; ys: number[]; dist: number; touches: number; lastX: number | null; lastY: number | null }>();
  for (const s of snaps) {
    for (const p of s.players) {
      if (p.team !== side) continue;
      let a = acc.get(p.playerId);
      if (!a) {
        a = { xs: [], ys: [], dist: 0, touches: 0, lastX: null, lastY: null };
        acc.set(p.playerId, a);
      }
      a.xs.push(p.pos.x);
      a.ys.push(p.pos.y);
      if (a.lastX !== null && a.lastY !== null) a.dist += dist(p.pos.x, p.pos.y, a.lastX, a.lastY);
      a.lastX = p.pos.x;
      a.lastY = p.pos.y;
      if (s.ballOwner === p.playerId) a.touches += 1;
    }
  }
  const players: PlayerStat[] = [...acc.entries()]
    .map(([playerId, a]) => ({ playerId, avgX: mean(a.xs), avgY: mean(a.ys), distanceKm: a.dist / 1000, touches: a.touches }))
    .sort((x, y) => x.playerId.localeCompare(y.playerId, undefined, { numeric: true }));

  // 아웃필드(GK=최소 avgX 1명 제외) 기준 라인/폭.
  const gk = players.reduce((min, p) => (p.avgX < min.avgX ? p : min), players[0]!);
  const outfield = players.filter((p) => p.playerId !== gk.playerId);

  const ev = log.events.filter((e) => e.team === side);
  return {
    side,
    goals: ev.filter((e) => e.type === "goal").length,
    shots: ev.filter((e) => e.type === "shot").length,
    passes: ev.filter((e) => e.type === "pass").length,
    avgLineX: mean(outfield.map((p) => p.avgX)),
    widthSpreadM: stdev(outfield.map((p) => p.avgY)),
    players,
  };
}
