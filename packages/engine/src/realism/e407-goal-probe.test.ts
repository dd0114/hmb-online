import { describe, it } from "vitest";
import type { MatchLog, TeamSide, TickSnapshot } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeSelectData, makeTacticalInput } from "../fixtures";
import { GUARD_SEEDS, REALISM_SEEDS } from "./harness";
import { xgAtPoint } from "../decision";
import { createPitch } from "../pitch";
import { reconstructTransfers, type Transfer } from "./deepen";
import { applyConfigOverrides } from "./config-override";

/**
 * #407 ⑨ "골 중앙 편중 / 단조로움" **분석 전용 프로브**(env 가드, 구현 변경 0).
 *
 * 실행: node tools/run-gate.mjs --label e407-goal -- npx vitest run \
 *         packages/engine/src/realism/e407-goal-probe.test.ts
 *   (기본 env `HMB_E407GOAL` 없으면 skip → `npm test` 무영향)
 *
 * 측정 대상
 *  A. 득점자 분포(슬롯/포지션) · 슛 위치 y 분포 · 골 히트맵 · 득점 경로 · 어시스트 출발점
 *  B. 원인 귀속용 아블레이션(프로덕션 config 무수정 — `config-override` 로 런타임 주입)
 *
 * ⚠️ 이 파일은 **읽기 전용 계측**이다. 엔진 로직을 부르되 바꾸지 않는다.
 */

