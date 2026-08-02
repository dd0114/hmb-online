/**
 * #407 Phase 2-B — **다양성 지표 + 볼륨 조합 탐색기**. 분석 전용, 프로덕션 무수정.
 *
 * Phase 2-A(볼륨 재보정)의 3안이 전부 `contest.shootRange` 하드 게이트에 의존해 기각됐다
 * (chain.ts:344 = `distToGoalM > shootRange` 면 슛 후보 자체가 안 생김 → 박스 밖 슛 소멸).
 * 이 프로브는 **거리 게이트 없이** 볼륨을 내리는 조합을 찾기 위해, 볼륨/구조 지표와
 * **다양성 지표 2축**을 한 번의 시뮬로 같이 잰다.
 *
 *  축 A — 거리/위치 다양성: 박스 안 슛 비중 · 슛 거리 사분위 · 5레인 분포(와이드 슛)
 *  축 B — 선수 다양성: 역할별 슛/골 점유(top1·top2·HHI) · 박스 안 수신 분포 ·
 *                      팀-경기당 슛한 선수 수 / 득점한 선수 수
 *
 * ⚠️ 지표 정의는 `research/e407-goal-centrality.md` 와 **자[尺]를 맞췄다**:
 *  - 슛 = `type==="shot" && detail∉{saved,off_target}` (발사 이벤트만), 위치 = 그 틱의 공 좌표
 *  - 레인 = 피치 폭 5등분 (중앙 ≤6.8m · 하프스페이스 ≤20.4m · 와이드 >20.4m)
 *  - 골 귀속 = 골 이벤트 직전 같은 팀 슛 이벤트(≤12틱)
 *  - 박스 안 수신 = `reconstructTransfers`(deepen.ts) 완결 패스의 도착점이 상대 박스 안
 *  - 역할 = playerId 숫자 인덱스 → 4-3-3 슬롯(GK,LB,LCB,RCB,RB,LCM,CM,RCM,LW,ST,RW)
 *
 * 실행:
 *   HMB_SEEDS=20 node tools/run-gate.mjs --label e407-div -- \
 *     npx tsx research/e407-probe/e407-diversity.ts
 *   HMB_COMBOS='[{"label":"x","ov":{"chain.discount":0.99}}]' HMB_SEEDS=20 \
 *     node tools/run-gate.mjs --label e407-div -- npx tsx research/e407-probe/e407-diversity.ts
 * 환경변수: HMB_SEEDS(기본 20) · HMB_COMBOS(JSON) · HMB_WIDE=1(전체 지표 덤프)
 */
import type { MatchLog, TeamSide, TickSnapshot } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config";
import { applyConfigOverrides } from "../../packages/engine/src/realism/config-override";
import { REALISM_SEEDS, GUARD_SEEDS } from "../../packages/engine/src/realism/harness";
import { runMatch } from "../../packages/engine/src/match";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures";
import { reconstructTransfers } from "../../packages/engine/src/realism/deepen";
import { computeMatchStats } from "../../packages/engine/dev-viewer/match-stats";

const N = Number(process.env.HMB_SEEDS || 20);
const SEEDS = N > 20 ? GUARD_SEEDS.slice(0, N) : REALISM_SEEDS.slice(0, N);
const select = makeSelectData();
const GK_IDS = new Set(["H0", "A0"]);
const DEFENDER_IDS = new Set(["H1", "H2", "H3", "H4", "A1", "A2", "A3", "A4"]);

const ROLES = ["GK", "LB", "LCB", "RCB", "RB", "LCM", "CM", "RCM", "LW", "ST", "RW"];
const OUTFIELD = ROLES.slice(1);
function roleOf(id: string): string {
  return ROLES[Number(id.slice(1))] ?? "?";
}

