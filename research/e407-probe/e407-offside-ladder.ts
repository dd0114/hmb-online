/**
 * #407 ⑦ Phase 2 — **오프사이드 호출 게이트 사다리**. 분석 전용, 프로덕션 무수정.
 *
 * `research/e407-offside.md` 가 확정한 진단: 판정 로직에 결함이 없고(FP 0 / 9,850 표본),
 * 밴드 이탈(오프사이드 0.33 vs 벤치 1–3)의 유일한 실효 레버는 `rules.offside.callProb` 이다.
 * 다만 그 리포트의 사다리는 **engine@0.40.0 · 8시드**에서 잰 값이라 그대로 못 쓴다 —
 * 그 뒤 N1/N4(0.41.0)가 사슬 결정을 바꿨고, 오프사이드는 저빈도 사건이라 8시드는 SE 가 크다.
 *
 * 그래서 여기서는 **현 트리에서 다시** 잰다:
 *  - rung 마다 `GUARD_SEEDS` n(기본 60)으로 오프사이드/팀-경기 + **부작용 전 지표**를 같이 찍는다.
 *  - 부작용 = 슛·골·유효슛·xG/슛·전환·패스성공·파울·코너·스로인·폭·주행
 *    + **파이널서드 진입** + **프리킥 이벤트** + **스루패스 생성/채택**(사슬 프로브).
 *    오프사이드 콜이 늘면 전진 패스가 프리킥으로 끊기므로 이 축들이 같이 움직인다.
 *
 * 각 rung 을 **끝나는 즉시 출력**한다(스톨로 앞 측정을 잃지 않게 — #407 규율).
 *
 * 실행:
 *   node tools/run-gate.mjs --label e407-ofs -- npx tsx research/e407-probe/e407-offside-ladder.ts
 * 환경변수: HMB_SEEDS(기본 60) · HMB_RUNGS(콤마 구분 callProb 값) · HMB_NO_PROBE=1(사슬 프로브 생략)
 */
import type { MatchLog, TeamSide } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config";
import { REALISM_SEEDS, GUARD_SEEDS } from "../../packages/engine/src/realism/harness";
import { runMatch } from "../../packages/engine/src/match";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures";
import { computeMatchStats } from "../../packages/engine/dev-viewer/match-stats";
import { newChainProbe, setChainProbe, type ChainProbe } from "../../packages/engine/src/action";

const N = Number(process.env.HMB_SEEDS || 60);
const SEEDS = N > 20 ? GUARD_SEEDS.slice(0, N) : REALISM_SEEDS.slice(0, N);
const RUNGS = (process.env.HMB_RUNGS || "0.013,0.03,0.045,0.06,0.08")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((v) => Number.isFinite(v));
const USE_PROBE = !process.env.HMB_NO_PROBE;

const GK_IDS = new Set(["H0", "A0"]);
const DEFENDER_IDS = new Set(["H1", "H2", "H3", "H4", "A1", "A2", "A3", "A4"]);
const select = makeSelectData();
const F3LINE = 0.66;

interface Row {
  callProb: number;
  teamMatches: number;
  offsides: number;
  offsidesSd: number;
  offsidesSe: number;
  shots: number;
  goals: number;
  onTarget: number;
  onTargetPct: number;
  xgPerShot: number;
  convPct: number;
  passSuccessPct: number;
  fouls: number;
  corners: number;
  throwIns: number;
  widthM: number;
  distanceKm: number;
  freeKicks: number;
  f3Entries: number;
  throughGen: number;
  throughPicked: number;
}

function cfgWith(callProb: number): EngineConfig {
  const c = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  c.rules.offside.callProb = callProb;
  return c;
}

/** 파이널서드 진입(상승 에지) — e407-diversity.ts 와 **같은 자**를 쓴다. */
function f3Entries(log: MatchLog, W: number): number {
  const prog = (side: TeamSide, x: number) => (side === "home" ? x : W - x);
  let cur: TeamSide | null = null;
  let prevF3 = false;
  let n = 0;
  for (const sn of log.tickSnapshots) {
    const owner = sn.ballOwner;
    const side = owner ? (owner.startsWith("H") ? "home" : "away") : cur;
    if (side !== cur) {
      cur = side;
      prevF3 = false;
    }
    if (!cur) continue;
    const now = prog(cur, sn.ball.x) / W >= F3LINE;
    if (now && !prevF3) n += 1;
    prevF3 = now;
  }
  return n;
}