const ENV = (process as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const GEN = ENV.HMB_E407GOAL;
const SEEDS = ENV.HMB_E407_SEEDS
  ? REALISM_SEEDS.slice(0, Number(ENV.HMB_E407_SEEDS))
  : ENV.HMB_E407_GUARD
    ? GUARD_SEEDS
    : REALISM_SEEDS;
const ARMS = (ENV.HMB_E407_ARMS ?? "base").split(",").map((s) => s.trim()).filter(Boolean);

const ROLE_BY_INDEX = ["GK", "LB", "LCB", "RCB", "RB", "LCM", "CM", "RCM", "LW", "ST", "RW"];
const LINE_BY_ROLE: Record<string, string> = {
  GK: "GK", LB: "DF", LCB: "DF", RCB: "DF", RB: "DF",
  LCM: "MF", CM: "MF", RCM: "MF", LW: "FW", ST: "FW", RW: "FW",
};
function roleOf(id: string): string {
  const n = Number(id.slice(1));
  return ROLE_BY_INDEX[n] ?? "?";
}
function prog(side: TeamSide, x: number, W: number): number {
  return side === "home" ? x : W - x;
}

/** 5레인 라벨(중앙 / 하프스페이스 / 와이드) — 피치 폭 H 를 5등분. */
function laneOf(y: number, H: number): "central" | "halfspace" | "wide" {
  const lat = Math.abs(y - H / 2);
  const lane = H / 5;
  if (lat <= lane / 2) return "central";
  if (lat <= lane * 1.5) return "halfspace";
  return "wide";
}

interface GoalRow {
  side: TeamSide;
  scorerId: string;
  scorerRole: string;
  scorerLine: string;
  shotTick: number;
  /** 슛 출발점(실좌표). */
  sx: number;
  sy: number;
  /** 골까지 거리(m) · 횡오프셋(m). */
  distM: number;
  latM: number;
  lane: "central" | "halfspace" | "wide";
  route: string;
  /** 어시스트(마지막 완결 패스) 출발점. 없으면 null. */
  assistRelX: number | null;
  assistRelY: number | null;
  assistLatM: number | null;
  assistRole: string | null;
  assistDistM: number | null;
}

interface ShotRow {
  side: TeamSide;
  shooterId: string;
  role: string;
  line: string;
  distM: number;
  latM: number;
  lane: "central" | "halfspace" | "wide";
  goal: boolean;
}

interface MatchRows {
  goals: GoalRow[];
  shots: ShotRow[];
  /** 팀별: 상대 박스 안 수신 수(역할별). */
  boxRecvByRole: Record<string, number>;
  /** 팀별: 와이드 채널 수신 수(역할별). */
  wideRecvByRole: Record<string, number>;
  /** 팀별: 파이널서드 와이드에서 출발한 완결 패스 수(= 측면 전달 시도). */
  wideFinalReleases: number;
  /** 그중 박스로 들어간 것(= 크로스). */
  crosses: number;
  cutbacks: number;
  teamMatches: number;
  /** 역할별 위치 표본(자기 팀 소유 틱, 5틱마다) — 앵커 당김의 직접 관찰량. */
  posByRole: Record<string, { n: number; latSum: number; latSq: number; progSum: number; maxLat: number; dySum: number }>;
}

const RESTART_DETAILS = new Set(["corner", "throw_in", "goal_kick"]);

function analyze(log: MatchLog, config: EngineConfig): MatchRows {
  const W = config.pitch.width;
  const H = config.pitch.height;
  const boxHalfW = config.rules.penalty.boxHalfWidthM;
  const boxDepth = config.rules.penalty.boxDepthM;
  const finalLine = config.setPiece.finalThirdLine;
  const byTick = new Map<number, TickSnapshot>();
  for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);
  const transfers = reconstructTransfers(log, W);

  const shots: ShotRow[] = [];
  const goals: GoalRow[] = [];
  const boxRecvByRole: Record<string, number> = {};
  const wideRecvByRole: Record<string, number> = {};
  let wideFinalReleases = 0;
  let crosses = 0;
  let cutbacks = 0;

  // --- 슛 출발점 ---
  const shotEvents = log.events.filter(
    (e) => e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target",
  );
  const goalEvents = log.events.filter((e) => e.type === "goal");
  const goalTicks = new Set(goalEvents.map((e) => e.tick));

  for (const e of shotEvents) {
    const sn = byTick.get(e.tick);
    if (!sn || !e.team || !e.playerId) continue;
    const d = W - prog(e.team, sn.ball.x, W);
    const lat = Math.abs(sn.ball.y - H / 2);
    // 이 슛이 골이 됐나: 이후 12틱 안 같은 팀 goal 이벤트.
    const scored = goalEvents.some((g) => g.team === e.team && g.tick >= e.tick && g.tick - e.tick <= 12);
    shots.push({
      side: e.team,
      shooterId: e.playerId,
      role: roleOf(e.playerId),
      line: LINE_BY_ROLE[roleOf(e.playerId)] ?? "?",
      distM: d,
      latM: lat,
      lane: laneOf(sn.ball.y, H),
      goal: scored,
    });
  }
  void goalTicks;

  // --- 골 경로 ---
  for (const ge of goalEvents) {
    if (!ge.team) continue;
    const T = ge.team;
    // 그 골을 만든 슛 발사 이벤트 = 골 틱 이전 가장 가까운 같은 팀 shot(결과마커 제외).
    let shotEv = null as (typeof shotEvents)[number] | null;
    for (const e of shotEvents) {
      if (e.team !== T || e.tick > ge.tick) continue;
      if (!shotEv || e.tick > shotEv.tick) shotEv = e;
    }
    if (!shotEv) continue;
    const sn = byTick.get(shotEv.tick);
    if (!sn) continue;
    const shooterId = shotEv.playerId ?? ge.playerId ?? "?";
    const shotTick = shotEv.tick;

    // 시퀀스 시작 = max(마지막 우리 팀 재시작, 마지막 소유 획득).
    let lastRestartTick = -1;
    let restartKind = "";
    for (const e of log.events) {
      if (e.tick > shotTick || e.team !== T) continue;
      const kind =
        e.type === "kickoff" ? (e.detail && RESTART_DETAILS.has(e.detail) ? e.detail : "kickoff")
          : e.type === "free_kick" ? "free_kick"
            : e.type === "penalty" ? "penalty"
              : null;
      if (kind && e.tick >= lastRestartTick) {
        lastRestartTick = e.tick;
        restartKind = kind;
      }
    }
    let lastGainTick = -1;
    for (const t of transfers) {
      if (t.recvTick > shotTick) continue;
      if (t.toSide === T && t.fromSide !== T && t.recvTick > lastGainTick) lastGainTick = t.recvTick;
    }
    const seqStart = Math.max(lastRestartTick, lastGainTick, 0);
    const fromRestart = lastRestartTick >= lastGainTick && lastRestartTick >= 0;

    // 시퀀스 안 우리 팀 완결 패스.
    const seqPasses = transfers.filter(
      (t) => t.fromSide === T && t.completed && t.releaseTick >= seqStart && t.recvTick <= shotTick,
    );
    // 어시스트 = 슈터에게 도착한 마지막 완결 패스.
    let assist: Transfer | null = null;
    for (const t of seqPasses) {
      if (t.toId === shooterId && (!assist || t.recvTick > assist.recvTick)) assist = t;
    }

    // 분류(우선순위).
    let route: string;
    if (shotEv.detail === "penalty") {
      route = "penalty";
    } else if (fromRestart && restartKind === "corner" && seqPasses.length <= 1) {
      route = "setpiece_corner";
    } else if (fromRestart && restartKind === "free_kick" && seqPasses.length <= 1) {
      route = "setpiece_freekick";
    } else if (fromRestart && (restartKind === "throw_in" || restartKind === "goal_kick") && seqPasses.length <= 1) {
      route = `restart_${restartKind}`;
    } else if (!assist) {
      route = "solo_carry"; // 슈터가 시퀀스 시작부터 공을 지님(드리블/직접 회수)
    } else {
      const relLat = Math.abs(assist.relY - H / 2);
      const relProg = prog(assist.fromSide, assist.relX, W) / W;
      const recvInBox =
        prog(assist.fromSide, assist.recvX, W) >= W - boxDepth &&
        Math.abs(assist.recvY - H / 2) <= boxHalfW;
      const wideRel = relLat > boxHalfW;
      if (wideRel && relProg >= finalLine && recvInBox) {
        route = assist.fwdM < 0 ? "cutback" : "cross";
      } else if (assist.distM >= 30) {
        route = "long_ball";
      } else if (assist.inBehind) {
        route = "through_ball";
      } else if (wideRel) {
        route = "wide_pass_other";
      } else {
        route = laneOf(assist.relY, H) === "halfspace" ? "halfspace_pass" : "central_pass";
      }
    }

    goals.push({
      side: T,
      scorerId: shooterId,
      scorerRole: roleOf(shooterId),
      scorerLine: LINE_BY_ROLE[roleOf(shooterId)] ?? "?",
      shotTick,
      sx: sn.ball.x,
      sy: sn.ball.y,
      distM: W - prog(T, sn.ball.x, W),
      latM: Math.abs(sn.ball.y - H / 2),
      lane: laneOf(sn.ball.y, H),
      route,
      assistRelX: assist ? assist.relX : null,
      assistRelY: assist ? assist.relY : null,
      assistLatM: assist ? Math.abs(assist.relY - H / 2) : null,
      assistRole: assist ? roleOf(assist.fromId) : null,
      assistDistM: assist ? assist.distM : null,
    });
  }

  // --- 수신 분포 / 크로스 존재 ---
  for (const t of transfers) {
    if (!t.completed) continue;
    const r = roleOf(t.toId);
    const recvBox =
      prog(t.fromSide, t.recvX, W) >= W - boxDepth && Math.abs(t.recvY - H / 2) <= boxHalfW;
    if (recvBox) boxRecvByRole[r] = (boxRecvByRole[r] ?? 0) + 1;
    if (Math.abs(t.recvY - H / 2) > boxHalfW) wideRecvByRole[r] = (wideRecvByRole[r] ?? 0) + 1;
    const relWide = Math.abs(t.relY - H / 2) > boxHalfW;
    const relFinal = prog(t.fromSide, t.relX, W) / W >= finalLine;
    if (relWide && relFinal) {
      wideFinalReleases++;
      if (recvBox) {
        crosses++;
        if (prog(t.fromSide, t.relX, W) >= W - boxDepth * 0.6 && t.fwdM < 0) cutbacks++;
      }
    }
  }

  // --- 역할별 위치(자기 팀이 공을 가진 틱, 5틱 간격) ---
  const posByRole: MatchRows["posByRole"] = {};
  for (const sn of log.tickSnapshots) {
    if (sn.tick % 5 !== 0) continue;
    const owner = sn.ballOwner;
    if (!owner) continue;
    const ownerSide = sn.players.find((p) => p.playerId === owner)?.team;
    if (!ownerSide) continue;
    for (const p of sn.players) {
      if (p.team !== ownerSide) continue;
      const r = roleOf(p.playerId);
      if (r === "GK") continue;
      const lat = Math.abs(p.pos.y - H / 2);
      const pr = prog(p.team, p.pos.x, W) / W;
      const acc = (posByRole[r] ??= { n: 0, latSum: 0, latSq: 0, progSum: 0, maxLat: 0, dySum: 0 });
      // 공격 방향 기준 부호 y(좌/우 통일): home 은 +y 가 좌, away 는 −y 가 좌.
      acc.dySum += p.team === "home" ? p.pos.y - H / 2 : H / 2 - p.pos.y;
      acc.n++;
      acc.latSum += lat;
      acc.latSq += lat * lat;
      acc.progSum += pr;
      if (lat > acc.maxLat) acc.maxLat = lat;
    }
  }

  return { goals, shots, boxRecvByRole, wideRecvByRole, wideFinalReleases, crosses, cutbacks, teamMatches: 2, posByRole };
}