export interface Div {
  // ── 볼륨/질 ──
  shots: number;
  goals: number;
  onTarget: number;
  onTargetPct: number;
  xgPerShot: number;
  convPct: number;
  // ── 축 A: 거리/위치 다양성 ──
  inBoxShotPct: number;
  shotDistMean: number;
  shotDistP25: number;
  shotDistP50: number;
  shotDistP75: number;
  centralShotPct: number;
  halfspaceShotPct: number;
  wideShotPct: number;
  shotLatP50: number;
  shotLatP90: number;
  // ── 축 B: 선수 다양성 ──
  /** 역할별 풀링 슛 점유의 최대(=ST 비중, %). */
  shotTop1Pct: number;
  shotTop2Pct: number;
  /** 역할별 풀링 골 점유의 최대(%). */
  goalTop1Pct: number;
  goalTop2Pct: number;
  /** HHI = Σ(역할 점유)² — 0.1(완전균등, 10명) ~ 1.0(1명 독점). */
  shotHHI: number;
  goalHHI: number;
  /** 팀-경기당 1회 이상 슛한 선수 수 / 1골 이상 넣은 선수 수. */
  shooters: number;
  scorers: number;
  /** 박스 안 수신(팀-경기당) 총량 · ST 몫(%) · HHI. */
  boxRecv: number;
  boxRecvSTPct: number;
  boxRecvHHI: number;
  // ── 계약/구조 ──
  oneOnOnePct: number;
  passSuccessPct: number;
  widthM: number;
  corners: number;
  throwIns: number;
  fouls: number;
  distanceKm: number;
  shotsPerF3: number;
}

function quant(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i]!;
}
function hhi(counts: Record<string, number>): number {
  const tot = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!tot) return 0;
  return Object.values(counts).reduce((a, b) => a + (b / tot) ** 2, 0);
}
function topShare(counts: Record<string, number>, k: number): number {
  const tot = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!tot) return 0;
  const v = Object.values(counts).sort((a, b) => b - a);
  return (v.slice(0, k).reduce((a, b) => a + b, 0) / tot) * 100;
}

interface Raw {
  teamMatches: number;
  shotRole: Record<string, number>;
  goalRole: Record<string, number>;
  boxRecvRole: Record<string, number>;
  shotDist: number[];
  shotLat: number[];
  inBox: number;
  central: number;
  halfspace: number;
  wide: number;
  shots: number;
  goalsAttr: number;
  oneOnOne: number;
  shootersSum: number;
  scorersSum: number;
  // computeMatchStats 집계(팀-경기 평균용 합계)
  s: { shots: number; goals: number; onTarget: number; onTargetPct: number; conv: number; pass: number; width: number; corners: number; throwIns: number; fouls: number; km: number };
  xgSum: number;
  f3: number;
}

const F3LINE = 0.66;