function runRung(callProb: number): Row {
  const cfg = cfgWith(callProb);
  const acc = {
    offsides: [] as number[],
    shots: 0, goals: 0, onTarget: 0, onTargetPct: 0, conv: 0, pass: 0,
    fouls: 0, corners: 0, throwIns: 0, width: 0, km: 0,
    freeKicks: 0, f3: 0, xgSum: 0, shotEvents: 0,
  };
  const probe: ChainProbe | null = USE_PROBE ? newChainProbe() : null;
  if (probe) setChainProbe(probe);
  let teamMatches = 0;
  try {
    for (const seed of SEEDS) {
      const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
      const st = computeMatchStats(log, GK_IDS, {
        defenderIds: DEFENDER_IDS,
        pitchWidthM: cfg.pitch.width,
        finalThirdLine: cfg.setPiece.finalThirdLine,
      });
      for (const t of [st.home, st.away]) {
        acc.offsides.push(t.offsides);
        acc.shots += t.shots;
        acc.goals += t.goals;
        acc.onTarget += t.onTarget;
        acc.onTargetPct += t.shots ? (t.onTarget / t.shots) * 100 : 0;
        acc.conv += t.shots ? (t.goals / t.shots) * 100 : 0;
        acc.pass += t.passSuccessPct;
        acc.fouls += t.fouls;
        acc.corners += t.corners;
        acc.throwIns += t.throwIns;
        acc.width += t.avgWidthM;
        acc.km += t.avgDistanceKm;
        teamMatches += 1;
      }
      for (const e of log.events) {
        if (e.type === "free_kick") acc.freeKicks += 1;
        if (e.type === "shot" && e.detail !== "saved" && e.detail !== "off_target") {
          acc.shotEvents += 1;
          acc.xgSum += e.xg ?? 0;
        }
      }
      acc.f3 += f3Entries(log, cfg.pitch.width);
    }
  } finally {
    if (probe) setChainProbe(null);
  }
  const tm = teamMatches || 1;
  const m = acc.offsides.reduce((a, b) => a + b, 0) / tm;
  const sd = Math.sqrt(acc.offsides.reduce((a, b) => a + (b - m) ** 2, 0) / tm);
  return {
    callProb,
    teamMatches,
    offsides: m,
    offsidesSd: sd,
    offsidesSe: sd / Math.sqrt(tm),
    shots: acc.shots / tm,
    goals: acc.goals / tm,
    onTarget: acc.onTarget / tm,
    onTargetPct: acc.onTargetPct / tm,
    xgPerShot: acc.xgSum / (acc.shotEvents || 1),
    convPct: acc.conv / tm,
    passSuccessPct: acc.pass / tm,
    fouls: acc.fouls / tm,
    corners: acc.corners / tm,
    throwIns: acc.throwIns / tm,
    widthM: acc.width / tm,
    distanceKm: acc.km / tm,
    freeKicks: acc.freeKicks / tm,
    f3Entries: acc.f3 / tm,
    throughGen: probe ? probe.generated.through / tm : 0,
    throughPicked: probe ? probe.picked.through / tm : 0,
  };
}

const COLS: { k: keyof Row; d: number; label: string; band?: [number, number] }[] = [
  { k: "offsides", d: 3, label: "오프사이드", band: [1, 3] },
  { k: "offsidesSe", d: 3, label: "SE" },
  { k: "shots", d: 2, label: "슛", band: [7.2, 8.4] },
  { k: "goals", d: 2, label: "골", band: [1.4, 1.85] },
  { k: "onTarget", d: 2, label: "유효", band: [2.9, 3.5] },
  { k: "xgPerShot", d: 3, label: "xG/슛", band: [0.18, 0.24] },
  { k: "convPct", d: 1, label: "전환%", band: [17, 22] },
  { k: "passSuccessPct", d: 1, label: "패스%", band: [78, 85] },
  { k: "f3Entries", d: 2, label: "F3진입" },
  { k: "freeKicks", d: 2, label: "프리킥" },
  { k: "throughGen", d: 2, label: "스루생성" },
  { k: "throughPicked", d: 3, label: "스루채택" },
  { k: "fouls", d: 2, label: "파울", band: [5.5, 6.0] },
  { k: "corners", d: 2, label: "코너", band: [2.0, 3.0] },
  { k: "throwIns", d: 2, label: "스로인", band: [8.4, 9.4] },
  { k: "widthM", d: 1, label: "폭m", band: [40, 50] },
  { k: "distanceKm", d: 2, label: "주행km", band: [5, 6] },
];

function header(): string {
  return "callProb".padEnd(10) + COLS.map((c) => c.label.padStart(11)).join("");
}
function fmt(r: Row): string {
  return (
    r.callProb.toFixed(4).padEnd(10) +
    COLS.map((c) => {
      const v = r[c.k] as number;
      const flag = c.band ? (v < c.band[0] ? "-" : v > c.band[1] ? "+" : " ") : " ";
      return (v.toFixed(c.d) + flag).padStart(11);
    }).join("")
  );
}

function main(): void {
  console.log(
    `# e407 ⑦ 오프사이드 콜 사다리 — 시드 ${SEEDS.length}(팀-경기 ${SEEDS.length * 2}), engine@${defaultEngineConfig.version}`,
  );
  console.log(header());
  for (const cp of RUNGS) {
    const t0 = Date.now();
    const r = runRung(cp);
    console.log(fmt(r) + `  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}

main();