interface ArmResult {
  label: string;
  matches: number;
  goals: GoalRow[];
  shots: ShotRow[];
  boxRecvByRole: Record<string, number>;
  wideRecvByRole: Record<string, number>;
  wideFinalReleases: number;
  crosses: number;
  cutbacks: number;
  lastHash: string;
  scoreGoals: number;
  posByRole: MatchRows["posByRole"];
}

interface Arm {
  label: string;
  overrides?: Record<string, unknown>;
  /** 전술 입력(프롬프트 축) 변형. */
  tactics?: (t: ReturnType<typeof makeTacticalInput>) => ReturnType<typeof makeTacticalInput>;
}

const ARM_DEFS: Record<string, Arm> = {
  base: { label: "base (출하 config)" },
  // ── 프롬프트 축: 유저가 "측면 활용해 / 넓게 벌려라" 를 최대로 썼을 때 ──
  widthMax: {
    label: "widthMax (team.width=1 · widthTendency=1 · 프롬프트 축 최대)",
    tactics: (t) => ({
      ...t,
      team: { ...t.team, width: 1 },
      players: t.players.map((p) =>
        p.role === "GK" ? p : { ...p, behavior: { ...p.behavior, widthTendency: 1 } },
      ),
    }),
  },
  // ── 구조 축 ──
  angle: { label: "angle (contest.shootAngleFactor 0.85→0.35)", overrides: { "contest.shootAngleFactor": 0.35 } },
  widthReach: { label: "widthReach (movement.attackWidthReach 0.10→0.25)", overrides: { "movement.attackWidthReach": 0.25 } },
  anchorOff: {
    label: "anchorOff (forwardRunReach 0.275→0.5 · roamNoiseAmp↑ · 앵커 완화)",
    overrides: { "movement.forwardRunReach": 0.5, "variety.roamNoiseAmp": 6 },
  },
  space: { label: "space (chain.spaceWeight 0.35→2.0 · spaceRefM 12→20)", overrides: { "chain.spaceWeight": 2.0, "chain.spaceRefM": 20 } },
  wingerRun: {
    label: "wingerRun (윙어 forwardRunFreq/shootTendency=1.0 · ST 0.3/0.2 — 프롬프트로 득점자 바꾸기)",
    tactics: (t) => ({
      ...t,
      players: t.players.map((p) =>
        p.role === "LW" || p.role === "RW"
          ? { ...p, behavior: { ...p.behavior, forwardRunFreq: 1.0, shootTendency: 1.0 } }
          : p.role === "ST"
            ? { ...p, behavior: { ...p.behavior, forwardRunFreq: 0.3, shootTendency: 0.2 } }
            : p,
      ),
    }),
  },
  combo: {
    label: "combo (angle 0.35 + widthReach 0.25 + widthMax)",
    overrides: { "contest.shootAngleFactor": 0.35, "movement.attackWidthReach": 0.25 },
    tactics: (t) => ({
      ...t,
      team: { ...t.team, width: 1 },
      players: t.players.map((p) =>
        p.role === "GK" ? p : { ...p, behavior: { ...p.behavior, widthTendency: 1 } },
      ),
    }),
  },
};