function scan(log: MatchLog, cfg: EngineConfig, raw: Raw): void {
  const W = cfg.pitch.width;
  const H = cfg.pitch.height;
  const boxDepth = cfg.rules.penalty.boxDepthM;
  const boxHalf = cfg.rules.penalty.boxHalfWidthM;
  const lane = H / 5;
  const prog = (side: TeamSide, x: number) => (side === "home" ? x : W - x);
  const byTick = new Map<number, TickSnapshot>();
  for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);

  const shotEvents = log.events.filter(
    (e) => e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target",
  );
  const goalEvents = log.events.filter((e) => e.type === "goal");

  const perTeamShooters: Record<string, Set<string>> = { home: new Set(), away: new Set() };
  const perTeamScorers: Record<string, Set<string>> = { home: new Set(), away: new Set() };

  for (const e of shotEvents) {
    const sn = byTick.get(e.tick);
    if (!sn || !e.team || !e.playerId) continue;
    const r = roleOf(e.playerId);
    raw.shots += 1;
    raw.shotRole[r] = (raw.shotRole[r] ?? 0) + 1;
    perTeamShooters[e.team]!.add(e.playerId);
    if (e.detail === "one_on_one") raw.oneOnOne += 1;
    raw.xgSum += e.xg ?? 0;
    const gx = e.team === "home" ? W : 0;
    const d = Math.hypot(sn.ball.x - gx, sn.ball.y - H / 2);
    const lat = Math.abs(sn.ball.y - H / 2);
    raw.shotDist.push(d);
    raw.shotLat.push(lat);
    if (Math.abs(sn.ball.x - gx) <= boxDepth && lat <= boxHalf) raw.inBox += 1;
    if (lat <= lane / 2) raw.central += 1;
    else if (lat <= lane * 1.5) raw.halfspace += 1;
    else raw.wide += 1;
  }

  // 골 귀속: 골 이벤트 직전 같은 팀 슛(≤12틱).
  for (const ge of goalEvents) {
    if (!ge.team) continue;
    let best: (typeof shotEvents)[number] | null = null;
    for (const e of shotEvents) {
      if (e.team !== ge.team || e.tick > ge.tick || ge.tick - e.tick > 12) continue;
      if (!best || e.tick > best.tick) best = e;
    }
    const pid = best?.playerId ?? ge.playerId;
    if (!pid) continue;
    const r = roleOf(pid);
    raw.goalRole[r] = (raw.goalRole[r] ?? 0) + 1;
    raw.goalsAttr += 1;
    perTeamScorers[ge.team]!.add(pid);
  }

  for (const s of ["home", "away"] as const) {
    raw.shootersSum += perTeamShooters[s]!.size;
    raw.scorersSum += perTeamScorers[s]!.size;
  }

  // 박스 안 수신(완결 패스 도착점).
  for (const t of reconstructTransfers(log, W)) {
    if (!t.completed) continue;
    if (prog(t.fromSide, t.recvX) >= W - boxDepth && Math.abs(t.recvY - H / 2) <= boxHalf) {
      const r = roleOf(t.toId);
      raw.boxRecvRole[r] = (raw.boxRecvRole[r] ?? 0) + 1;
    }
  }

  // 파이널서드 진입(볼륨 회계와 같은 정의: 공 진행도 ≥0.66 의 상승 에지).
  {
    let cur: TeamSide | null = null;
    let prevF3 = false;
    for (const sn of log.tickSnapshots) {
      const owner = sn.ballOwner;
      const side = owner ? (owner.startsWith("H") ? "home" : "away") : cur;
      if (side !== cur) {
        cur = side;
        prevF3 = false;
      }
      if (!cur) continue;
      const now = prog(cur, sn.ball.x) / W >= F3LINE;
      if (now && !prevF3) raw.f3 += 1;
      prevF3 = now;
    }
  }

  const st = computeMatchStats(log, GK_IDS, {
    defenderIds: DEFENDER_IDS,
    pitchWidthM: W,
    finalThirdLine: cfg.setPiece.finalThirdLine,
  });
  for (const t of [st.home, st.away]) {
    raw.s.shots += t.shots;
    raw.s.goals += t.goals;
    raw.s.onTarget += t.onTarget;
    raw.s.onTargetPct += t.shots ? (t.onTarget / t.shots) * 100 : 0;
    raw.s.conv += t.shots ? (t.goals / t.shots) * 100 : 0;
    raw.s.pass += t.passSuccessPct;
    raw.s.width += t.avgWidthM;
    raw.s.corners += t.corners;
    raw.s.throwIns += t.throwIns;
    raw.s.fouls += t.fouls;
    raw.s.km += t.avgDistanceKm;
  }
  raw.teamMatches += 2;
}

/** 마지막 `runDiv` 의 원시 카운트(역할 덤프용). */
export let lastRaw: Raw | null = null;

export function runDiv(ov: Record<string, unknown>, seeds: string[] = SEEDS): Div {
  const cfg = Object.keys(ov).length ? applyConfigOverrides(defaultEngineConfig, ov) : defaultEngineConfig;
  const raw: Raw = {
    teamMatches: 0, shotRole: {}, goalRole: {}, boxRecvRole: {},
    shotDist: [], shotLat: [], inBox: 0, central: 0, halfspace: 0, wide: 0,
    shots: 0, goalsAttr: 0, oneOnOne: 0, shootersSum: 0, scorersSum: 0,
    s: { shots: 0, goals: 0, onTarget: 0, onTargetPct: 0, conv: 0, pass: 0, width: 0, corners: 0, throwIns: 0, fouls: 0, km: 0 },
    xgSum: 0, f3: 0,
  };
  for (const seed of seeds) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
    scan(log, cfg, raw);
  }
  lastRaw = raw;
  const tm = raw.teamMatches || 1;
  const ns = raw.shots || 1;
  const sd = [...raw.shotDist].sort((a, b) => a - b);
  const sl = [...raw.shotLat].sort((a, b) => a - b);
  // 역할 점유는 아웃필드 10 슬롯 기준(GK 제외 — 실측상 0).
  const sr: Record<string, number> = {};
  const gr: Record<string, number> = {};
  const br: Record<string, number> = {};
  for (const r of OUTFIELD) {
    sr[r] = raw.shotRole[r] ?? 0;
    gr[r] = raw.goalRole[r] ?? 0;
    br[r] = raw.boxRecvRole[r] ?? 0;
  }
  const boxTot = Object.values(br).reduce((a, b) => a + b, 0);
  return {
    shots: raw.s.shots / tm,
    goals: raw.s.goals / tm,
    onTarget: raw.s.onTarget / tm,
    onTargetPct: raw.s.onTargetPct / tm,
    xgPerShot: raw.xgSum / ns,
    convPct: raw.s.conv / tm,
    inBoxShotPct: (raw.inBox / ns) * 100,
    shotDistMean: sd.reduce((a, b) => a + b, 0) / ns,
    shotDistP25: quant(sd, 0.25),
    shotDistP50: quant(sd, 0.5),
    shotDistP75: quant(sd, 0.75),
    centralShotPct: (raw.central / ns) * 100,
    halfspaceShotPct: (raw.halfspace / ns) * 100,
    wideShotPct: (raw.wide / ns) * 100,
    shotLatP50: quant(sl, 0.5),
    shotLatP90: quant(sl, 0.9),
    shotTop1Pct: topShare(sr, 1),
    shotTop2Pct: topShare(sr, 2),
    goalTop1Pct: topShare(gr, 1),
    goalTop2Pct: topShare(gr, 2),
    shotHHI: hhi(sr),
    goalHHI: hhi(gr),
    shooters: raw.shootersSum / tm,
    scorers: raw.scorersSum / tm,
    boxRecv: boxTot / tm,
    boxRecvSTPct: boxTot ? ((br.ST ?? 0) / boxTot) * 100 : 0,
    boxRecvHHI: hhi(br),
    oneOnOnePct: (raw.oneOnOne / ns) * 100,
    passSuccessPct: raw.s.pass / tm,
    widthM: raw.s.width / tm,
    corners: raw.s.corners / tm,
    throwIns: raw.s.throwIns / tm,
    fouls: raw.s.fouls / tm,
    distanceKm: raw.s.km / tm,
    shotsPerF3: raw.f3 ? raw.s.shots / raw.f3 : 0,
  };
}