function runArm(name: string): ArmResult {
  const def = ARM_DEFS[name];
  if (!def) throw new Error(`unknown arm: ${name}`);
  const config = def.overrides ? applyConfigOverrides(defaultEngineConfig, def.overrides) : defaultEngineConfig;
  const select = makeSelectData();
  const acc: ArmResult = {
    label: def.label,
    matches: 0,
    goals: [],
    shots: [],
    boxRecvByRole: {},
    wideRecvByRole: {},
    wideFinalReleases: 0,
    crosses: 0,
    cutbacks: 0,
    lastHash: "",
    scoreGoals: 0,
    posByRole: {},
  };
  for (const seed of SEEDS) {
    let home = makeTacticalInput("H", seed);
    let away = makeTacticalInput("A", seed);
    if (def.tactics) {
      home = def.tactics(home);
      away = def.tactics(away);
    }
    const log = runMatch(seed, home, away, select, config);
    const r = analyze(log, config);
    acc.matches++;
    acc.goals.push(...r.goals);
    acc.shots.push(...r.shots);
    for (const [k, v] of Object.entries(r.boxRecvByRole)) acc.boxRecvByRole[k] = (acc.boxRecvByRole[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.wideRecvByRole)) acc.wideRecvByRole[k] = (acc.wideRecvByRole[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.posByRole)) {
      const a2 = (acc.posByRole[k] ??= { n: 0, latSum: 0, latSq: 0, progSum: 0, maxLat: 0, dySum: 0 });
      a2.dySum += v.dySum;
      a2.n += v.n;
      a2.latSum += v.latSum;
      a2.latSq += v.latSq;
      a2.progSum += v.progSum;
      if (v.maxLat > a2.maxLat) a2.maxLat = v.maxLat;
    }
    acc.wideFinalReleases += r.wideFinalReleases;
    acc.crosses += r.crosses;
    acc.cutbacks += r.cutbacks;
    acc.lastHash = log.tickSnapshots[log.tickSnapshots.length - 1]?.hash ?? acc.lastHash;
    acc.scoreGoals += log.finalScore.home + log.finalScore.away;
  }
  return acc;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
}
function f(v: number, d = 2): string {
  return (Math.round(v * 10 ** d) / 10 ** d).toString();
}
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i]!;
}