/** 역할별 상세 덤프(HMB_WIDE=1). `runDiv` 가 남긴 raw 를 재사용한다(재시뮬 없음). */
export function roleDump(raw: Raw): string {
  const tm = raw.teamMatches || 1;
  const L: string[] = [];
  L.push("역할".padEnd(6) + "슛".padStart(8) + "슛%".padStart(8) + "골".padStart(7) + "골%".padStart(8) + "박스수신/tm".padStart(13) + "박스%".padStart(8));
  const st = Object.values(raw.shotRole).reduce((a, b) => a + b, 0) || 1;
  const gt = Object.values(raw.goalRole).reduce((a, b) => a + b, 0) || 1;
  const bt = Object.values(raw.boxRecvRole).reduce((a, b) => a + b, 0) || 1;
  for (const r of OUTFIELD) {
    const s = raw.shotRole[r] ?? 0;
    const g = raw.goalRole[r] ?? 0;
    const b = raw.boxRecvRole[r] ?? 0;
    L.push(
      r.padEnd(6) + String(s).padStart(8) + ((s / st) * 100).toFixed(1).padStart(8) +
      String(g).padStart(7) + ((g / gt) * 100).toFixed(1).padStart(8) +
      (b / tm).toFixed(2).padStart(13) + ((b / bt) * 100).toFixed(1).padStart(8),
    );
  }
  return L.join("\n");
}

/* ── 출력 ─────────────────────────────────────────────────────────────────── */
const COLS: { k: keyof Div; d: number; label: string; band?: [number, number] }[] = [
  { k: "shots", d: 2, label: "슛", band: [7.2, 8.4] },
  { k: "goals", d: 2, label: "팀골", band: [1.4, 1.85] },
  { k: "onTarget", d: 2, label: "유효", band: [2.9, 3.5] },
  { k: "xgPerShot", d: 3, label: "xG/슛", band: [0.18, 0.24] },
  { k: "convPct", d: 1, label: "전환%", band: [17, 22] },
  { k: "inBoxShotPct", d: 1, label: "박스슛%" },
  { k: "shotDistP50", d: 1, label: "거리p50" },
  { k: "shotDistP25", d: 1, label: "p25" },
  { k: "shotDistP75", d: 1, label: "p75" },
  { k: "wideShotPct", d: 1, label: "와이드%" },
  { k: "shotTop1Pct", d: 1, label: "슛top1%" },
  { k: "goalTop1Pct", d: 1, label: "골top1%" },
  { k: "shotHHI", d: 3, label: "슛HHI" },
  { k: "shooters", d: 2, label: "슈터수" },
  { k: "scorers", d: 2, label: "득점자수" },
  { k: "boxRecv", d: 2, label: "박스수신" },
  { k: "boxRecvSTPct", d: 1, label: "박스ST%" },
  { k: "oneOnOnePct", d: 2, label: "1대1%" },
  { k: "passSuccessPct", d: 1, label: "패스%", band: [78, 85] },
  { k: "widthM", d: 1, label: "폭m", band: [40, 50] },
  { k: "corners", d: 2, label: "코너", band: [2.0, 3.0] },
  { k: "throwIns", d: 2, label: "스로인", band: [8.4, 9.4] },
  { k: "fouls", d: 2, label: "파울", band: [5.5, 6.0] },
  { k: "distanceKm", d: 2, label: "주행km", band: [5, 6] },
];

function main(): void {
  const combos: { label: string; ov: Record<string, unknown> }[] = process.env.HMB_COMBOS
    ? JSON.parse(process.env.HMB_COMBOS)
    : [{ label: "base 0.40.0", ov: {} }];
  console.log(`# e407 다양성 — 시드 ${SEEDS.length}(팀-경기 ${SEEDS.length * 2}), engine@${defaultEngineConfig.version}`);
  console.log("조합".padEnd(26) + COLS.map((c) => c.label.padStart(9)).join(""));
  for (const c of combos) {
    const t0 = Date.now();
    const m = runDiv(c.ov);
    console.log(
      c.label.padEnd(26) +
        COLS.map((col) => {
          const v = m[col.k];
          const flag = col.band ? (v < col.band[0] ? "-" : v > col.band[1] ? "+" : " ") : " ";
          return (v.toFixed(col.d) + flag).padStart(9);
        }).join("") +
        `  (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    );
    if (process.env.HMB_WIDE && lastRaw) console.log(roleDump(lastRaw) + "\n");
  }
}

main();