function report(a: ArmResult): string {
  const L: string[] = [];
  const teamMatches = a.matches * 2;
  L.push(`## ARM: ${a.label}`);
  L.push(`- 시드 ${a.matches} · 팀-경기 ${teamMatches} · lastHash \`${a.lastHash}\``);
  L.push(`- 골 총 ${a.goals.length} (경기당 ${f(a.goals.length / a.matches)}) · finalScore 합계 ${a.scoreGoals} (경기당 ${f(a.scoreGoals / a.matches)}) · 슛 총 ${a.shots.length} (팀-경기당 ${f(a.shots.length / teamMatches)})`);
  L.push("");

  // 득점자 분포
  L.push(`### 득점자 분포 (슬롯/역할)`);
  L.push(`| 역할 | 골 | 골% | 슛 | 슛% | 슛→골 |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const r of ROLE_BY_INDEX) {
    const g = a.goals.filter((x) => x.scorerRole === r).length;
    const s = a.shots.filter((x) => x.role === r).length;
    if (g === 0 && s === 0) continue;
    L.push(`| ${r} (${LINE_BY_ROLE[r]}) | ${g} | ${pct(g, a.goals.length)} | ${s} | ${pct(s, a.shots.length)} | ${pct(g, s)} |`);
  }
  L.push("");
  L.push(`| 라인 | 골 | 골% | 슛% |`);
  L.push(`|---|---|---|---|`);
  for (const ln of ["GK", "DF", "MF", "FW"]) {
    const g = a.goals.filter((x) => x.scorerLine === ln).length;
    const s = a.shots.filter((x) => x.line === ln).length;
    L.push(`| ${ln} | ${g} | ${pct(g, a.goals.length)} | ${pct(s, a.shots.length)} |`);
  }
  L.push("");

  // 슛/골 레인 분포
  L.push(`### 슛·골 출발 레인 (5레인: 중앙 ≤6.8m · 하프스페이스 6.8~20.4m · 와이드 >20.4m)`);
  L.push(`| 레인 | 슛 | 슛% | 골 | 골% |`);
  L.push(`|---|---|---|---|---|`);
  for (const ln of ["central", "halfspace", "wide"] as const) {
    const s = a.shots.filter((x) => x.lane === ln).length;
    const g = a.goals.filter((x) => x.lane === ln).length;
    L.push(`| ${ln} | ${s} | ${pct(s, a.shots.length)} | ${g} | ${pct(g, a.goals.length)} |`);
  }
  const lat = a.shots.map((s) => s.latM).sort((x, y) => x - y);
  const glat = a.goals.map((s) => s.latM).sort((x, y) => x - y);
  L.push("");
  L.push(`- 슛 횡오프셋 p50/p90/max = ${f(quantile(lat, 0.5))} / ${f(quantile(lat, 0.9))} / ${f(lat[lat.length - 1] ?? 0)} m`);
  L.push(`- 골 횡오프셋 p50/p90/max = ${f(quantile(glat, 0.5))} / ${f(quantile(glat, 0.9))} / ${f(glat[glat.length - 1] ?? 0)} m`);
  L.push("");

  // 히트맵
  L.push(`### 골이 된 슛의 히트맵 (행=골까지 거리 m · 열=횡오프셋 m, 부호 = y−34)`);
  const xBands = [[0, 6], [6, 11], [11, 16], [16, 22], [22, 999]];
  const yBands = [[-999, -20.16], [-20.16, -9.16], [-9.16, -3.66], [-3.66, 3.66], [3.66, 9.16], [9.16, 20.16], [20.16, 999]];
  L.push(`| dist \\ y | ${yBands.map(([lo, hi]) => `${lo === -999 ? "≤-20" : hi === 999 ? "≥20" : `${lo}~${hi}`}`).join(" | ")} |`);
  L.push(`|---|${yBands.map(() => "---").join("|")}|`);
  for (const [xlo, xhi] of xBands) {
    const cells = yBands.map(([ylo, yhi]) => {
      return a.goals.filter((g) => {
        const dy = g.side === "home" ? g.sy - 34 : 34 - g.sy; // 공격 방향 기준 좌우 통일
        return g.distM >= xlo! && g.distM < xhi! && dy >= ylo! && dy < yhi!;
      }).length;
    });
    L.push(`| ${xlo}~${xhi === 999 ? "∞" : xhi} | ${cells.join(" | ")} |`);
  }
  L.push("");

  // 득점 경로
  L.push(`### 득점 경로`);
  L.push(`| 경로 | 골 | 비율 |`);
  L.push(`|---|---|---|`);
  const routes = new Map<string, number>();
  for (const g of a.goals) routes.set(g.route, (routes.get(g.route) ?? 0) + 1);
  for (const [k, v] of [...routes.entries()].sort((x, y) => y[1] - x[1])) {
    L.push(`| ${k} | ${v} | ${pct(v, a.goals.length)} |`);
  }
  L.push("");

  // 경로 × 어시스트 출발 레인 교차표
  L.push(`### 경로 × 어시스트 출발 레인 (교차표)`);
  L.push(`| 경로 | central | halfspace | wide | 무어시스트 |`);
  L.push(`|---|---|---|---|---|`);
  for (const [k] of [...routes.entries()].sort((x, y) => y[1] - x[1])) {
    const rows = a.goals.filter((g) => g.route === k);
    const c = rows.filter((g) => g.assistLatM != null && g.assistLatM <= 6.8).length;
    const h = rows.filter((g) => g.assistLatM != null && g.assistLatM > 6.8 && g.assistLatM <= 20.4).length;
    const w = rows.filter((g) => g.assistLatM != null && g.assistLatM > 20.4).length;
    const n = rows.filter((g) => g.assistLatM == null).length;
    L.push(`| ${k} | ${c} | ${h} | ${w} | ${n} |`);
  }
  L.push("");

  // 슛 거리 분포
  const sdist = a.shots.map((s) => s.distM).sort((x, y) => x - y);
  const gdist = a.goals.map((s) => s.distM).sort((x, y) => x - y);
  L.push(`- 슛 거리 p10/p50/p90 = ${f(quantile(sdist, 0.1))} / ${f(quantile(sdist, 0.5))} / ${f(quantile(sdist, 0.9))} m · 골 거리 p50 = ${f(quantile(gdist, 0.5))} m`);
  L.push("");

  // 역할별 위치(앵커 관찰량)
  L.push(`### 자기 팀 소유 중 역할별 위치 (5틱 샘플 · 앵커 당김의 직접 관찰량)`);
  L.push(`| 역할 | 평균 \\|y−34\\| | SD | 최대 | **공격프레임 평균 부호 y** | 평균 진행도 | base y 오프셋 |`);
  L.push(`|---|---|---|---|---|---|---|`);
  const slots = defaultEngineConfig.formations["4-3-3"]!;
  for (let i = 1; i < ROLE_BY_INDEX.length; i++) {
    const r = ROLE_BY_INDEX[i]!;
    const v = a.posByRole[r];
    if (!v || v.n === 0) continue;
    const mu = v.latSum / v.n;
    const sd = Math.sqrt(Math.max(0, v.latSq / v.n - mu * mu));
    const baseLat = Math.abs(slots[i]!.y * defaultEngineConfig.pitch.height - defaultEngineConfig.pitch.height / 2);
    L.push(`| ${r} | ${f(mu)} | ${f(sd)} | ${f(v.maxLat)} | ${f(v.dySum / v.n)} | ${f(v.progSum / v.n)} | ${f(baseLat)} |`);
  }
  L.push("");

  // 어시스트 출발점
  const withAssist = a.goals.filter((g) => g.assistLatM != null);
  L.push(`### 어시스트(골로 이어진 마지막 패스) 출발점`);
  L.push(`- 어시스트가 있는 골 ${withAssist.length}/${a.goals.length} (${pct(withAssist.length, a.goals.length)})`);
  const alat = withAssist.map((g) => g.assistLatM!).sort((x, y) => x - y);
  L.push(`- 어시스트 출발 횡오프셋 p50/p90/max = ${f(quantile(alat, 0.5))} / ${f(quantile(alat, 0.9))} / ${f(alat[alat.length - 1] ?? 0)} m`);
  const wideAssist = withAssist.filter((g) => g.assistLatM! > 20.16).length;
  const hsAssist = withAssist.filter((g) => g.assistLatM! > 6.8 && g.assistLatM! <= 20.4).length;
  L.push(`- 와이드(>20.16m = 박스 반폭 밖) 출발 = ${wideAssist} (${pct(wideAssist, withAssist.length)}) · 하프스페이스 = ${hsAssist} (${pct(hsAssist, withAssist.length)})`);
  L.push(`- 어시스트 제공자 역할: ${[...new Set(withAssist.map((g) => g.assistRole))]
    .map((r) => `${r}=${withAssist.filter((g) => g.assistRole === r).length}`)
    .join(" · ")}`);
  L.push("");

  // 측면 활용 총량
  L.push(`### 측면 활용 총량 (팀-경기당)`);
  L.push(`- 파이널서드 **와이드 출발** 완결 패스 = ${f(a.wideFinalReleases / teamMatches)}`);
  L.push(`- 그중 박스로 들어간 것(= **크로스**) = ${f(a.crosses / teamMatches)} · 컷백 = ${f(a.cutbacks / teamMatches)}`);
  L.push(`- 박스 안 수신(역할별, 팀-경기당): ${ROLE_BY_INDEX.filter((r) => a.boxRecvByRole[r])
    .map((r) => `${r}=${f((a.boxRecvByRole[r] ?? 0) / teamMatches)}`)
    .join(" · ")}`);
  L.push(`- 와이드 수신(역할별, 팀-경기당): ${ROLE_BY_INDEX.filter((r) => a.wideRecvByRole[r])
    .map((r) => `${r}=${f((a.wideRecvByRole[r] ?? 0) / teamMatches)}`)
    .join(" · ")}`);
  L.push("");
  return L.join("\n");
}

/**
 * 사슬 상태가치 V 의 **좌표 전용 항**(= advance + threat) 지형.
 * V = advanceWeight·진행도^advanceExponent + threatWeight·xG(좌표) + spaceWeight·여유공간
 * 여유공간 항만 선수 배치에 의존하므로 여기서는 뺀다(그 항은 상대 위치의 함수라 y 편향이 없다).
 * 이 표가 "값 지형이 어디를 가리키나"의 직접 증거다 — 재구현이 아니라 `xgAtPoint` 그대로 호출.
 */
function valueLandscape(): string {
  const c = defaultEngineConfig;
  const pitch = createPitch(c);
  const W = c.pitch.width;
  const H = c.pitch.height;
  const scale = c.fixedScale;
  const L: string[] = [];
  L.push(`## 사슬 상태가치 V 의 좌표 전용 항 (advance + threat) — y 에 따른 지형`);
  L.push(`- advanceWeight=${c.chain.advanceWeight} · advanceExponent=${c.chain.advanceExponent} · threatWeight=${c.chain.threatWeight} · spaceWeight=${c.chain.spaceWeight}(좌표 무관) · shootAngleFactor=${c.contest.shootAngleFactor}`);
  const ys = [0, 5, 10, 15, 20, 25, 30];
  L.push(`| x(자기골에서 m) | ${ys.map((y) => `\\|y−34\\|=${y}`).join(" | ")} |`);
  L.push(`|---|${ys.map(() => "---").join("|")}|`);
  for (const x of [70, 80, 88, 95, 100]) {
    const cells = ys.map((dy) => {
      const yFx = Math.round((H / 2 + dy) * scale);
      const xFx = Math.round(x * scale);
      const { xg } = xgAtPoint("home", xFx, yFx, 82, 0, c, pitch);
      const adv = Math.pow(x / W, c.chain.advanceExponent) * c.chain.advanceWeight;
      const thr = c.chain.threatWeight * xg;
      return `${f(adv + thr, 3)}`;
    });
    L.push(`| ${x} | ${cells.join(" | ")} |`);
  }
  return L.join("\n");
}

describe.skipIf(!GEN)("#407 ⑨ 골 중앙 편중 프로브", () => {
  it(
    "arms",
    () => {
      const out: string[] = [];
      out.push(`<!-- e407-goal-probe · ${defaultEngineConfig.version} · seeds=${SEEDS.length} · arms=${ARMS.join(",")} -->`);
      out.push(valueLandscape());
      out.push("");
      for (const name of ARMS) {
        const t0 = Date.now();
        const r = runArm(name);
        out.push(report(r));
        out.push(`> arm 실행 ${Date.now() - t0}ms`);
        out.push("");
      }
      const text = out.join("\n");
      // eslint-disable-next-line no-console
      console.log(text);
    },
    60 * 60 * 1000,
  );
});
